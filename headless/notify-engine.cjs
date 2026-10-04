'use strict';
const crypto=require('node:crypto');
function inspect(snapshot,memory,now=Date.now()){
 memory.issues||={};memory.completed||={};
 const current=new Map();
 const remote=snapshot?.state;
 const fresh=remote && now-Date.parse(remote.updatedAt)<240000;
 if(!remote)current.set('remote_unreachable',{delay:3,text:'无法读取掉宝状态，已连续检查失败。请检查服务运行情况。'});
 else if(!fresh)current.set('supervisor_stopped',{delay:1,text:'掉宝守护器超过 4 分钟未更新，可能已经停止。'});
 else {
  if(remote.phase==='login_required')current.set('login_required',{delay:1,text:'B 站登录已失效，挂机已暂停。请更新配置中的 Cookie 和 refreshToken，并以 --import-session 启动。'});
  if(remote.phase==='retrying')current.set('runtime_error',{delay:2,text:'掉宝守护器持续出现异常，正在自动重试：'+String(remote.error||'未知异常').slice(0,120)});
  if(remote.session?.state==='refresh_token_missing')current.set('refresh_token_missing',{delay:1,text:'B 站刷新口令缺失，请提供同次登录的 ac_time_value 以恢复自动续期。'});
  const needsVerification=Object.values(remote.claims||{}).some(c=>c.state==='needs_attention');
  if(needsVerification || remote.attention?.reason==='official_claim_verification')current.set('claim_verification',{delay:1,text:'奖励领取需要人工验证。请在可交互浏览器中使用同一账号打开官方领奖页面；headless 无法代替人完成验证。'});
  const pending=Object.values(remote.claims||{}).filter(c=>['pending_confirmation','retry_later'].includes(c.state));
  if(pending.length)current.set('claim_failed',{delay:pending.some(c=>now-Date.parse(c.at)>300000)?1:6,text:'部分已达标奖励超过 5 分钟仍未确认领取，程序正在退避重试。'});
  if(remote.phase==='watching'){
   const miner=snapshot.miner;
   if(!miner || !miner.running || miner.activeSessions!==4 || now/1000-miner.updatedAt>30)current.set('miner_unhealthy',{delay:2,text:'掉宝 miner 未维持 4 个活跃会话，程序正在尝试恢复。'});
   const progress=Math.max(0,...(remote.progress||[]).map(p=>Number(p.current)||0));
   if(memory.progress!==progress || memory.wasWatching!==true){memory.progress=progress;memory.progressChangedAt=now;}
   if(now-(memory.progressChangedAt||now)>900000)current.set('progress_stalled',{delay:1,text:'直播观看进度已超过 15 分钟没有增长，请检查账号限制或挂机连接。'});
   memory.wasWatching=true;
  }else memory.wasWatching=false;
 }
 const messages=[];
 for(const [key,problem] of current){
  const incident=memory.issues[key] ||= {count:0,since:now,sent:false};
  incident.count++;
  if(!incident.sent && incident.count>=problem.delay)messages.push({id:'issue:'+key+':'+incident.since,type:'issue',key,text:'【守望先锋掉宝异常】\n'+problem.text});
 }
 for(const [key,incident] of Object.entries(memory.issues)){
  if(current.has(key))continue;
  // A failed health check cannot establish that an earlier incident recovered.
  if(!fresh && !(key==='remote_unreachable' && remote))continue;
  if(incident.sent)messages.push({id:'recovery:'+key+':'+incident.since,type:'recovery',key,text:'【守望先锋掉宝恢复】\n此前的异常已恢复，自动监控继续运行。'});
  else delete memory.issues[key];
 }
 if(fresh && !remote.error && remote.phase!=='retrying'){
  const tasks=remote.campaign?.tasks||[];
  const ids=tasks.flatMap(t=>{
   const p=(remote.progress||[]).find(p=>p.id===t.id);
   return p?.points?.some(p=>p.id)?p.points.filter(p=>p.id).map(p=>p.id):[t.id];
  });
  if(ids.length && ids.every(id=>remote.claims?.[id]?.state==='claimed')){
   const campaign=crypto.createHash('sha256').update([...new Set(ids)].sort().join(',')).digest('hex');
   if(!memory.completed[campaign]){
    const awards=tasks.map(t=>t.award||t.name).filter(Boolean);
    const last=Object.values(remote.claims).map(c=>Date.parse(c.confirmedAt)||0).reduce((a,b)=>Math.max(a,b),0);
    const time=last?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour12:false,dateStyle:'short',timeStyle:'medium'}).format(new Date(last)):'';
    messages.push({id:'complete:'+campaign,type:'complete',key:campaign,text:'【守望先锋掉宝全部完成】\n'+(remote.campaign.title||'当前活动')+'\n'+tasks.length+' 项奖励已全部领取并经平台回查确认。\n'+awards.join('、')+'\n完成时间：'+time+'（北京时间）\n挂机已停止，将继续监控下一次掉宝活动。'});
   }
  }
 }
 return messages;
}
function acknowledge(memory,message){
 if(message.type==='issue')memory.issues[message.key].sent=true;
 if(message.type==='recovery')delete memory.issues[message.key];
 if(message.type==='complete')memory.completed[message.key]=Date.now();
}
module.exports={inspect,acknowledge};
