import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { query } from './db.js';

export const runtimeSchema=z.object({
  publicOrigin:z.union([z.string().url(),z.literal('')]).default(''),
  zaloEnabled:z.boolean().default(false),
  aiEnabled:z.boolean().default(true),
  zaloDataDir:z.string().regex(/^\/[a-zA-Z0-9_\/.-]+$/).max(256).default('/app/data'),
  zaloSendDelayMs:z.number().int().min(1000).max(60000).default(1500),
  maxImageBytes:z.number().int().min(1024).max(16*1024*1024).default(8388608),
  maxContextMessages:z.number().int().min(1).max(30).default(10),
  aiConcurrency:z.number().int().min(1).max(10).default(2),
  aiMaxToolRounds:z.number().int().min(1).max(5).default(3),
  aiTimeoutMs:z.number().int().min(10000).max(600000).default(120000),
});
export type Runtime=z.infer<typeof runtimeSchema>;
const defaults:Runtime=runtimeSchema.parse({});
let cached:Runtime=defaults; let refreshAt=0;
export function runtime(){return cached;}
export async function loadRuntime(){
 const row=await query<{value:string}>("SELECT value FROM app_settings WHERE key='runtime'");
 cached=runtimeSchema.parse(row.rows[0]?JSON.parse(row.rows[0].value):{});
 refreshAt=Date.now()+5000;
 return cached;
}
export async function refreshRuntime(){if(Date.now()>refreshAt)await loadRuntime();return cached;}
export async function saveRuntime(input:unknown){
 const parsed=runtimeSchema.parse(input);
 await query("INSERT INTO app_settings(key,value) VALUES('runtime',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",[JSON.stringify(parsed)]);
 cached=parsed;refreshAt=Date.now()+5000;
 return parsed;
}
let masterKey:Buffer|null=null;
export async function initKey(){
 const res=await query<{value:string}>("SELECT value FROM app_settings WHERE key='crypto_salt'");
 let salt=res.rows[0]?.value;
 if(!salt){
  const candidate=crypto.randomBytes(32).toString('hex');
  const r=await query<{value:string}>("INSERT INTO app_settings(key,value) VALUES('crypto_salt',$1) ON CONFLICT(key) DO UPDATE SET value=app_settings.value RETURNING value",[candidate]);
  salt=r.rows[0].value;
 }
 // KDF keyed by DB URL credentials, with a unique per-installation salt.
 // Back up salt; rotating DB password requires re-encrypting credentials first.
 masterKey=Buffer.from(crypto.hkdfSync('sha256',Buffer.from(config.DATABASE_URL),Buffer.from(salt,'hex'),Buffer.from('semi-zalo-ai/v1'),32));
}
export function secretKey(){if(!masterKey)throw Error('Key not initialized');return masterKey;}
