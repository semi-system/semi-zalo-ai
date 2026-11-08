import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { secretKey, runtime } from './runtime.js';
const COOKIE='semi_session';
function sign(s:string){return crypto.createHmac('sha256',secretKey()).update(s).digest('base64url');}
export function issueSession(user:string){const payload=Buffer.from(JSON.stringify({user,exp:Date.now()+7*86400000})).toString('base64url');return payload+'.'+sign(payload);}
export function validateSession(req:FastifyRequest){
 const token=req.cookies?.[COOKIE];if(!token)return null;
 const [payload,sig]=token.split('.');if(!payload||!sig)return null;
 const expected=Buffer.from(sign(payload));const actual=Buffer.from(sig);
 if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected))return null;
 try{const x=JSON.parse(Buffer.from(payload,'base64url').toString());return x.exp>Date.now()&&typeof x.user==='string'?x.user:null;}catch{return null;}
}
export const cookieName=COOKIE;
export function verifyOrigin(req:FastifyRequest){
 if(['GET','HEAD','OPTIONS'].includes(req.method))return true;
 const origin=req.headers.origin;
 if(!origin) return !req.headers.cookie; // deny cookie-authenticated state changes without Origin
 const configured=runtime().publicOrigin;
 if(configured)return origin===new URL(configured).origin;
 // First-run only: compare Origin against the browser-visible forwarded host.
 const forwarded=String(req.headers['x-forwarded-host']||'').split(',')[0].trim();
 const host=forwarded||String(req.headers.host||'');
 try{return new URL(origin).host===host;}catch{return false;}
}
