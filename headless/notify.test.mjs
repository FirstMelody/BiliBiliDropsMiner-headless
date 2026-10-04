import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {sendOneBot} from './notify.mjs';

test('OneBot notification uses configured recipient and header token and checks acknowledgment',async t=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>server.once('listening',r));
 t.after(()=>new Promise(r=>server.close(r)));
 server.on('connection',(socket,request)=>{
  assert.equal(request.headers.authorization,'Bearer synthetic-access-token');
  socket.on('message',raw=>{
   const message=JSON.parse(raw);assert.equal(message.action,'send_private_msg');assert.equal(message.params.user_id,12345);
   socket.send(JSON.stringify({echo:message.echo,status:'ok',retcode:0,data:{message_id:42}}));
  });
 });
 assert.equal(await sendOneBot({websocketUrl:'ws://127.0.0.1:'+server.address().port,accessToken:'synthetic-access-token',userId:12345},'test notification'),42);
});
test('OneBot rejected delivery is not treated as sent',async t=>{
 const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(r=>server.once('listening',r));
 t.after(()=>new Promise(r=>server.close(r)));
 server.on('connection',socket=>socket.on('message',raw=>socket.send(JSON.stringify({echo:JSON.parse(raw).echo,status:'failed',retcode:1404}))));
 await assert.rejects(()=>sendOneBot({websocketUrl:'ws://127.0.0.1:'+server.address().port,accessToken:'synthetic-access-token',userId:12345},'test notification'),/notification_rejected/);
});
