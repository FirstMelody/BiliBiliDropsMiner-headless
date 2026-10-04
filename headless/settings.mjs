import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(filename) {
 let config;
 try { config=JSON.parse(await fs.readFile(filename,'utf8')); }
 catch { throw Error('config_unreadable_or_invalid_json'); }
 const base=path.dirname(path.resolve(filename));
 if(!Number.isSafeInteger(config.roomId)||config.roomId<=0)throw Error('config_invalid_room_id');
 for(const [key,fallback,min] of [
  ['pollIntervalMs',60000,30000],['discoveryIntervalMs',600000,60000],
  ['refreshIntervalMs',86400000,60000],['stallIntervalMs',900000,60000]
 ]){
  config[key]??=fallback;
  if(!Number.isSafeInteger(config[key])||config[key]<min)throw Error('config_invalid_'+key);
 }
 config.dataDir=path.resolve(base,config.dataDir||'../data');
 config.pythonExecutable=config.pythonExecutable||'../.venv/bin/python';
 if(config.pythonExecutable.includes('/'))config.pythonExecutable=path.resolve(base,config.pythonExecutable);
 if(config.browserExecutable)config.browserExecutable=path.resolve(base,config.browserExecutable);
 config.notifications??={enabled:false};
 if(config.notifications.enabled){
  const n=config.notifications;
  let url;try{url=new URL(n.websocketUrl);}catch{throw Error('config_invalid_notification_url');}
  if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.search)throw Error('config_invalid_notification_url');
  if(!Number.isSafeInteger(n.userId)||n.userId<=0||typeof n.accessToken!=='string'||!n.accessToken)throw Error('config_invalid_notification_credentials');
 }
 return config;
}

export function parseCookieHeader(header) {
 if(typeof header!=='string'||/[\r\n]/.test(header))throw Error('config_invalid_cookie');
 const values=new Map();
 for(const entry of header.split(';')){
  const separator=entry.indexOf('=');
  if(separator<1)continue;
  const name=entry.slice(0,separator).trim(),value=entry.slice(separator+1).trim();
  if(!/^[\w-]+$/.test(name)||!value)throw Error('config_invalid_cookie');
  values.set(name,value);
 }
 for(const name of ['SESSDATA','bili_jct']){
  if(!values.has(name)||/^(YOUR_|xxxx|REPLACE)/i.test(values.get(name)))throw Error('config_missing_'+name);
 }
 return [...values].map(([name,value])=>({name,value,domain:'.bilibili.com',path:'/',secure:true,httpOnly:name==='SESSDATA',sameSite:'Lax'}));
}

export function initialSession(config) {
 const cookies=parseCookieHeader(config.cookie);
 if(typeof config.refreshToken!=='string'||!config.refreshToken||/^(YOUR_|xxxx|REPLACE)/i.test(config.refreshToken))throw Error('config_missing_refresh_token_ac_time_value');
 return {cookies,refreshToken:config.refreshToken,pendingConfirmation:null};
}

// Errors and external responses must never echo user credentials or request URLs.
export function redactor(config) {
 const secrets=[config.cookie,config.refreshToken,config.notifications?.accessToken];
 if(typeof config.cookie==='string')for(const entry of config.cookie.split(';'))secrets.push(entry.slice(entry.indexOf('=')+1).trim());
 const redact=value=>{
  let text=String(value??'');
  for(const secret of secrets.filter(x=>typeof x==='string'&&x.length>=4))text=text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/\S+/g,'[URL]')
   .replace(/((?:SESSDATA|bili_jct|refresh_token|access_token)\s*[=:]\s*)[^;\s]+/gi,'$1[redacted]');
 };
 redact.add=values=>secrets.push(...values);
 return redact;
}
