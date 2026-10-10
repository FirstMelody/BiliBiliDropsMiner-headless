import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pageJson,parseCampaign,directEnvironment} from './discovery.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/owcs-s3.json',import.meta.url)));
test('discovers six tasks from HTML without executing page scripts',()=>{
 const html='<script>window.__BILIACT_EVAPAGEDATA__ = '+JSON.stringify({layerTree:fixture})+'; window.badCode();</script><title>OWCS</title>';
 assert.equal(parseCampaign(html).tasks.length,6);
 assert.equal(parseCampaign(html).title,'OWCS');
});
test('balanced JSON extraction handles quoted braces, escaped quotes and nested arrays',()=>{
 const expected={value:'a "quoted" } ] { \\ thing',nested:[{},[]]};
 assert.deepEqual(pageJson('window.test = '+JSON.stringify(expected)+'; malicious()', 'window.test'),expected);
});
test('unrecognized or truncated documents are errors rather than campaign disappearance',()=>{
 assert.throws(()=>parseCampaign('<html>Access denied</html>'),/unrecognized/);
 assert.throws(()=>parseCampaign('window.__BILIACT_EVAPAGEDATA__ = {"layerTree":['),/truncated/);
});
test('ordinary room page without activity produces empty campaign',()=>{
 assert.deepEqual(parseCampaign('<title>room</title><script>window.__NEPTUNE_IS_MY_WAIFU__={};</script>').tasks,[]);
});
test('direct child environment removes proxy inheritance but retains unrelated settings',()=>{
 const env=directEnvironment({HTTPS_PROXY:'http://proxy',http_proxy:'http://proxy',ALL_PROXY:'socks5://proxy',NO_PROXY:'localhost',NODE_USE_ENV_PROXY:'1',PATH:'/bin',TOKEN:'untouched'});
 assert.deepEqual(env,{PATH:'/bin',TOKEN:'untouched',NO_PROXY:'*',no_proxy:'*'});
});
