import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import engine from './notify-engine.cjs';
import {atomicJson} from './storage.mjs';

export function sendOneBot(config,text) {
 return new Promise((resolve,reject)=>{
  const socket=new WebSocket(config.websocketUrl,{headers:{Authorization:'Bearer '+config.accessToken}});
  const echo='drops:'+randomUUID();let settled=false;
  const timer=setTimeout(()=>finish(Error('notification_timeout')),15000);
  function finish(error,id){
   if(settled)return;settled=true;clearTimeout(timer);socket.close();
   error?reject(error):resolve(id);
  }
  socket.on('open',()=>socket.send(JSON.stringify({action:'send_private_msg',params:{user_id:config.userId,message:[{type:'text',data:{text}}]},echo})));
  socket.on('message',raw=>{
   let r;try{r=JSON.parse(raw.toString());}catch{return;}
   if(r.echo!==echo)return;
   if(r.status==='ok'&&Number(r.retcode||0)===0&&r.data?.message_id!==undefined)finish(null,r.data.message_id);
   else finish(Error('notification_rejected'));
  });
  socket.on('error',()=>finish(Error('notification_connection_failed')));
  socket.on('close',()=>{if(!settled)finish(Error('notification_connection_closed'));});
 });
}

export async function createNotifier(config,dataDir,log) {
 if(!config.enabled)return async()=>{};
 const filename=path.join(dataDir,'notify-state.json');
 let memory={};try{memory=JSON.parse(await fs.readFile(filename,'utf8'));}catch(e){if(e.code!=='ENOENT')throw Error('notification_state_unreadable');}
 return async(state,miner)=>{
  const messages=engine.inspect({state,miner},memory);
  await atomicJson(filename,memory);
  for(const message of messages){
   try{
    await sendOneBot(config,message.text);engine.acknowledge(memory,message);
    await atomicJson(filename,memory);log('notification_sent',{type:message.type});
   }catch {log('notification_retry');break;}
  }
 };
}
