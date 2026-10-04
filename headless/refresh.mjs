// Official browser cookie/info -> correspond -> cookie/refresh -> confirm/refresh.
// A durable checkpoint is mandatory before invalidating the old refresh token.
export async function refreshSession(home,checkpoint) {
 const confirm=()=>home.evaluate(async()=>{
  const pendingKey='ow_drops_pending_confirm';
  const old=localStorage.getItem(pendingKey);
  if(!old)return;
  const csrf=document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
  const r=await fetch('https://passport.bilibili.com/x/passport-login/web/confirm/refresh',{
   credentials:'include',signal:AbortSignal.timeout(25000),method:'POST',
   headers:{'Content-Type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({csrf,refresh_token:old})});
  if(!r.ok)throw Error('refresh_confirm_http_'+r.status);
  const result=await r.json();
  if(result.code!==0)throw Error('refresh_confirm_'+result.code);
  localStorage.removeItem(pendingKey);
 });
 if(await home.evaluate(()=>!!localStorage.getItem('ow_drops_pending_confirm'))){
  await confirm();await checkpoint();
 }
 const result=await home.evaluate(async()=>{
  const base='https://passport.bilibili.com/x/passport-login/web/';
  const csrf=()=>document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)?.[1];
  const json=async(endpoint,body)=>{
   const r=await fetch(base+endpoint,{credentials:'include',signal:AbortSignal.timeout(25000),
    ...(body?{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)}:{})});
   if(!r.ok)throw Error('refresh_http_'+r.status);
   return r.json();
  };
  const info=await json('cookie/info?csrf='+encodeURIComponent(csrf()||''));
  if(info.code!==0)return {state:'login_required',code:info.code};
  const old=localStorage.getItem('ac_time_value');
  if(!old)return {state:'refresh_token_missing'};
  if(!info.data.refresh)return {state:'valid',refreshTokenAvailable:true};
  const key=await crypto.subtle.importKey('jwk',{kty:'RSA',e:'AQAB',
   n:'y4HdjgJHBlbaBN04VERG4qNBIFHP6a3GozCl75AihQloSWCXC5HDNgyinEnhaQ_4-gaMud_GF50elYXLlCToR9se9Z8z433U3KjM-3Yx7ptKkmQNAMggQwAVKgq3zYAoidNEWuxpkY_mAitTSRLnsJW-NCTa0bqBFF6Wm1MxgfE'},
   {name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,new TextEncoder().encode('refresh_'+info.data.timestamp)));
  const encryptedPath=Array.from(encrypted,x=>x.toString(16).padStart(2,'0')).join('');
  const html=await fetch('/correspond/1/'+encryptedPath,{credentials:'include',signal:AbortSignal.timeout(25000)}).then(r=>{
   if(!r.ok)throw Error('refresh_correspond_'+r.status);return r.text();
  });
  const refreshCsrf=new DOMParser().parseFromString(html,'text/html').getElementById('1-name')?.textContent?.trim();
  if(!refreshCsrf)throw Error('refresh_csrf_missing');
  const rotated=await json('cookie/refresh',{csrf:csrf(),refresh_csrf:refreshCsrf,source:'main_web',refresh_token:old});
  if(rotated.code!==0)throw Error('refresh_rotate_'+rotated.code);
  if(!rotated.data?.refresh_token)throw Error('refresh_new_token_missing');
  localStorage.setItem('ac_time_value',rotated.data.refresh_token);
  localStorage.setItem('ow_drops_pending_confirm',old);
  return {state:'rotation_pending'};
 });
 // Disk failure prevents confirmation; resume from the pending token next run.
 await checkpoint();
 if(result.state==='rotation_pending'){
  await confirm();await checkpoint();
  return {state:'refreshed',refreshTokenAvailable:true};
 }
 return result;
}
