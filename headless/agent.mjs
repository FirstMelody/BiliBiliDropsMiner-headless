import {chromium} from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {discoverTasks,signWbi,parseProgress,rewardIds,receiveBody,missionInfo,verifiedClaim} from './core.mjs';
import {refreshSession} from './refresh.mjs';
import {loadConfig,initialSession,redactor} from './settings.mjs';
import {privateDirectory,atomicJson} from './storage.mjs';
import {createNotifier} from './notify.mjs';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function runAgent(config,{once=false,importSession=false,configureContext=async()=>{}}={}) {
process.umask(0o077);
const dataDir=config.dataDir;
await privateDirectory(dataDir);
const redact=redactor(config);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let stopping=false;
let browser,context,home,activity,watch,nav,discoverAt=0,refreshAt=0;
let tasks=[],lastProgress=new Map(),stalledSince=0,watchStarted=0;
let lastMissionAt=0;
let state={room:config.roomId,phase:'starting',claims:{}};
let minerProcess,sessionGeneration='';
let session;
try {session=JSON.parse(await fs.readFile(path.join(dataDir,'session.json'),'utf8'));}
catch(e){if(e.code!=='ENOENT')throw Error('saved_session_unreadable');}
if(importSession||!session){
 session=initialSession(config);
 await atomicJson(path.join(dataDir,'session.json'),session);
}
try {state.claims=JSON.parse(await fs.readFile(path.join(dataDir,'status.json'),'utf8')).claims||{};}catch(e){if(e.code!=='ENOENT')throw Error('saved_status_unreadable');}
const safeError=e=>redact(e?.message||'unknown').split('\n')[0].slice(0,160);
const notify=await createNotifier(config.notifications,dataDir,(type,details={})=>console.log(new Date().toISOString(),type,JSON.stringify(details)));
async function save(){
 state.updatedAt=new Date().toISOString();state.pid=process.pid;
 await atomicJson(path.join(dataDir,'status.json'),state);
 await notify(state,state.miner);
}
async function event(type,details={}) {
 details=JSON.parse(redact(JSON.stringify(details)));
 await fs.appendFile(path.join(dataDir,'events-'+new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date())+'.jsonl'),JSON.stringify({at:new Date().toISOString(),type,...details})+'\n',{mode:0o600});
 console.log(new Date().toISOString(),type,JSON.stringify(details));
}
async function api(page,url,body,referrer){
 return page.evaluate(async({url,body,referrer})=>{
  const response=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(25000),
   ...(referrer?{referrer,referrerPolicy:'unsafe-url'}:{}),
   ...(body?{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)}:{})});
  if(!response.ok)throw Error('api_http_'+response.status);
  return response.json();
 },{url,body,referrer});
}
async function signed(page,endpoint,params={},body){
 const keys=nav?.data?.wbi_img;
 const mission=endpoint.includes('activity_components/mission/');
 const query=mission?{web_location:'888.126558',...params}:params;
 const referrer=mission?'https://www.bilibili.com/blackboard/era/award-exchange.html?task_id='+encodeURIComponent(params.task_id||body?.task_id||''):undefined;
 let result;
 for(const backoff of mission?[0,5000,15000]:[0]){
  if(mission)await sleep(Math.max(backoff,2500-(Date.now()-lastMissionAt)));
  const url='https://api.bilibili.com/'+endpoint+'?'+signWbi(query,[keys.img_url,keys.sub_url]);
  if(mission)lastMissionAt=Date.now();
  result=await api(page,url,body,referrer);
  if(![-702,-509].includes(result.code))break;
 }
 return result;
}
async function pageFor(prefix,url){
 const p=context.pages().find(p=>p.url().startsWith(prefix))||await context.newPage();
 if(!p.url().startsWith(prefix))await p.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
 return p;
}
async function connect(){
 if(browser?.isConnected() && home && !home.isClosed() && activity && !activity.isClosed())return;
 if(browser)await browser.close().catch(()=>{});
 browser=await chromium.launch({headless:true,channel:'chromium',...(config.browserExecutable?{executablePath:config.browserExecutable}:{})});
 context=await browser.newContext();
 session=JSON.parse(await fs.readFile(path.join(dataDir,'session.json'),'utf8'));
 await context.addCookies(session.cookies);
 await configureContext(context);
 home=await pageFor('https://www.bilibili.com/robots.txt','https://www.bilibili.com/robots.txt');
 await home.evaluate(({refreshToken,pendingConfirmation})=>{
  if(refreshToken)localStorage.setItem('ac_time_value',refreshToken);
  if(pendingConfirmation)localStorage.setItem('ow_drops_pending_confirm',pendingConfirmation);
 },{refreshToken:session.refreshToken,pendingConfirmation:session.pendingConfirmation});
 activity=await pageFor('https://live.bilibili.com/'+config.roomId,'https://live.bilibili.com/'+config.roomId);
 watch=context.pages().find(p=>p.url().startsWith('https://live.bilibili.com/blanc/'+config.roomId));
 discoverAt=0;refreshAt=0;
}
async function pauseActivity(){
 for(const frame of activity.frames())await frame.evaluate(()=>{for(const video of document.querySelectorAll('video')){video.muted=true;video.pause();}}).catch(()=>{});
}
async function persistSession(){
 const cookies=await context.cookies('https://www.bilibili.com','https://live.bilibili.com','https://passport.bilibili.com');
 const refresh=await home.evaluate(()=>({refreshToken:localStorage.getItem('ac_time_value'),pendingConfirmation:localStorage.getItem('ow_drops_pending_confirm')}));
 redact.add(cookies.map(c=>c.value));redact.add([refresh.refreshToken,refresh.pendingConfirmation]);
 await atomicJson(path.join(dataDir,'session.json'),{updatedAt:new Date().toISOString(),cookies,...refresh});
 sessionGeneration=createHash('sha256').update(cookies.filter(c=>['SESSDATA','bili_jct'].includes(c.name)).map(c=>c.value).join('|')).digest('hex');
}
async function discovery(){
 await activity.reload({waitUntil:'domcontentloaded',timeout:60000});await sleep(3500);await pauseActivity();
 const raw=await activity.evaluate(()=>window.__BILIACT_EVAPAGEDATA__||window.__initialState||{});
 const found=discoverTasks(raw);
 if(JSON.stringify(found)!==JSON.stringify(tasks))await event('campaign_changed',{title:await activity.title(),taskCount:found.length});
 tasks=found;state.campaign={title:await activity.title(),tasks};discoverAt=Date.now();
}
async function minerControl(run){
 const command={run,roomId:config.roomId,threadCount:4,updatedAt:Date.now(),sessionGeneration};
 const file=path.join(dataDir,'miner-control.json');
 await atomicJson(file,command);
 try{state.miner=JSON.parse(await fs.readFile(path.join(dataDir,'miner-status.json'),'utf8'));}catch{}
 if(!run)return;
 if(minerProcess?.exitCode===null)return;
 if(state.miner && Date.now()/1000-state.miner.updatedAt<20)return;
 const handle=await fs.open(path.join(dataDir,'miner.log'),'a');
 minerProcess=spawn(config.pythonExecutable,[path.join(root,'headless/miner_bridge.py'),'--data-dir',dataDir],{cwd:root,stdio:['ignore',handle.fd,handle.fd],env:{...process.env,PYTHONPATH:root,PYTHONUNBUFFERED:'1'}});
 minerProcess.on('error',()=>{handle.close().catch(()=>{});minerProcess=undefined;state.attention={reason:'miner_launch_failed'};});
 minerProcess.on('exit',async code=>{await handle.close().catch(()=>{});await event('miner_process_exit',{code});});
 await event('miner_started',{threads:4});
}
async function stopWatch(){if(watch && !watch.isClosed())await watch.close();watch=null;state.player=null;watchStarted=0;stalledSince=0;await minerControl(false);}
async function ensureWatch(){
 if(watch&&!watch.isClosed())await watch.close();watch=null;
 await pauseActivity();await persistSession();await minerControl(true);
 if(!watchStarted){watchStarted=Date.now();stalledSince=Date.now();}
 state.player=null;
}
async function officialFallback(info){
 const prefix='https://www.bilibili.com/blackboard/era/award-exchange.html';
 const p=context.pages().find(x=>x.url().startsWith(prefix))||await context.newPage();
 await p.goto(prefix+'?task_id='+encodeURIComponent(info.task_id),{waitUntil:'domcontentloaded',timeout:60000});
 await sleep(3000);
 const button=p.locator('.exchange-button:not(.disable)').first();
 const textButton=p.getByText(info.message||'立即领取',{exact:true}).first();
 if(await button.isVisible().catch(()=>false))await button.click();
 else if(await textButton.isVisible().catch(()=>false))await textButton.click();
 await sleep(10000);
 // Headless cannot complete an interactive captcha; report attention and back off.
 state.attention={reason:'official_claim_verification',task:info.task_id};
 await event('official_claim_page',{task:info.task_id});
}
async function cycle(){
 await connect();
 nav=await api(home,'https://api.bilibili.com/x/web-interface/nav');
 state.loggedIn=nav.code===0&&nav.data?.isLogin===true;
 if(!state.loggedIn){state.phase='login_required';await stopWatch();return;}
 if(Date.now()-refreshAt>config.refreshIntervalMs){
  state.session=await refreshSession(home,persistSession);refreshAt=Date.now();
  await persistSession();
  if(state.session.state==='login_required'){state.phase='login_required';await stopWatch();return;}
  if(['refreshed','refresh_token_missing'].includes(state.session.state))await event('session_refresh',{state:state.session.state});
  nav=await api(home,'https://api.bilibili.com/x/web-interface/nav');
 }
 if(Date.now()-discoverAt>config.discoveryIntervalMs)await discovery();
 if(!tasks.length){state.phase='monitoring_no_campaign';await stopWatch();return;}
 const csrf=(await context.cookies('https://www.bilibili.com')).find(c=>c.name==='bili_jct')?.value;
 if(!csrf)throw Error('csrf_cookie_missing');
 const payload=await signed(home,'x/task/totalv2',{csrf,task_ids:tasks.map(t=>t.id).join(','),web_location:'0.0'});
 const progress=parseProgress(payload);state.progress=progress;
 // Reject partial API responses rather than trusting stale embedded page values.
 if(!tasks.every(t=>progress.some(p=>p.id===t.id)))throw Error('progress_tasks_missing');
 const room=await api(activity,'https://api.live.bilibili.com/room/v1/Room/room_init?id='+config.roomId);
 if(room.code!==0)throw Error('room_info_code_'+room.code);
 state.live=room.data.live_status===1;
 const unfinished=progress.some(p=>p.status!==6 && (p.target>0&&p.current<p.target));
 if(state.live&&unfinished){state.phase='watching';await ensureWatch();}else{await stopWatch();state.phase=state.live?'checking_rewards':'monitoring_offline';}
 const ids=rewardIds(tasks,progress);
 for(const id of ids){
  const previous=state.claims[id];
  const getInfo=()=>signed(home,'x/activity_components/mission/info',{task_id:id});
  const info=missionInfo(await getInfo());
  if(info.status===6){state.claims[id]={state:'claimed',confirmedAt:previous?.confirmedAt||new Date().toISOString()};if(state.attention?.task===id)delete state.attention;continue;}
  // Previously confirmed recurring tasks can reset; always check the server.
  if(info.status!==0){state.claims[id]={state:'ineligible',status:info.status,message:info.message};await sleep(1500);continue;}
  if(previous?.retryAt && Date.now()<previous.retryAt)continue;
  const result=await verifiedClaim({getInfo,receive:d=>signed(home,'x/activity_components/mission/receive',{},receiveBody(d,csrf)),officialFallback,wait:sleep});
  state.claims[id]={...result,at:new Date().toISOString(),...(result.state==='claimed'?{confirmedAt:new Date().toISOString()}:{retryAt:Date.now()+(result.state==='needs_attention'?1800000:300000)})};
  if(result.state==='claimed'&&state.attention?.task===id)delete state.attention;
  await event('claim_result',{task:id,...result});await save();await sleep(1500);
 }
 if(ids.length&&ids.every(id=>state.claims[id]?.state==='claimed')){
  await stopWatch();state.phase='checking_rewards';
 }
 if(state.phase==='watching'){
  const changed=progress.some(p=>p.current>(lastProgress.get(p.id)??p.current));
  if(changed)stalledSince=Date.now();
  if(stalledSince&&Date.now()-stalledSince>config.stallIntervalMs){
   state.attention={reason:'watch_progress_stalled',since:new Date(stalledSince).toISOString()};
   await event('watch_progress_stalled');await minerControl(false);await sleep(10000);await minerControl(true);stalledSince=Date.now();
  }
 }
 lastProgress=new Map(progress.map(p=>[p.id,p.current]));
 await persistSession();delete state.error;
}
const stop=()=>{stopping=true;};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
 if(once){await cycle();await save();}
 else while(!stopping){
  try{await cycle();}catch(e){state.phase='retrying';state.error=safeError(e);await event('cycle_error',{error:state.error});}
  await save();
  for(let elapsed=0;elapsed<config.pollIntervalMs&&!stopping;elapsed+=1000)await sleep(1000);
 }
} finally {
 await minerControl(false);
 await browser?.close().catch(()=>{});
 if(minerProcess?.exitCode===null){
  minerProcess.kill('SIGTERM');
  await Promise.race([new Promise(r=>minerProcess.once('exit',r)),sleep(10000)]);
  if(minerProcess.exitCode===null)minerProcess.kill('SIGKILL');
 }
 process.off('SIGINT',stop);process.off('SIGTERM',stop);
}
return state;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 const args=process.argv.slice(2),index=args.indexOf('--config');
 const filename=index>=0?args[index+1]:path.join(root,'headless/config.json');
 try{
  if(!filename)throw Error('config_path_required');
  const config=await loadConfig(filename);
  if(args.includes('--check')){
   let saved=false;try{await fs.access(path.join(config.dataDir,'session.json'));saved=true;}catch{}
   if(!saved||args.includes('--import-session'))initialSession(config);
   console.log('Configuration valid; credentials are not displayed.');
  }else await runAgent(config,{once:args.includes('--once'),importSession:args.includes('--import-session')});
 }catch(e){
  // No stack or request arguments: launch errors can include proxy URLs or secrets.
  const code=String(e?.message||'startup_failed');
  console.error(/^(?:config_|saved_|notification_state_)[a-zA-Z0-9_]+$/.test(code)?code:'agent_failed_check_private_status');
  process.exitCode=1;
 }
}
