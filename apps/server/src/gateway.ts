import { Zalo, ThreadType, LoginQRCallbackEventType } from 'zca-js';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { refreshRuntime, runtime } from './runtime.js';

const decodeQR = createRequire(import.meta.url)('jsqr') as (data:Uint8ClampedArray,width:number,height:number,options?:{inversionAttempts:'attemptBoth'})=>{data:string}|null;
export type Incoming={messageId:string;threadId:string;senderId:string;isGroup:boolean;isSelf:boolean;text:string;rawContent:Record<string,unknown>|null};
type ZaloAPI=Awaited<ReturnType<Zalo['login']>>;
type State='disabled'|'disconnected'|'connecting'|'waiting_qr'|'ready'|'error';
let api:ZaloAPI|null=null;
let state:State='disconnected';
let qrImage:string|null=null;
let qrAt:number|null=null;
let lastSend=0;
let lastError:string|null=null;
let generation=0;
let pending:Promise<void>|null=null;
let qrAbort:(()=>void)|null=null;
let onIncoming:((m:Incoming)=>Promise<void>)|null=null;
let logger:((s:string)=>void)=()=>{};
let sessionLocation:string|null=null;
const seen=new Map<string,number>();
const sessionFile=()=>path.join(runtime().zaloDataDir,'session.json');

export const gatewayStatus=()=>({status:state,enabled:runtime().zaloEnabled,qrAvailable:!!qrImage,qrAt,error:lastError,hasSession:!!sessionLocation});
export const getGatewayQR=()=>qrImage;
function log(text:string){logger(text);}
function errMessage(e:unknown){return e instanceof Error?e.message:String(e);}
function invalidateQR(){qrImage=null;qrAt=null;qrAbort=null;}
function stopListener(){
 const previous=api;api=null;
 try{previous?.listener.stop?.();}catch(e){log('Unable to stop Zalo listener: '+errMessage(e));}
}
function halt(){
 generation++;
 try{qrAbort?.();}catch{}
 invalidateQR();stopListener();pending=null;
}
export function initGateway(onMessage:(m:Incoming)=>Promise<void>,writeLog:(x:string)=>void){onIncoming=onMessage;logger=writeLog;state=runtime().zaloEnabled?'disconnected':'disabled';}
export async function getGatewayStatus(){
 try{await fs.access(sessionFile());sessionLocation=sessionFile();}catch{sessionLocation=null;}
 return gatewayStatus();
}
async function saveSession(x:any){
 if(!x?.cookie||!x?.imei||!x?.userAgent)return;
 await fs.mkdir(runtime().zaloDataDir,{recursive:true,mode:0o700});
 const file=sessionFile();const temp=file+'.tmp';
 await fs.writeFile(temp,JSON.stringify({cookie:x.cookie,imei:x.imei,userAgent:x.userAgent}),{mode:0o600});
 await fs.rename(temp,file);sessionLocation=file;
}
function sanitize(value:unknown){
 const blocked=/^(cookie|cookies|session|sessionid|session_id|token|access_token|refresh_token|authorization|password|secret|imei|useragent|user_agent|credential|credentials|api_key|apikey)$/i;
 const visited=new WeakSet<object>();
 return JSON.parse(JSON.stringify(value,(key,item)=>{
  if(blocked.test(key))return undefined;
  if(typeof item==='bigint')return String(item);
  if(item&&typeof item==='object'){if(visited.has(item))return '[circular]';visited.add(item);}
  return item;
 }));
}
function attachListener(client:ZaloAPI,gen:number){
 if(gen!==generation||!runtime().zaloEnabled)return;
 api=client;
 client.listener.on('message',async(event:any)=>{
  if(gen!==generation||state!=='ready'||!onIncoming)return;
  try{
   const body=event.data?.content;
   const isText=typeof body==='string',isObject=!!body&&typeof body==='object'&&!Array.isArray(body);
   if(event.isSelf===true||(!isText&&!isObject))return;
   const m:Incoming={threadId:String(event.threadId??''),senderId:String(event.data?.uidFrom??''),messageId:String(event.data?.msgId??event.data?.cliMsgId??''),isGroup:event.type===ThreadType.Group||event.isGroup===true,isSelf:false,text:isText?body.trim():'',rawContent:isObject?sanitize(body):null};
   if(!/^\d{5,30}$/.test(m.threadId)||!/^\d{5,30}$/.test(m.senderId)||!/^[A-Za-z0-9_-]{1,100}$/.test(m.messageId))return;
   if(isText&&(!m.text||m.text.length>4000))return;
   const key=m.threadId+':'+m.messageId;if(seen.has(key))return;
   seen.set(key,Date.now());if(seen.size>2000)for(const [k,v] of seen)if(Date.now()-v>600000)seen.delete(k);
   await onIncoming(m);
  }catch(e){log('Inbound processing error: '+errMessage(e));}
 });
 client.listener.on('error',()=>{if(gen===generation){state='error';lastError='Zalo listener error';log(lastError);}});
 client.listener.on('connected',()=>{if(gen===generation){state='ready';lastError=null;}});
 client.listener.on('closed',()=>{if(gen===generation){state='error';lastError='Zalo websocket closed';}});
 client.listener.start();
 invalidateQR();state='ready';lastError=null;log('Zalo listener started');
}
async function connect(allowQR:boolean):Promise<void>{
 if(!onIncoming)throw new Error('Gateway not initialized');
 if(!runtime().zaloEnabled)throw new Error('Enable Zalo module first');
 if(state==='ready')return;
 if(pending)return pending;
 halt();const gen=generation;
 state='connecting';lastError=null;
 const task=(async()=>{
  await fs.mkdir(runtime().zaloDataDir,{recursive:true,mode:0o700});
  // zca-js stores extra data relative to the process cwd.
  process.chdir(runtime().zaloDataDir);
  const zalo=new Zalo({selfListen:false,checkUpdate:false});
  let client:ZaloAPI|null=null;
  try{
   const saved=JSON.parse(await fs.readFile(sessionFile(),'utf8'));
   sessionLocation=sessionFile();client=await zalo.login(saved);
   if(gen===generation)log('Zalo session restored');
  }catch{if(gen===generation)log('No valid Zalo session');}
  if(gen!==generation||!runtime().zaloEnabled)return;
  if(!client&&!allowQR){state='disconnected';lastError='No valid session. Click QR Login to connect.';return;}
  if(!client){
   state='waiting_qr';
   client=await zalo.loginQR({},(cb:any)=>{
    if(gen!==generation){try{cb.actions?.abort?.();}catch{}return;}
    try{
     if(cb.type===LoginQRCallbackEventType.QRCodeGenerated){
      const encoded=String(cb.data?.image||'').replace(/^data:image\/png;base64,/, '');
      if(!encoded)return;
      const png=PNG.sync.read(Buffer.from(encoded,'base64'));
      if(!decodeQR(new Uint8ClampedArray(png.data),png.width,png.height,{inversionAttempts:'attemptBoth'})?.data)return;
      qrImage='data:image/png;base64,'+encoded;qrAt=Date.now();
      qrAbort=typeof cb.actions?.abort==='function'?()=>cb.actions.abort():null;
      log('Zalo QR available in admin panel');
     }else if(cb.type===LoginQRCallbackEventType.QRCodeExpired){
      qrImage=null;qrAt=null;cb.actions?.retry?.();
     }else if(cb.type===LoginQRCallbackEventType.QRCodeDeclined){
      invalidateQR();state='disconnected';cb.actions?.abort?.();
     }else if(cb.type===LoginQRCallbackEventType.GotLoginInfo){
      void saveSession(cb.data).catch(e=>log('Session save failed: '+errMessage(e)));
     }
    }catch(e){log('QR callback error: '+errMessage(e));}
   });
  }
  if(gen===generation&&runtime().zaloEnabled&&client)attachListener(client,gen);
 })().catch(e=>{
  if(gen===generation){state='error';lastError=errMessage(e);log('Zalo connect failed: '+lastError);}
  throw e;
 }).finally(()=>{if(pending===task)pending=null;});
 pending=task;
 return task;
}
// Never force a QR request at application startup: sessions may auto-restore.
export async function restoreGateway(){return connect(false);}
export function startQRLogin(){if(state==='waiting_qr')return;void connect(true).catch(e=>log('QR login failed: '+errMessage(e)));}
export function disconnectGateway(){halt();state=runtime().zaloEnabled?'disconnected':'disabled';lastError=null;}
export async function setGatewayEnabled(enabled:boolean){
 if(!enabled){disconnectGateway();state='disabled';}
 else if(state==='disabled')state='disconnected';
}
export async function logoutGateway(){
 disconnectGateway();
 await fs.rm(sessionFile(),{force:true});sessionLocation=null;
 log('Local Zalo session deleted by administrator');
}
export async function sendZalo(threadId:string,message:string){
 if(!runtime().zaloEnabled||!api||state!=='ready')throw new Error('Zalo gateway unavailable');
 if(!/^\d{5,30}$/.test(threadId))throw new Error('Invalid Zalo thread ID');
 for(const chunk of message.match(/[\s\S]{1,1800}/g)||[]){
  const delay=(await refreshRuntime()).zaloSendDelayMs-(Date.now()-lastSend);
  if(delay>0)await new Promise(r=>setTimeout(r,delay));
  if(!api||state!=='ready')throw new Error('Zalo gateway disconnected');
  lastSend=Date.now();await api.sendMessage({msg:chunk},threadId,ThreadType.User);
 }
}
