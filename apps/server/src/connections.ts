import crypto from 'node:crypto';
import { z } from 'zod';
import { secretKey } from './runtime.js';
import { query } from './db.js';

const inputSchema=z.object({
 provider:z.enum(['ollama','searxng']),
 url:z.string().trim().min(8).max(512),
 authType:z.enum(['none','bearer','basic']).default('none'),
 apiKey:z.string().max(4096).optional(),
 username:z.string().max(256).optional(),
 password:z.string().max(4096).optional(),
 clearCredentials:z.boolean().optional(),
 model:z.string().trim().min(1).max(128).optional(),
 visionModel:z.string().trim().min(1).max(128).optional(),
 results:z.number().int().min(1).max(10).optional(),
});
export type ConnectionInput=z.infer<typeof inputSchema>;
type Credential={apiKey?:string;username?:string;password?:string};
export type Connection={provider:'ollama'|'searxng';url:string;authType:'none'|'bearer'|'basic';model:string;visionModel:string;results:number;credential:Credential};
const defaults:Record<string,()=>Connection>={
 ollama:()=>({provider:'ollama',url:'',authType:'none',model:'gemma4:31b',visionModel:'gemma4:31b',results:5,credential:{}}),
 searxng:()=>({provider:'searxng',url:'',authType:'none',model:'',visionModel:'',results:5,credential:{}})
};
function key(){return secretKey();}
function encrypt(v:Credential){const nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key(),nonce);const encrypted=Buffer.concat([cipher.update(JSON.stringify(v),'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),encrypted]).toString('base64');}
function decrypt(v:string|null):Credential{if(!v)return {};const buf=Buffer.from(v,'base64');if(buf.length<29)throw Error('Invalid encrypted credential');const decipher=crypto.createDecipheriv('aes-256-gcm',key(),buf.subarray(0,12));decipher.setAuthTag(buf.subarray(12,28));return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString('utf8')) as Credential;}
export function validateUrl(raw:string){let u:URL;try{u=new URL(raw)}catch{throw Error('URL không hợp lệ');}if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.search||u.hash)throw Error('Chỉ hỗ trợ http(s) URL không chứa userinfo, query hoặc fragment');if(/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(u.hostname))throw Error('Không dùng localhost cho provider trong production; dùng DNS của container');return u.toString().replace(/\/$/,'');}
export function endpoint(base:string,path:string){return base.replace(/\/$/,'')+'/'+path.replace(/^\//,'');}
export function headers(c:Connection){const h:Record<string,string>={};if(c.authType==='bearer'){if(!c.credential.apiKey)throw Error('Thiếu API key');h.Authorization='Bearer '+c.credential.apiKey;}else if(c.authType==='basic'){if(!c.credential.username||!c.credential.password)throw Error('Thiếu username/password');h.Authorization='Basic '+Buffer.from(c.credential.username+':'+c.credential.password).toString('base64');}return h;}
export async function getConnection(provider:'ollama'|'searxng'):Promise<Connection>{
 const r=await query<{url:string;auth_type:'none'|'bearer'|'basic';model:string|null;vision_model:string|null;results:number|null;credential_ciphertext:string|null}>('SELECT url,auth_type,model,vision_model,results,credential_ciphertext FROM app_connections WHERE provider=$1',[provider]);
 if(!r.rows[0])return defaults[provider]();const x=r.rows[0];const d=defaults[provider]();return {...d,url:x.url,authType:x.auth_type,model:x.model??d.model,visionModel:x.vision_model??d.visionModel,results:x.results??d.results,credential:decrypt(x.credential_ciphertext)};
}
export async function listConnections(){const c=await Promise.all([getConnection('ollama'),getConnection('searxng')]);return c.map(x=>({provider:x.provider,url:x.url,authType:x.authType,model:x.model,visionModel:x.visionModel,results:x.results,hasCredentials:!!(x.credential.apiKey||x.credential.password)}));}
export async function resolveInput(value:unknown):Promise<Connection>{
 const x=inputSchema.parse(value);const old=await getConnection(x.provider);const authType=x.authType;
 const credential:Credential=x.clearCredentials||authType!==old.authType?{}:{...old.credential};
 if(authType==='bearer'&&x.apiKey)credential.apiKey=x.apiKey;
 if(authType==='basic'){if(x.username)credential.username=x.username;if(x.password)credential.password=x.password;}
 if(authType==='none')Object.keys(credential).forEach(k=>delete (credential as Record<string,unknown>)[k]);
 const next:Connection={...old,url:validateUrl(x.url),authType,credential,model:x.model??old.model,visionModel:x.visionModel??old.visionModel,results:x.results??old.results};
 headers(next); // Assert credentials match selected auth method.
 return next;
}
export async function testConnection(c:Connection){
 const signal=AbortSignal.timeout(8000);
 if(c.provider==='ollama'){
  const res=await fetch(endpoint(c.url,'api/tags'),{headers:headers(c),signal,redirect:'error'});
  if(!res.ok)throw Error('Ollama trả HTTP '+res.status);
  const json=await res.json() as {models?:Array<{name?:string;model?:string}>};
  if(!Array.isArray(json.models))throw Error('Ollama API không trả về danh sách models');
  const names=json.models.map(x=>x.name||x.model||'').filter(Boolean);
  return {ok:true,detail:'Đã kết nối Ollama API',models:names,modelAvailable:names.includes(c.model),visionModelAvailable:names.includes(c.visionModel)};
 }
 const url=new URL(endpoint(c.url,'search'));url.searchParams.set('q','SearXNG connectivity check');url.searchParams.set('format','json');
 const res=await fetch(url,{headers:headers(c),signal,redirect:'error'});
 if(!res.ok)throw Error('SearXNG trả HTTP '+res.status);
 const json=await res.json() as {results?:unknown[]};
 if(!Array.isArray(json.results))throw Error('SearXNG chưa bật JSON search hoặc trả về JSON không hợp lệ');
 return {ok:true,detail:'SearXNG JSON search hoạt động',resultCount:json.results.length};
}
export async function storeConnection(c:Connection){await query(`INSERT INTO app_connections(provider,url,auth_type,model,vision_model,results,credential_ciphertext,tested_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(provider) DO UPDATE SET
 url=excluded.url,auth_type=excluded.auth_type,model=excluded.model,vision_model=excluded.vision_model,results=excluded.results,credential_ciphertext=excluded.credential_ciphertext,tested_at=now(),updated_at=now()`,[c.provider,c.url,c.authType,c.model||null,c.visionModel||null,c.results,encrypt(c.credential)]);}
