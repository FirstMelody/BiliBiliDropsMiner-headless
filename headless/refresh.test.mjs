import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {refreshSession} from './refresh.mjs';
function mock({needsRefresh=true,token='old-token',pending=null,confirmFails=false,loggedOut=false}={}){
 const values=new Map();if(token)values.set('ac_time_value',token);if(pending)values.set('ow_drops_pending_confirm',pending);
 const calls=[];const document={cookie:'bili_jct=old-csrf'};
 const sandbox={crypto:webcrypto,TextEncoder,Uint8Array,URLSearchParams,AbortSignal,document,
  localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},
  DOMParser:class{parseFromString(){return {getElementById:()=>({textContent:'refresh-csrf'})}}},
  fetch:async(url,opts={})=>{
   const body=Object.fromEntries(opts.body||[]);calls.push({url,body});
   let payload;
   if(url.includes('cookie/info'))payload={code:loggedOut?-101:0,data:{refresh:needsRefresh,timestamp:1702204169000}};
   else if(url.includes('/correspond/'))return {ok:true,text:async()=>'<div id="1-name">refresh-csrf</div>'};
   else if(url.includes('cookie/refresh')){document.cookie='bili_jct=new-csrf';payload={code:0,data:{refresh_token:'new-token'}};}
   else if(url.includes('confirm/refresh')){assert.equal(values.get('ac_time_value'),pending?'old-token':'new-token');payload={code:confirmFails?-504:0};}
   else assert.fail('unexpected refresh endpoint');
   return {ok:true,json:async()=>payload};
  }};
 return {values,calls,checkpoint:async()=>{calls.push({url:'disk-checkpoint',body:{}})},home:{evaluate:fn=>vm.runInNewContext('('+fn.toString()+')()',sandbox)}};
}
test('valid session only checks expiry',async()=>{
 const m=mock({needsRefresh:false});const r=await refreshSession(m.home,m.checkpoint);assert.equal(r.state,'valid');assert.equal(m.calls.filter(x=>x.url!=='disk-checkpoint').length,1);
});
test('refresh saves new token then confirms with old token and new csrf',async()=>{
 const m=mock();const r=await refreshSession(m.home,m.checkpoint);assert.equal(r.state,'refreshed');
 assert.equal(m.values.get('ac_time_value'),'new-token');assert.equal(m.values.has('ow_drops_pending_confirm'),false);
 const confirm=m.calls.find(x=>x.url.includes('confirm/refresh'));assert.equal(confirm.body.refresh_token,'old-token');assert.equal(confirm.body.csrf,'new-csrf');
});
test('failed confirmation preserves recovery journal and new token',async()=>{
 const m=mock({confirmFails:true});await assert.rejects(()=>refreshSession(m.home,m.checkpoint),/refresh_confirm/);
 assert.equal(m.values.get('ac_time_value'),'new-token');assert.equal(m.values.get('ow_drops_pending_confirm'),'old-token');
});
test('pending confirmation resumes before checking expiry',async()=>{
 const m=mock({needsRefresh:false,pending:'previous-token'});await refreshSession(m.home,m.checkpoint);
 assert.equal(m.calls[0].body.refresh_token,'previous-token');assert.equal(m.values.has('ow_drops_pending_confirm'),false);
});
test('missing refresh token does not attempt rotation',async()=>{
 const m=mock({token:null});const r=await refreshSession(m.home,m.checkpoint);assert.equal(r.state,'refresh_token_missing');assert.equal(m.calls.filter(x=>x.url!=='disk-checkpoint').length,1);
});
test('expired login requires SMS rather than false refresh success',async()=>{
 const m=mock({loggedOut:true});const r=await refreshSession(m.home,m.checkpoint);assert.equal(r.state,'login_required');
});
test('disk checkpoint happens before confirming and invalidating old credentials',async()=>{
 const m=mock();await refreshSession(m.home,m.checkpoint);
 const checkpoint=m.calls.findIndex(c=>c.url==='disk-checkpoint');
 const confirm=m.calls.findIndex(c=>c.url.includes('confirm/refresh'));
 assert.ok(checkpoint>=0&&checkpoint<confirm);
});
test('failed disk write does not confirm the rotation',async()=>{
 const m=mock();await assert.rejects(()=>refreshSession(m.home,async()=>{throw Error('disk_full')}),/disk_full/);
 assert.equal(m.calls.some(c=>c.url.includes('confirm/refresh')),false);
 assert.equal(m.values.get('ow_drops_pending_confirm'),'old-token');
});
test('checkpoint contains newly rotated token and pending old token',async()=>{
 const m=mock();let snapshot;
 await refreshSession(m.home,async()=>{snapshot??=Object.fromEntries(m.values);});
 assert.equal(snapshot.ac_time_value,'new-token');assert.equal(snapshot.ow_drops_pending_confirm,'old-token');
});
