import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runAgent} from '../agent.mjs';
import {discoverTasks} from '../core.mjs';
import {parseCampaign} from '../discovery.mjs';

const fixture=JSON.parse(await fs.readFile(new URL('../fixtures/owcs-s3.json',import.meta.url),'utf8'));
const img_url='https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png';
const sub_url='https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png';

async function setup(t,{rotate=false,claim=false,deferred=false,failFirstConfirm=false}={}) {
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-drops-browser-'));
 t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
 const data=structuredClone(fixture);
 if(claim)data[0].props.tasklist=data[0].props.tasklist.slice(0,1);
 const tasks=discoverTasks(data);
 let claimed=!claim,received=0,confirmed=0;
 const config={roomId:23612045,dataDir,pythonExecutable:'python3',cookie:'SESSDATA=synthetic-session; bili_jct=synthetic-csrf',refreshToken:'synthetic-refresh',pollIntervalMs:60000,discoveryIntervalMs:600000,refreshIntervalMs:86400000,stallIntervalMs:900000,notifications:{enabled:false}};
 const configureContext=async context=>context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  const json=payload=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
  if(url.pathname==='/robots.txt')return route.fulfill({contentType:'text/html',body:'<html><title>home</title></html>'});
  assert.notEqual(url.hostname,'live.bilibili.com','No live room page or player should be opened');
  if(url.pathname==='/x/web-interface/nav')return json({code:0,data:{isLogin:true,wbi_img:{img_url,sub_url}}});
  if(url.pathname.endsWith('/cookie/info'))return json({code:0,data:{refresh:rotate,timestamp:1702204169000}});
  if(url.pathname.startsWith('/correspond/1/'))return route.fulfill({contentType:'text/html',body:'<div id="1-name">synthetic-refresh-csrf</div>'});
  if(url.pathname.endsWith('/cookie/refresh')){
   const body=new URLSearchParams(request.postData());assert.equal(body.get('refresh_token'),'synthetic-refresh');
   await context.addCookies([{name:'SESSDATA',value:'synthetic-rotated-session',domain:'.bilibili.com',path:'/',httpOnly:true,secure:true},{name:'bili_jct',value:'synthetic-rotated-csrf',domain:'.bilibili.com',path:'/',secure:true}]);
   return json({code:0,data:{refresh_token:'synthetic-rotated-refresh'}});
  }
  if(url.pathname.endsWith('/confirm/refresh')){
   const session=JSON.parse(await fs.readFile(path.join(dataDir,'session.json'),'utf8'));
   assert.equal(session.refreshToken,'synthetic-rotated-refresh');assert.equal(session.pendingConfirmation,'synthetic-refresh');
   const body=new URLSearchParams(request.postData());assert.equal(body.get('csrf'),'synthetic-rotated-csrf');assert.equal(body.get('refresh_token'),'synthetic-refresh');
   confirmed++;
   if(failFirstConfirm&&confirmed===1)return json({code:-504});
   rotate=false;return json({code:0});
  }
  // Already claimed tasks can report stale/reset counters: they must not restart miner.
  if(url.pathname==='/x/task/totalv2')return json({code:0,data:tasks.map(t=>({task_id:t.id,task_status:3,indicators:[{cur_value:claim?600:0,limit:600}]}))});
  if(url.pathname==='/room/v1/Room/room_init')return json({code:0,data:{live_status:1}});
  if(url.pathname==='/x/activity_components/mission/info'){
   assert.equal(url.searchParams.get('web_location'),'888.126558');assert.ok(url.searchParams.has('w_rid'));
   assert.ok(request.headers().referer.includes('award-exchange.html?task_id='));
   return json({code:0,data:{task_id:url.searchParams.get('task_id'),status:claimed?6:0,act_id:1,act_name:'OWCS',task_name:'watch',reward_info:{award_name:'reward'}}});
  }
  if(url.pathname==='/x/activity_components/mission/receive'){
   received++;assert.equal(request.method(),'POST');
   const body=new URLSearchParams(request.postData());assert.equal(body.get('csrf'),'synthetic-csrf');assert.equal(body.get('receive_from'),'missionPage');
   claimed=true;return json({code:0});
  }
  // The fixture must never access an actual Bilibili account or external API.
  await route.abort();assert.fail('unhandled mocked endpoint: '+url.pathname);
 });
 const execute=()=>runAgent(config,{once:true,configureContext,discoverCampaign:async()=>parseCampaign('<title>OWCS fixture</title><script>window.__BILIACT_EVAPAGEDATA__='+JSON.stringify(data)+'</script>')});
 if(deferred)return {execute,dataDir,tasks};
 const state=await execute();
 return {state,dataDir,received,confirmed,tasks};
}

test('headless Chromium rotates and durably saves cookie before confirmation, then stops after all awards',async t=>{
 assert.equal(process.env.DISPLAY,undefined,'Run with env -u DISPLAY');
 const result=await setup(t,{rotate:true});
 assert.equal(result.confirmed,1);assert.equal(result.state.session.state,'refreshed');assert.equal(result.state.phase,'monitoring_completed');
 assert.equal(result.tasks.length,6);assert.ok(result.tasks.every(t=>result.state.claims[t.id].state==='claimed'));
 const session=JSON.parse(await fs.readFile(path.join(result.dataDir,'session.json'),'utf8'));
 assert.equal(session.refreshToken,'synthetic-rotated-refresh');assert.equal(session.pendingConfirmation,null);
 assert.equal(session.cookies.find(c=>c.name==='SESSDATA').value,'synthetic-rotated-session');
 const control=JSON.parse(await fs.readFile(path.join(result.dataDir,'miner-control.json'),'utf8'));
 assert.equal(control.run,false);assert.equal(control.threadCount,4);
});
test('headless claim submits once and verifies the platform status afterward',async t=>{
 const result=await setup(t,{claim:true});assert.equal(result.received,1);
 assert.equal(result.state.claims[result.tasks[0].id].state,'claimed');
 assert.equal(result.state.claims[result.tasks[0].id].code,0);
 const events=(await fs.readdir(result.dataDir)).filter(n=>n.startsWith('events-'));
 const log=await fs.readFile(path.join(result.dataDir,events[0]),'utf8');
 assert.ok(!log.includes('synthetic-session')&&!log.includes('synthetic-refresh'));
});
test('restart restores newly rotated credentials and resumes failed confirmation without reimporting old config',async t=>{
 const prepared=await setup(t,{rotate:true,deferred:true,failFirstConfirm:true});
 await assert.rejects(prepared.execute,/refresh_confirm_-504/);
 const pending=JSON.parse(await fs.readFile(path.join(prepared.dataDir,'session.json'),'utf8'));
 assert.equal(pending.refreshToken,'synthetic-rotated-refresh');assert.equal(pending.pendingConfirmation,'synthetic-refresh');
 const state=await prepared.execute();assert.equal(state.session.state,'valid');assert.equal(state.phase,'monitoring_completed');
 const restored=JSON.parse(await fs.readFile(path.join(prepared.dataDir,'session.json'),'utf8'));
 assert.equal(restored.refreshToken,'synthetic-rotated-refresh');assert.equal(restored.pendingConfirmation,null);
});
