import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {discoverTasks,missionInfo,verifiedClaim,rewardIds,signWbi} from './core.mjs';
const info=status=>({code:0,data:{task_id:'child',status}});
const wait=async()=>{};
test('current official OWCS S3 page has six watch tasks',()=>{
 const data=JSON.parse(fs.readFileSync(new URL('./fixtures/owcs-s3.json',import.meta.url)));
 assert.equal(discoverTasks(data).length,6);
 assert.equal(discoverTasks(data)[0].id,'6ERAcwloghvp4i00');
});
test('missing mission status is not claimable',()=>assert.throws(()=>missionInfo({code:0,data:{}})));
test('aggregate tasks expand to deduplicated checkpoint IDs',()=>assert.deepEqual(rewardIds([{id:'parent'},{id:'parent'}],[{id:'parent',points:[{id:'child'}]}]),['child']));
test('HTTP success without changed reward state remains pending',async()=>{
 const r=await verifiedClaim({getInfo:async()=>info(0),receive:async()=>({code:0}),wait});
 assert.equal(r.state,'pending_confirmation');
});
test('delayed claim confirmation succeeds after re-read',async()=>{
 let n=0;const r=await verifiedClaim({getInfo:async()=>info(++n>=3?6:0),receive:async()=>({code:0}),wait});
 assert.equal(r.state,'claimed');assert.equal(n,3);
});
test('POST timeout that already committed never retries the POST',async()=>{
 let n=0,posts=0;const r=await verifiedClaim({getInfo:async()=>info(++n===1?0:6),receive:async()=>{posts++;throw Error('timeout')},wait});
 assert.equal(r.state,'claimed');assert.equal(posts,1);
});
test('risk challenge uses official page and verifies again',async()=>{
 let status=0,calls=0;const r=await verifiedClaim({getInfo:async()=>info(status),receive:async()=>({code:202100}),officialFallback:async()=>{calls++;status=6},wait});
 assert.equal(r.state,'claimed');assert.equal(calls,1);
});
test('unresolved captcha is never reported as claimed',async()=>{
 const r=await verifiedClaim({getInfo:async()=>info(0),receive:async()=>({code:202100}),officialFallback:async()=>{},wait});
 assert.equal(r.state,'needs_attention');
});
test('already claimed rewards do not submit again',async()=>{
 const r=await verifiedClaim({getInfo:async()=>info(6),receive:async()=>assert.fail('duplicate POST'),wait});assert.equal(r.already,true);
});
test('incomplete tasks do not submit',async()=>{
 const r=await verifiedClaim({getInfo:async()=>info(8),receive:async()=>assert.fail('early POST'),wait});assert.equal(r.state,'ineligible');
});
test('WBI encoding matches upstream Python signer',()=>{
 const q=signWbi({foo:'114',bar:'514',baz:1919810},['https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png','https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'],1702204169);
 assert.equal(q,'bar=514&baz=1919810&foo=114&wts=1702204169&w_rid=6149fdadf571698ca7e6a567265cd0ee');
});
