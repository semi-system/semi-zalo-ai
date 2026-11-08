import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { query,initializeDatabase,pool,verifyPassword,hashPassword } from './db.js';
import { runtime,refreshRuntime,loadRuntime,saveRuntime,initKey } from './runtime.js';
import { cookieName,issueSession,validateSession,verifyOrigin } from './security.js';
import { initGateway,restoreGateway,startQRLogin,disconnectGateway,setGatewayEnabled,logoutGateway,getGatewayStatus,gatewayStatus,getGatewayQR,sendZalo, type Incoming } from './gateway.js';
import { answerMessage, testAIInference } from './agent.js';
import { listConnections,resolveInput,testConnection,storeConnection } from './connections.js';
const app=Fastify({logger:{level:'info',redact:['req.headers.authorization','req.headers.cookie','res.headers.set-cookie']},bodyLimit:1024*128,trustProxy:false});
await app.register(cookie);
const root=path.resolve(process.cwd(),'apps/web/dist');
if(fs.existsSync(root))await app.register(staticFiles,{root,prefix:'/'});
const jsonError=(message:string)=>({error:message});
app.addHook('onRequest',async(req,reply)=>{
 if(req.url.startsWith('/api/')&&!verifyOrigin(req))return reply.code(403).send(jsonError('Invalid origin'));
});
app.get('/health',async()=>({ok:true,db:(await query('SELECT 1')).rowCount===1,gateway:gatewayStatus().status}));
app.get('/api/setup/status',async()=>({needsSetup:(await query('SELECT id FROM app_admins LIMIT 1')).rowCount===0}));
app.post('/api/setup',async(req,reply)=>{
 const b=req.body as any;
 if(typeof b?.username!=='string'||!/^[a-zA-Z0-9_.-]{3,40}$/.test(b.username)||typeof b?.password!=='string'||b.password.length<12||b.password.length>256)return reply.code(400).send(jsonError('Username 3-40 chars, password at least 12 chars'));
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  // Serialize all first-run setup attempts, preventing two admins in parallel.
  await client.query('LOCK TABLE app_admins IN EXCLUSIVE MODE');
  if((await client.query('SELECT 1 FROM app_admins LIMIT 1')).rowCount){await client.query('ROLLBACK');return reply.code(409).send(jsonError('Setup already completed'));}
  await client.query('INSERT INTO app_admins(username,password_hash) VALUES($1,$2)',[b.username,hashPassword(b.password)]);
  await client.query('COMMIT');
  // Pin the public browser origin as soon as the initial admin is created.
  const origin=String(req.headers.origin||'');
  if(/^https?:\/\/[^/]+$/.test(origin)){
    try { await saveRuntime({...runtime(),publicOrigin:origin}); }catch{}
  }
  return {ok:true};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
app.post('/api/auth/login',async(req,reply)=>{
 const input=req.body as any;
 if(typeof input?.username!=='string'||typeof input?.password!=='string')return reply.code(400).send(jsonError('Invalid credentials'));
 const res=await query<{password_hash:string}>("SELECT password_hash FROM app_admins WHERE username=$1",[input.username]);
 if(!res.rows[0]||!verifyPassword(input.password,res.rows[0].password_hash))return reply.code(401).send(jsonError('Invalid credentials'));
 reply.setCookie(cookieName,issueSession(input.username),{httpOnly:true,secure:req.headers['x-forwarded-proto']==='https'||runtime().publicOrigin.startsWith('https://'),sameSite:'strict',path:'/',maxAge:7*24*3600});
 return {ok:true,username:input.username};
});
app.get('/api/auth/me',async(req,reply)=>{const user=validateSession(req);if(!user)return reply.code(401).send(jsonError('Unauthorized'));return {username:user};});
app.addHook('preHandler',async(req,reply)=>{
 if(!req.url.startsWith('/api/')||req.url==='/api/auth/login'||req.url==='/api/auth/me'||req.url==='/api/setup/status'||req.url==='/api/setup')return;
 if(!validateSession(req))return reply.code(401).send(jsonError('Unauthorized'));
});
app.post('/api/auth/logout',async(_req,reply)=>{reply.clearCookie(cookieName,{path:'/'});return {ok:true};});
app.get('/api/dashboard',async()=>{
 const r=await query(`SELECT
 (SELECT count(*)::int FROM app_users) AS users,
 (SELECT count(*)::int FROM app_users WHERE enabled AND role='user') AS approved,
 (SELECT count(*)::int FROM app_messages) AS messages,
 (SELECT count(*)::int FROM app_messages WHERE status='replied') AS replied,
 (SELECT count(*)::int FROM app_messages WHERE status='error') AS errors`);
 return {...r.rows[0],gateway:gatewayStatus()};
});
app.get('/api/gateway',async()=>getGatewayStatus());
app.post('/api/gateway/enable',async(req,reply)=>{
 const body=req.body as {enabled?:unknown}|null;
 if(typeof body?.enabled!=='boolean')return reply.code(422).send(jsonError('enabled must be a boolean'));
 const next=await saveRuntime({...runtime(),zaloEnabled:body.enabled});
 await setGatewayEnabled(next.zaloEnabled);
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),next.zaloEnabled?'enable_gateway':'disable_gateway','zalo']);
 return {ok:true,gateway:await getGatewayStatus()};
});
app.post('/api/gateway/qr/start',async(req,reply)=>{
 if(!runtime().zaloEnabled)return reply.code(409).send(jsonError('Enable Zalo module first'));
 if(gatewayStatus().status==='ready')return reply.code(409).send(jsonError('Already connected; disconnect before requesting QR'));
 startQRLogin();
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'gateway_qr_start','zalo']);
 return {ok:true,gateway:await getGatewayStatus()};
});
app.post('/api/gateway/reconnect',async(req,reply)=>{
 if(!runtime().zaloEnabled)return reply.code(409).send(jsonError('Enable Zalo module first'));
 disconnectGateway();
 void restoreGateway().catch(e=>app.log.warn({error:String(e)},'Zalo reconnect failed'));
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'gateway_reconnect','zalo']);
 return {ok:true,gateway:await getGatewayStatus()};
});
app.post('/api/gateway/disconnect',async(req)=>{
 disconnectGateway();
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'gateway_disconnect','zalo']);
 return {ok:true,gateway:await getGatewayStatus()};
});
app.post('/api/gateway/logout',async(req)=>{
 await logoutGateway();
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'gateway_logout','zalo']);
 return {ok:true,gateway:await getGatewayStatus()};
});
app.get('/api/gateway/qr',async()=>({image:getGatewayQR()}));
app.get('/api/users',async()=>({items:(await query('SELECT thread_id,sender_id,is_group,enabled,role,first_seen_at,last_seen_at FROM app_users ORDER BY last_seen_at DESC LIMIT 300')).rows}));
app.patch('/api/users/:id',async(req,reply)=>{
 const {id}=req.params as {id:string};const body=req.body as any;
 if(!/^\d{5,30}$/.test(id)||!['approve','disable','block','unblock'].includes(body?.action))return reply.code(400).send(jsonError('Invalid action'));
 const statuses:Record<string,[boolean,string]>={approve:[true,'user'],disable:[false,'user'],block:[false,'blocked'],unblock:[false,'pending']};
 const [enabled,role]=statuses[body.action];
 const result=await query('UPDATE app_users SET enabled=$2,role=$3 WHERE thread_id=$1 RETURNING thread_id',[id,enabled,role]);
 if(!result.rowCount)return reply.code(404).send(jsonError('User not found'));
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),body.action,id]);return {ok:true};
});
app.get('/api/messages',async(req)=>{
 const q=req.query as {threadId?:string};
 return {items:(await query(`SELECT id,thread_id,sender_id,message_id,direction,message_text,attachment_type,status,reply_text,error,created_at FROM app_messages WHERE ($1::text IS NULL OR thread_id=$1) ORDER BY id DESC LIMIT 200`,[q.threadId&&/^\d{5,30}$/.test(q.threadId)?q.threadId:null])).rows};
});
app.get('/api/settings',async()=>({systemPrompt:(await query<{value:string}>("SELECT value FROM app_settings WHERE key='system_prompt'")).rows[0]?.value||''}));
app.put('/api/settings',async(req,reply)=>{
 const b=req.body as any;
 if(typeof b?.systemPrompt!=='string'||b.systemPrompt.length<50||b.systemPrompt.length>15000)return reply.code(400).send(jsonError('Prompt must be 50–15000 characters'));
 await query("INSERT INTO app_settings(key,value) VALUES('system_prompt',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=now()",[b.systemPrompt]);
 await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'update_prompt','system_prompt']);
 return {ok:true};
});
app.get('/api/runtime',async()=>({settings:await refreshRuntime()}));
app.put('/api/runtime',async(req,reply)=>{
 try{
  const wasEnabled=runtime().zaloEnabled;
  const settings=await saveRuntime(req.body);
  if(wasEnabled!==settings.zaloEnabled)await setGatewayEnabled(settings.zaloEnabled);
  if(settings.aiEnabled)pump();
  await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'update_runtime','runtime']);
  return {ok:true,settings,restartRecommended:true};
 }catch(e){return reply.code(422).send(jsonError(e instanceof Error?e.message:'Invalid runtime settings'));}
});
app.post('/api/ai/test',async(_req,reply)=>{
 try {
  const result=await testAIInference();
  return {ok:true,...result};
 }catch(e){return reply.code(422).send(jsonError(e instanceof Error?e.message:'AI test failed'));}
});
app.get('/api/connections',async()=>({items:await listConnections()}));
app.post('/api/connections/test',async(req,reply)=>{
 try{const c=await resolveInput(req.body);return await testConnection(c);}
 catch(e){return reply.code(422).send(jsonError(e instanceof Error?e.message:'Connection test failed'));}
});
app.put('/api/connections',async(req,reply)=>{
 try{
  const c=await resolveInput(req.body);
  const tested=await testConnection(c); // Never persist a connection that failed its test.
  if(c.provider==='ollama'&&('modelAvailable' in tested)&&(!tested.modelAvailable||!tested.visionModelAvailable))return reply.code(422).send(jsonError('Model được chọn không tồn tại trong Ollama. Hãy Pull model trước khi lưu.'));
  await storeConnection(c);
  await query('INSERT INTO app_audit(actor,action,target) VALUES($1,$2,$3)',[validateSession(req),'update_connection',c.provider]);
  return {ok:true,test:tested};
 }catch(e){return reply.code(422).send(jsonError(e instanceof Error?e.message:'Unable to save connection'));}
});
app.get('/api/audit',async()=>({items:(await query('SELECT * FROM app_audit ORDER BY id DESC LIMIT 100')).rows}));
app.get('/api/conversations/:id/history',async(req,reply)=>{
 const {id}=req.params as {id:string};if(!/^\d{5,30}$/.test(id))return reply.code(400).send(jsonError('Invalid thread ID'));
 return {items:(await query('SELECT role,content,created_at FROM app_chat_history WHERE thread_id=$1 ORDER BY id DESC LIMIT 100',[id])).rows.reverse()};
});
app.setNotFoundHandler(async(req,reply)=>{
 if(req.method==='GET'&&!req.url.startsWith('/api/')&&fs.existsSync(path.join(root,'index.html'))){reply.type('text/html');return reply.send(fs.createReadStream(path.join(root,'index.html')));}
 return reply.code(404).send(jsonError('Not found'));
});
// Worker intentionally shares one process with zca-js but never blocks message ingestion.
const queue:Incoming[]=[];let inFlight=0;const queuedKeys=new Set<string>();
function pump(){
 if(!runtime().aiEnabled)return;
 while(inFlight<runtime().aiConcurrency&&queue.length){
  const msg=queue.shift()!;const key=msg.threadId+':'+msg.messageId;
  inFlight++;
  void processMessage(msg).catch(err=>app.log.error({messageId:msg.messageId,error:String(err)},'AI processing failed')).finally(()=>{inFlight--;queuedKeys.delete(key);pump();});
 }
}
async function ingest(msg:Incoming){
 if(msg.isSelf||msg.isGroup||msg.senderId!==msg.threadId)return;
 // Prevent incoming untrusted attachments from being stored as arbitrary URLs.
 const rawUrl=typeof msg.rawContent?.href==='string'?msg.rawContent.href:'';
 const kind=rawUrl.startsWith('https://photo-')?'image':rawUrl.startsWith('https://video-')?'video':msg.rawContent?'attachment':'text';
 const client=await pool.connect();let shouldProcess=false;
 try{
  await client.query('BEGIN');
  const u=await client.query<{enabled:boolean,role:string}>(`INSERT INTO app_users(thread_id,sender_id,is_group) VALUES($1,$2,false) ON CONFLICT(thread_id) DO UPDATE SET last_seen_at=now() RETURNING enabled,role`,[msg.threadId,msg.senderId]);
  const ins=await client.query(`INSERT INTO app_messages(thread_id,sender_id,message_id,message_text,attachment_type,attachment_url) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(thread_id,message_id) DO NOTHING RETURNING id`,[msg.threadId,msg.senderId,msg.messageId,msg.text||String(msg.rawContent?.title||'[Đính kèm]'),kind,kind==='image'?rawUrl:null]);
  shouldProcess=!!ins.rowCount&&u.rows[0]?.enabled===true&&u.rows[0]?.role==='user'&&runtime().aiEnabled;
  if(shouldProcess)await client.query(`UPDATE app_messages SET status='queued' WHERE thread_id=$1 AND message_id=$2`,[msg.threadId,msg.messageId]);
  await client.query('COMMIT');
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 if(shouldProcess){const key=msg.threadId+':'+msg.messageId;if(!queuedKeys.has(key)){queuedKeys.add(key);queue.push(msg);pump();}}
}
// Serialize processing for the same thread in addition to global concurrency.
const processingThreads=new Set<string>();
async function processMessage(m:Incoming){
 if(processingThreads.has(m.threadId)){
  await new Promise<void>((resolve,reject)=>{const end=Date.now()+90000;const timer=setInterval(()=>{if(!processingThreads.has(m.threadId)){clearInterval(timer);resolve();}else if(Date.now()>end){clearInterval(timer);reject(new Error('Thread busy timeout'));}},100);});
 }
 processingThreads.add(m.threadId);
 try{
  await query(`UPDATE app_messages SET status='processing' WHERE thread_id=$1 AND message_id=$2`,[m.threadId,m.messageId]);
  const answer=await answerMessage(m);
  await sendZalo(m.threadId,answer.text);
  await query(`UPDATE app_messages SET status='replied',reply_text=$3,replied_at=now() WHERE thread_id=$1 AND message_id=$2`,[m.threadId,m.messageId,answer.text]);
 }catch(err){
  const reason=err instanceof Error?err.message:'Unknown error';
  await query(`UPDATE app_messages SET status='error',error=$3 WHERE thread_id=$1 AND message_id=$2`,[m.threadId,m.messageId,reason.slice(0,500)]);
  try{await sendZalo(m.threadId,'Xin lỗi, AI đang gặp lỗi khi xử lý tin nhắn. Bạn thử lại sau nhé.');}catch{}
  throw err;
 }finally{processingThreads.delete(m.threadId);}
}
await initializeDatabase();
await query("INSERT INTO app_settings(key,value) VALUES('runtime',$1) ON CONFLICT(key) DO NOTHING",[JSON.stringify(runtime())]);
await initKey();
await loadRuntime();
await app.listen({host:'0.0.0.0',port:3000});
app.log.info('Semi Zalo AI started');
initGateway(ingest,message=>app.log.info(message));
if(runtime().zaloEnabled)void restoreGateway().catch(e=>app.log.error({error:String(e)},'Gateway session restore failed')); 
process.on('SIGTERM',()=>{void app.close().finally(()=>pool.end());});
