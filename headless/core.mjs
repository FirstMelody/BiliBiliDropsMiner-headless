import {createHash} from 'node:crypto';

// Task components, checkpoint IDs, WBI signing and mission body follow
// mi0e/BiliBiliDropsMiner at 0200d60 (MIT). Requests run in the real browser.
export function discoverTasks(data) {
 const tasks=new Map();
 function visit(v) {
  if(!v||typeof v!=='object')return;
  if(v.name==='EraTasklistPc')for(const t of v.props?.tasklist||[]){
   if(t.taskId && /观看|watch/i.test(t.taskName||''))tasks.set(t.taskId,{id:t.taskId,name:t.taskName,award:t.awardName});
  }
  for(const value of Object.values(v))visit(value);
 }
 visit(data);
 return [...tasks.values()];
}
const table=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
export function signWbi(params,images,timestamp=Math.floor(Date.now()/1000)) {
 const key=images.map(x=>new URL(x).pathname.split('/').pop().split('.')[0]).join('');
 const mix=table.map(x=>key[x]).join('').slice(0,32);
 if(mix.length!==32)throw Error('WBI keys unavailable');
 const p={...params,wts:timestamp};
 const query=Object.keys(p).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(p[k]).replace(/[!'()*]/g,''))).join('&');
 return query+'&w_rid='+createHash('md5').update(query+mix).digest('hex');
}
export function parseProgress(payload) {
 if(payload.code!==0)throw Error('task_progress_code_'+payload.code);
 const data=payload.data;
 const list=Array.isArray(data)?data:data?.list||data?.tasks||[];
 return list.map(t=>{
  const indicators=Array.isArray(t.indicators)?t.indicators:[];
  const indicator=[...indicators].sort((a,b)=>Number(b.limit)-Number(a.limit))[0]||{};
  const points=t.check_points||t.accumulative_check_points||[];
  return {id:String(t.task_id||t.sid||t.id||''),name:t.task_name||t.name,status:t.task_status??t.status,
   current:Number(indicator.cur_value??t.cur_value??0),target:Number(indicator.limit??t.limit??0),
   points:(Array.isArray(points)?points:[]).map(p=>({id:String(p.sid||p.task_id||p.ztasksid||p.id||''),status:p.status}))};
 });
}
export function rewardIds(tasks,progress) {
 const byId=new Map(progress.map(t=>[t.id,t]));
 return [...new Set(tasks.flatMap(t=>{
  const points=byId.get(t.id)?.points?.filter(p=>p.id)||[];
  return points.length?points.map(p=>p.id):[t.id];
 }))];
}
export function missionInfo(payload) {
 if(payload.code!==0)throw Error('mission_info_code_'+payload.code);
 const d=payload.data;
 if(!d||!Number.isInteger(d.status))throw Error('mission_status_missing');
 return d;
}
export function receiveBody(d,csrf) {
 return {task_id:d.task_id,activity_id:d.act_id,activity_name:d.act_name,task_name:d.task_name,
  reward_name:d.reward_info?.award_name||'',gaia_vtoken:'',receive_from:'missionPage',csrf,csrf_token:csrf};
}
export async function verifiedClaim({getInfo,receive,officialFallback,wait}) {
 const before=missionInfo(await getInfo());
 if(before.status===6)return {state:'claimed',already:true};
 if(before.status!==0)return {state:'ineligible',status:before.status,message:before.message};
 let result;
 try {result=await receive(before);}catch {result={code:'transport_unknown'};}
 // Always re-read after a POST, including a timeout: a server may have committed.
 for(const delay of [1500,4000,8000]){
  await wait(delay);
  const after=missionInfo(await getInfo());
  if(after.status===6)return {state:'claimed',already:false,code:result.code};
  if(result.code!==0)break;
 }
 if([202100,202101,202102,-352,-412].includes(Number(result.code))){
  await officialFallback(before);
  const after=missionInfo(await getInfo());
  if(after.status===6)return {state:'claimed',already:false,via:'official_page'};
  return {state:'needs_attention',code:result.code,status:after.status};
 }
 return {state:result.code===0?'pending_confirmation':'retry_later',code:result.code};
}
