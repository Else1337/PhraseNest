import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";

export const ADMIN_COOKIE = "phrasenest_admin_session";
export const ADMIN_SESSION_SECONDS = 8 * 3600;
const derive = promisify(scrypt);
const account = z.object({id:z.string().uuid(),username:z.string(),displayName:z.string(),salt:z.string(),hash:z.string(),createdAt:z.string()});
const schema = z.object({version:z.literal(1),accounts:z.array(account).max(10),sessions:z.array(z.object({hash:z.string(),adminId:z.string(),until:z.number()}))});
type State=z.infer<typeof schema>;
export type PublicAdmin=Pick<z.infer<typeof account>,"id"|"username"|"displayName">;
const key="admin/auth-v1.json";
const parse=(raw:string|null):State=>raw===null?{version:1,accounts:[],sessions:[]}:schema.parse(JSON.parse(raw));
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
const same=(a:string,b:string)=>timingSafeEqual(Buffer.from(sha(a),"hex"),Buffer.from(sha(b),"hex"));
const publicAccount=(a:z.infer<typeof account>):PublicAdmin=>({id:a.id,username:a.username,displayName:a.displayName});
async function mutate<T>(fn:(state:State)=>T){return mutateStoreText(key,raw=>{const s=parse(raw),result=fn(s);return {text:JSON.stringify(schema.parse(s)),result};});}
export const adminCredentials=z.object({username:z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/),password:z.string().min(10).max(128)});
export async function adminSetupRequired(){return !(await readStoreText(key).then(parse)).accounts.length;}
export async function bootstrapAdmin(input:unknown){
  const data=adminCredentials.extend({bootstrapCode:z.string().min(1).max(256),displayName:z.string().trim().min(1).max(40)}).parse(input);
  const code=process.env.ADMIN_BOOTSTRAP_CODE||process.env.ADMIN_APPROVAL_CODE;
  if(!code||!same(code,data.bootstrapCode))throw new Error("ADMIN_BOOTSTRAP_DENIED");
  const salt=randomBytes(16).toString("hex"),hash=((await derive(data.password,salt,64)) as Buffer).toString("hex");
  return mutate(s=>{if(s.accounts.length)throw new Error("ADMIN_ALREADY_INITIALIZED");const a={id:randomUUID(),username:data.username,displayName:data.displayName,salt,hash,createdAt:new Date().toISOString()};s.accounts.push(a);return publicAccount(a);});
}
export async function authenticateAdmin(input:unknown){
  const data=adminCredentials.parse(input),s=parse(await readStoreText(key)),a=s.accounts.find(a=>a.username===data.username);
  const hash=((await derive(data.password,a?.salt||"missing-admin-salt",64)) as Buffer).toString("hex");
  if(!a||!same(a.hash,hash))throw new Error("ADMIN_LOGIN_DENIED");return publicAccount(a);
}
export async function createAdminSession(adminId:string){const token=randomBytes(32).toString("base64url"),until=Date.now()+ADMIN_SESSION_SECONDS*1000;await mutate(s=>{if(!s.accounts.some(a=>a.id===adminId))throw new Error("ADMIN_NOT_FOUND");s.sessions=[...s.sessions.filter(t=>t.until>Date.now()&&t.adminId!==adminId),{hash:sha(token),adminId,until}];});return {token,until};}
export async function adminByToken(token:string){if(token.length>256)return null;const s=parse(await readStoreText(key)),t=s.sessions.find(t=>t.hash===sha(token)&&t.until>Date.now()),a=t&&s.accounts.find(a=>a.id===t.adminId);return a?publicAccount(a):null;}
export async function revokeAdminSession(token:string){await mutate(s=>{s.sessions=s.sessions.filter(t=>t.hash!==sha(token));});}
