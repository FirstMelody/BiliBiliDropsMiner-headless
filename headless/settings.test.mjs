import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig,initialSession,parseCookieHeader,redactor} from './settings.mjs';
import {privateDirectory,atomicJson} from './storage.mjs';

const credentials={cookie:'SESSDATA=test-session; bili_jct=test-csrf; buvid3=test-device',refreshToken:'test-refresh'};
test('cookie parser keeps percent encoding and embedded equals unchanged',()=>{
 const parsed=parseCookieHeader('SESSDATA=abc%2Fdef==; bili_jct=test-csrf');
 assert.equal(parsed[0].value,'abc%2Fdef==');assert.equal(parsed[0].httpOnly,true);
});
test('example placeholders and missing csrf are rejected without exposing values',()=>{
 assert.throws(()=>parseCookieHeader('SESSDATA=YOUR_SESSDATA; bili_jct=YOUR_CSRF'),/config_missing/);
 assert.throws(()=>parseCookieHeader('SESSDATA=private-value'),/config_missing_bili_jct/);
 assert.throws(()=>initialSession({...credentials,refreshToken:''}),/config_missing_refresh_token/);
});
test('config resolves paths relative to itself and validates private notifier config',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-drops-settings-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'settings.json');
 await fs.writeFile(file,JSON.stringify({roomId:23612045,...credentials,dataDir:'state',pythonExecutable:'python3'}));
 const config=await loadConfig(file);assert.equal(config.dataDir,path.join(dir,'state'));assert.equal(config.pythonExecutable,'python3');
 await fs.writeFile(file,JSON.stringify({roomId:23612045,notifications:{enabled:true,websocketUrl:'ws://host/?access_token=secret',accessToken:'secret',userId:1}}));
 await assert.rejects(()=>loadConfig(file),/config_invalid_notification_url/);
});
test('redaction learns new tokens during rotation and strips authenticated URLs',()=>{
 const redact=redactor({...credentials,notifications:{accessToken:'private-bot-token'}});
 redact.add(['rotated-refresh-token']);
 for(const value of ['test-session','test-csrf','test-refresh','private-bot-token','rotated-refresh-token'])assert.equal(redact(value),'[redacted]');
 assert.equal(redact('https://host/path?token=secret'),'[URL]');
});
test('private storage is atomic, readable and owner-only',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'codex-drops-storage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await privateDirectory(dir);const file=path.join(dir,'session.json');await atomicJson(file,{refreshToken:'synthetic-token'});
 assert.equal((await fs.stat(dir)).mode&0o777,0o700);assert.equal((await fs.stat(file)).mode&0o777,0o600);
 assert.equal(JSON.parse(await fs.readFile(file,'utf8')).refreshToken,'synthetic-token');
 await assert.rejects(()=>fs.access(file+'.tmp'));
});
