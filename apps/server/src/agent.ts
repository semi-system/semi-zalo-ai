import { refreshRuntime } from './runtime.js';
import { query, DEFAULT_PROMPT } from './db.js';
import type { Incoming } from './gateway.js';
import { getConnection, endpoint, headers } from './connections.js';
const imageHost=/^photo-[a-z0-9-]+\.zdn\.vn$/i;
function getImageUrl(m:Incoming){
 const raw=String(m.rawContent?.href??'');
 try {const u=new URL(raw);return u.protocol==='https:'&&imageHost.test(u.hostname)&&/\.(?:jpg|jpeg|png|webp)$/i.test(u.pathname)&&raw.length<2048?raw:null;}catch{return null;}
}
async function imageData(url:string){
 const res=await fetch(url,{signal:AbortSignal.timeout(18000),redirect:'error'});
 if(!res.ok)throw new Error('Image HTTP '+res.status);
 const type=res.headers.get('content-type')||'';
 if(!/^image\/(?:jpeg|jpg|png|webp)(?:;|$)/i.test(type))throw new Error('Invalid image MIME type');
 const contentLength=Number(res.headers.get('content-length')||0);
 if(contentLength>(await refreshRuntime()).maxImageBytes)throw new Error('Image too large');
 const reader=res.body?.getReader();if(!reader)throw new Error('Image has no body');
 const chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>(await refreshRuntime()).maxImageBytes)throw new Error('Image too large');chunks.push(value);}}finally{reader.releaseLock();}
 return Buffer.concat(chunks.map(x=>Buffer.from(x))).toString('base64');
}
type Message={role:'system'|'user'|'assistant'|'tool';content:string;tool_name?:string;tool_calls?:any[];images?:string[]};
async function ollama(messages:Message[],tools?:any[]){
 const connection=await getConnection('ollama');if(!connection.url)throw Error('Chưa cấu hình Ollama trong dashboard');
 const url=endpoint(connection.url,'api/chat');
 const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),(await refreshRuntime()).aiTimeoutMs);
 try{
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers(connection)},body:JSON.stringify({model:connection.model,stream:false,messages,tools,options:{temperature:0.1}}),signal:ctrl.signal});
  if(!response.ok)throw new Error(`Ollama HTTP ${response.status}`);
  const out=await response.json() as any;
  if(!out?.message)throw new Error('Ollama response missing message');return out.message;
 }finally{clearTimeout(timer);}
}
async function describeImage(m:Incoming){
 const url=getImageUrl(m);if(!url)return null;
 const img=await imageData(url);
 const connection=await getConnection('ollama');if(!connection.url)throw Error('Chưa cấu hình Ollama trong dashboard');
 const response=await fetch(endpoint(connection.url,'api/chat'),{
  method:'POST',headers:{'content-type':'application/json',...headers(connection)},signal:AbortSignal.timeout((await refreshRuntime()).aiTimeoutMs),
  body:JSON.stringify({model:connection.visionModel,stream:false,messages:[{role:'user',content:'Mô tả chính xác các chi tiết nhìn thấy trong ảnh bằng tiếng Việt, kể cả chữ và sản phẩm. Không đoán chi tiết không rõ. Chú thích: '+String(m.rawContent?.title||''),images:[img]}],options:{temperature:0.1}})
 });
 if(!response.ok)throw new Error('Vision HTTP '+response.status);
 const json=await response.json() as any;
 return String(json.message?.content||'').trim().slice(0,6000)||null;
}
async function webSearch(keyword:string){
 const q=keyword.trim().slice(0,220);if(!q)return 'Từ khóa trống.';
 const connection=await getConnection('searxng');if(!connection.url)return 'SearXNG chưa được cấu hình.';
 const url=new URL(endpoint(connection.url,'search'));url.searchParams.set('q',q);url.searchParams.set('format','json');url.searchParams.set('language','vi');url.searchParams.set('safesearch','1');
 try{
  const res=await fetch(url,{headers:headers(connection),signal:AbortSignal.timeout(10000),redirect:'error'});if(!res.ok)throw new Error(`SearXNG HTTP ${res.status}`);
  const json=await res.json() as any;
  return JSON.stringify((Array.isArray(json.results)?json.results:[]).slice(0,connection.results).map((r:any)=>({title:String(r.title||'').slice(0,160),url:String(r.url||'').slice(0,800),snippet:String(r.content||'').slice(0,500)})));
 }catch{return 'SearXNG không khả dụng. Không được giả vờ đã tìm thấy nguồn.';}
}
const searchTool={type:'function',function:{name:'web_search',description:'Tìm kiếm thông tin mới trên Internet bằng SearXNG. Chỉ truyền từ khóa chung, không truyền thông tin nhạy cảm.',parameters:{type:'object',properties:{query:{type:'string',description:'Từ khóa tìm kiếm ngắn gọn'}},required:['query']}}};
export function plainText(raw:string){return raw.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,'$1: $2').replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/__([^_\n]+)__/g,'$1').replace(/^\s*[-*+]\s+/gm,'- ').replace(/`{1,3}/g,'').replace(/\n{3,}/g,'\n\n').trim();}
export async function answerMessage(m:Incoming){
 const promptResult=await query<{value:string}>("SELECT value FROM app_settings WHERE key='system_prompt'");
 const system=promptResult.rows[0]?.value||DEFAULT_PROMPT;
 const history=await query<{role:'user'|'assistant',content:string}>('SELECT role,content FROM (SELECT id,role,content FROM app_chat_history WHERE thread_id=$1 ORDER BY id DESC LIMIT $2) t ORDER BY id',[m.threadId,(await refreshRuntime()).maxContextMessages*2]);
 let userText=m.text;
 const imageUrl=getImageUrl(m);
 if(imageUrl){
  try{const description=await describeImage(m);userText=`Người dùng gửi ảnh Zalo. Chú thích: ${String(m.rawContent?.title||'(không có)')}\nNội dung phân tích ảnh: ${description||'Không thể đọc rõ ảnh.'}`;}
  catch{userText=`Người dùng gửi ảnh, chú thích: ${String(m.rawContent?.title||'')}. Không thể tải hoặc phân tích ảnh. Nói rõ không thể xem nội dung.`;}
 }else if(m.rawContent){userText=`Người dùng gửi nội dung đính kèm chưa được hỗ trợ phân tích (có thể là video, file hoặc link). Chú thích: ${String(m.rawContent.title||'')}. Không khẳng định đã xem nội dung.`;}
 const now=new Intl.DateTimeFormat('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'full',timeStyle:'short'}).format(new Date());
 const messages:Message[]=[{role:'system',content:system+'\nThời điểm hiện tại ở Việt Nam: '+now},...history.rows.map(x=>({role:x.role,content:x.content})),{role:'user',content:userText}];
 let answer='';let toolUsed=false;
 for(let turn=0;turn<(await refreshRuntime()).aiMaxToolRounds;turn++){
  const response=await ollama(messages,[searchTool]);
  const calls=Array.isArray(response.tool_calls)?response.tool_calls:[];
  if(!calls.length){answer=String(response.content||'').trim();break;}
  messages.push({role:'assistant',content:String(response.content||''),tool_calls:calls});
  for(const c of calls.slice(0,3)){
   const fn=c.function||{};
   const arg=typeof fn.arguments==='string'?(()=>{try{return JSON.parse(fn.arguments);}catch{return {};}})():fn.arguments||{};
   const result=fn.name==='web_search'&&typeof arg.query==='string'?await webSearch(arg.query):'Unknown tool or invalid input';
   if(fn.name==='web_search')toolUsed=true;
   messages.push({role:'tool',tool_name:String(fn.name||'unknown'),content:result});
  }
 }
 if(!answer){const response=await ollama(messages);answer=String(response.content||'').trim();}
 answer=plainText(answer);
 if(!answer)throw new Error('AI answer is empty');
 await query('INSERT INTO app_chat_history(thread_id,role,content) VALUES($1,$2,$3),($1,$4,$5)',[m.threadId,'user',userText,'assistant',answer]);
 return {text:answer.slice(0,10000),toolUsed,visionUsed:!!imageUrl};
}

// A stateless inference smoke-test: uses saved Ollama connection, never writes to chat memory or Zalo.
export async function testAIInference():Promise<{model:string;answer:string;durationMs:number}>{
 const connection=await getConnection('ollama');
 if(!connection.url)throw Error('Chưa cấu hình Ollama. Vào Modules → Ollama để kiểm tra & lưu kết nối.');
 const started=Date.now();
 const response=await fetch(endpoint(connection.url,'api/chat'),{
  method:'POST',
  headers:{'content-type':'application/json',...headers(connection)},
  body:JSON.stringify({model:connection.model,stream:false,messages:[{role:'user',content:'Trả lời đúng một từ: OK'}],options:{temperature:0,num_predict:24}}),
  signal:AbortSignal.timeout(Math.min((await refreshRuntime()).aiTimeoutMs,60000)),
  redirect:'error'
 });
 if(!response.ok)throw Error('Ollama HTTP '+response.status);
 const data=await response.json() as {message?:{content?:string}};
 const answer=String(data.message?.content||'').trim();
 if(!answer)throw Error('Model không trả về nội dung hợp lệ');
 return {model:connection.model,answer:plainText(answer).slice(0,350),durationMs:Date.now()-started};
}
