declare module 'zca-js' {
 export const ThreadType: { User: number; Group: number };
 export const LoginQRCallbackEventType: { QRCodeGenerated: number; QRCodeExpired: number; QRCodeDeclined: number; GotLoginInfo: number };
 export class Zalo {
  constructor(options?:{selfListen?:boolean;checkUpdate?:boolean});
  login(session:unknown):Promise<ZaloAPI>;
  loginQR(options:Record<string,unknown>, cb:(event:any)=>void):Promise<ZaloAPI>;
 }
 export interface ZaloAPI {
  listener:{on(name:string,callback:(event:any)=>void):void;start():void;stop?():void};
  sendMessage(message:{msg:string},threadId:string,threadType:number):Promise<unknown>;
 }
}
