import test from 'node:test';
import assert from 'node:assert/strict';
import engine from './notify-engine.cjs';
const {inspect,acknowledge}=engine;
const now=Date.parse('2026-10-04T13:00:00Z');
function snapshot({complete=false,phase='watching',error=null}={}){
 return {state:{updatedAt:new Date(now).toISOString(),phase,error,campaign:{title:'OWCS',tasks:[{id:'a',award:'太阳茶头像'}]},claims:{a:{state:complete?'claimed':'ineligible',confirmedAt:new Date(now).toISOString()}},progress:[{id:'a',current:complete?60:30,target:60}]},miner:{running:true,activeSessions:4,updatedAt:now/1000}};
}
test('healthy ongoing work stays quiet',()=>assert.equal(inspect(snapshot(),{},now).length,0));
test('completion sends once and persists across restart',()=>{
 const m={};let messages=inspect(snapshot({complete:true}),m,now);assert.equal(messages.length,1);assert.equal(messages[0].type,'complete');acknowledge(m,messages[0]);
 assert.equal(inspect(snapshot({complete:true}),JSON.parse(JSON.stringify(m)),now+1000).length,0);
});
test('full progress without confirmed claims does not send completion',()=>{
 const s=snapshot();s.state.progress[0].current=60;assert.equal(inspect(s,{},now).length,0);
});
test('stale all-claimed snapshot never sends completion',()=>{
 const s=snapshot({complete:true});s.state.updatedAt=new Date(now-300000).toISOString();const messages=inspect(s,{},now);assert.equal(messages.some(m=>m.type==='complete'),false);
});
test('remote outage waits for three checks and deduplicates',()=>{
 const m={};assert.equal(inspect(null,m,now).length,0);assert.equal(inspect(null,m,now+60000).length,0);const messages=inspect(null,m,now+120000);assert.equal(messages.length,1);acknowledge(m,messages[0]);assert.equal(inspect(null,m,now+180000).length,0);
});
test('login expiry alerts immediately and recovery sends once',()=>{
 const m={};const alert=inspect(snapshot({phase:'login_required'}),m,now)[0];assert.equal(alert.key,'login_required');acknowledge(m,alert);const recovery=inspect(snapshot(),m,now+1000)[0];assert.equal(recovery.type,'recovery');acknowledge(m,recovery);assert.equal(inspect(snapshot(),m,now+2000).length,0);
});
test('failed delivery remains pending for retry',()=>{
 const m={};const first=inspect(snapshot({complete:true}),m,now)[0];const retry=inspect(snapshot({complete:true}),m,now+1000)[0];assert.equal(first.id,retry.id);
});
test('new campaign produces a new completion event',()=>{
 const m={},first=inspect(snapshot({complete:true}),m,now)[0];acknowledge(m,first);
 const s=snapshot({complete:true});s.state.campaign.tasks=[{id:'b',award:'新奖励'}];s.state.claims={b:{state:'claimed'}};s.state.progress=[{id:'b',current:60,target:60}];assert.equal(inspect(s,m,now+1000)[0].type,'complete');
});
test('sustained process error alerts after two samples',()=>{
 const s=snapshot({phase:'retrying',error:'api_http_412'}),m={};assert.equal(inspect(s,m,now).length,0);assert.equal(inspect(s,m,now+1000)[0].key,'runtime_error');
});
test('manual claim verification triggers an alert',()=>{
 const s=snapshot();s.state.claims.a={state:'needs_attention'};assert.equal(inspect(s,{},now)[0].key,'claim_verification');
});
test('an outage cannot falsely resolve a previously reported login problem',()=>{
 const m={};acknowledge(m,inspect(snapshot({phase:'login_required'}),m,now)[0]);
 assert.equal(inspect(null,m,now+1000).some(x=>x.type==='recovery'),false);
 const stale=snapshot();stale.state.updatedAt=new Date(now-300000).toISOString();
 assert.equal(inspect(stale,m,now+2000).some(x=>x.key==='login_required'&&x.type==='recovery'),false);
});
test('retries that renew claim timestamps still produce a failure alert',()=>{
 const m={};let messages;
 for(let i=0;i<6;i++){
  const s=snapshot();s.state.updatedAt=new Date(now+i*60000).toISOString();s.state.phase='checking_rewards';
  s.state.claims.a={state:'retry_later',at:new Date(now+i*60000).toISOString()};
  messages=inspect(s,m,now+i*60000);
  if(i<5)assert.equal(messages.length,0);
 }
 assert.equal(messages[0].key,'claim_failed');
});
test('missing miner sessions alert after two checks',()=>{
 const m={},s=snapshot();s.miner.activeSessions=2;
 assert.equal(inspect(s,m,now).length,0);assert.equal(inspect(s,m,now+1000)[0].key,'miner_unhealthy');
});
test('sustained missing progress alerts while fresh checks continue',()=>{
 const m={};inspect(snapshot(),m,now);
 const s=snapshot();s.state.updatedAt=new Date(now+901000).toISOString();s.miner.updatedAt=(now+901000)/1000;
 assert.equal(inspect(s,m,now+901000)[0].key,'progress_stalled');
});
