import https from 'node:https';
import {discoverTasks} from './core.mjs';

// Parse server-rendered JSON; never evaluate scripts or instantiate a player.
export function pageJson(html,marker) {
 const offset=html.indexOf(marker);
 if(offset<0)return null;
 const equals=html.indexOf('=',offset+marker.length);
 if(equals<0)throw Error('campaign_assignment_missing');
 let start=equals+1;
 while(/\s/.test(html[start]||'')&&start<html.length)start++;
 if(!['{','['].includes(html[start]))throw Error('campaign_json_missing');
 let depth=0,quoted=false,escaped=false;
 for(let i=start;i<html.length;i++){
  const ch=html[i];
  if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
  if(ch==='"'){quoted=true;continue;}
  if(ch==='{'||ch==='[')depth++;
  else if(ch==='}'||ch===']'){
   if(--depth===0){try{return JSON.parse(html.slice(start,i+1));}catch{throw Error('campaign_json_invalid');}}
  }
 }
 throw Error('campaign_json_truncated');
}

export function parseCampaign(html) {
 const data=pageJson(html,'window.__BILIACT_EVAPAGEDATA__');
 const initial=pageJson(html,'window.__initialState');
 // A normal live page means no campaign. An anti-bot/error document is not proof.
 if(!data&&!initial&&!html.includes('__NEPTUNE_IS_MY_WAIFU__'))throw Error('campaign_page_unrecognized');
 const tasks=discoverTasks(data||initial||{});
 const title=initial?.BaseInfo?.title||html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]||'Bilibili drops';
 return {title,tasks};
}

export function directEnvironment(source=process.env) {
 return {...Object.fromEntries(Object.entries(source).filter(([key])=>! /^(?:https?|all|no)_proxy$/i.test(key)&&key!=='NODE_USE_ENV_PROXY')),NO_PROXY:'*',no_proxy:'*'};
}

export async function fetchCampaign(roomId) {
 const get=(url,remaining=3)=>new Promise((resolve,reject)=>{
  // Explicit agent disables Node's opt-in environment proxy integration too.
  const agent=new https.Agent({keepAlive:false,proxyEnv:{}});
  const request=https.get(url,{agent,headers:{'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity'},timeout:25000},response=>{
   if(response.statusCode>=300&&response.statusCode<400&&response.headers.location){
    response.resume();agent.destroy();
    const next=new URL(response.headers.location,url);
    if(remaining<=0||next.protocol!=='https:'||!(next.hostname==='bilibili.com'||next.hostname.endsWith('.bilibili.com')))return reject(Error('campaign_redirect_rejected'));
    resolve(get(next,remaining-1));return;
   }
   if(response.statusCode!==200){response.resume();agent.destroy();return reject(Error('campaign_http_'+response.statusCode));}
   let size=0;const chunks=[];
   response.on('data',chunk=>{size+=chunk.length;if(size>8*1024*1024)request.destroy(Error('campaign_html_too_large'));else chunks.push(chunk);});
   response.on('error',()=>reject(Error('campaign_response_failed')));
   response.on('end',()=>{agent.destroy();resolve(Buffer.concat(chunks).toString('utf8'));});
  });
  request.on('timeout',()=>request.destroy(Error('campaign_timeout')));
  request.on('error',()=>{agent.destroy();reject(Error('campaign_fetch_failed'));});
 });
 return parseCampaign(await get(new URL('https://live.bilibili.com/'+roomId)));
}
