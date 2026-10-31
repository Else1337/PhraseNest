import {createHash,createHmac,randomBytes,randomUUID} from "node:crypto";
import {z} from "zod";
import {mutateStoreText,readStoreText} from "@/lib/storage/file-store";
import {pendingClassActivations,provisionClassStudent,studentAccountAvailability} from "@/lib/auth/auth-store";
import {listTeacherClasses,joinClass} from "./class-store";

export class StudentImportError extends Error {constructor(readonly status:number,message:string){super(message);}}
const rowSchema=z.object({line:z.number().int(),username:z.string(),displayName:z.string(),status:z.enum(["pending","created","existing","failed"]),message:z.string(),studentId:z.string().uuid().nullable()});
const batchSchema=z.object({version:z.literal(1),id:z.string().uuid(),teacherId:z.string().uuid(),classId:z.string().uuid(),secret:z.string(),expiresAt:z.string().datetime(),createdAt:z.string().datetime(),rows:z.array(rowSchema).max(200),lease:z.object({token:z.string(),until:z.number()}).nullable()});
type Batch=z.infer<typeof batchSchema>;
const indexSchema=z.array(z.object({id:z.string().uuid(),classId:z.string().uuid(),createdAt:z.string().datetime()})).max(100);
const indexKey=(teacher:string)=>`teacher-imports/${z.string().uuid().parse(teacher)}/index.json`;
const key=(teacher:string,id:string)=>`teacher-imports/${z.string().uuid().parse(teacher)}/${z.string().uuid().parse(id)}.json`;
async function ownedClass(teacher:string,id:string){const result=(await listTeacherClasses(teacher)).find(c=>c.id===id);if(!result)throw new StudentImportError(403,"无权操作这个班级");return result;}
export function parseStudentCsv(text:string){
  if(Buffer.byteLength(text)>128_000)throw new StudentImportError(413,"名单过大，请分批导入");
  const rows:string[][]=[];let row:string[]=[],field="",quoted=false;
  for(let n=0;n<text.length;n++){
    const c=text[n];if(c==='"'){if(quoted&&text[n+1]==='"'){field+='"';n++;}else if(quoted||field==='')quoted=!quoted;else throw new StudentImportError(400,"CSV 引号格式不正确");}
    else if(c===','&&!quoted){row.push(field);field="";}
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[n+1]==='\n')n++;row.push(field);if(row.some(v=>v.trim()))rows.push(row);row=[];field="";}
    else field+=c;
  }
  if(quoted)throw new StudentImportError(400,"CSV 引号没有闭合");row.push(field);if(row.some(v=>v.trim()))rows.push(row);
  const header=rows.shift()?.map(v=>v.replace(/^\uFEFF/,"").trim().toLowerCase())??[];
  const user=header.findIndex(v=>["username","用户名","学号"].includes(v)),name=header.findIndex(v=>["displayname","name","姓名"].includes(v));
  if(user<0||name<0||user===name)throw new StudentImportError(400,"CSV 需要“用户名,姓名”两列");
  if(!rows.length||rows.length>200)throw new StudentImportError(400,"每批需要 1 到 200 名学生");
  const seen=new Set<string>();
  return rows.map((r,index)=>{const username=(r[user]??"").trim().toLowerCase(),displayName=(r[name]??"").trim();let error="";
    if(!/^[a-z0-9_]{3,30}$/.test(username))error="用户名需为 3–30 位小写字母、数字或下划线";
    else if(!displayName||displayName.length>30)error="姓名需为 1–30 字";
    else if(seen.has(username))error="本批用户名重复";
    if(r.length!==header.length)error="列数与表头不一致";seen.add(username);
    return {line:index+2,username,displayName,error};
  });
}
export async function previewStudentImport(teacher:string,classId:string,csv:string){
  await ownedClass(teacher,classId);const rows=parseStudentCsv(csv),availability=await studentAccountAvailability(rows.map(r=>r.username));
  return {rows:rows.map((r,index)=>({...r,exists:availability[index].exists})),total:rows.length};
}
function summary(batch:Batch){return {id:batch.id,classId:batch.classId,createdAt:batch.createdAt,expiresAt:batch.expiresAt,rows:batch.rows.map(({studentId,...row})=>({...row,studentId})),running:Boolean(batch.lease&&batch.lease.until>Date.now()),done:batch.rows.every(r=>r.status!=="pending"),created:batch.rows.filter(r=>r.status==="created").length};}
async function readBatch(teacher:string,id:string){const raw=await readStoreText(key(teacher,id));if(raw===null)throw new StudentImportError(404,"导入批次不存在");const batch=batchSchema.parse(JSON.parse(raw));if(batch.teacherId!==teacher||batch.id!==id)throw new StudentImportError(403,"无权读取该批次");await ownedClass(teacher,batch.classId);return batch;}
export async function startStudentImport(teacher:string,classId:string,id:string,csv:string){
  const preview=await previewStudentImport(teacher,classId,csv);if(preview.rows.some(r=>r.error))throw new StudentImportError(400,"请先修正名单中的错误");
  const secret=randomBytes(32).toString("hex"),stamp=new Date().toISOString();
  await mutateStoreText(key(teacher,id),raw=>{
    if(raw){const prior=batchSchema.parse(JSON.parse(raw));if(prior.classId!==classId||JSON.stringify(prior.rows.map(r=>[r.username,r.displayName]))!==JSON.stringify(preview.rows.map(r=>[r.username,r.displayName])))throw new StudentImportError(409,"批次编号已被不同名单使用");return {text:raw,result:true};}
    const batch:Batch={version:1,id,teacherId:teacher,classId,secret,createdAt:stamp,expiresAt:new Date(Date.now()+7*86400_000).toISOString(),lease:null,rows:preview.rows.map(r=>({line:r.line,username:r.username,displayName:r.displayName,status:r.exists?"existing":"pending",message:r.exists?"已有账号，未覆盖、未自动归班":"等待导入",studentId:null}))};
    return {text:JSON.stringify(batchSchema.parse(batch)),result:true};
  });const saved=await readBatch(teacher,id);
  await mutateStoreText(indexKey(teacher),text=>{const index=text===null?[]:indexSchema.parse(JSON.parse(text));const next=[...index.filter(r=>r.id!==id),{id,classId,createdAt:saved.createdAt}].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).slice(-100);return{text:JSON.stringify(next),result:true};});
  return summary(saved);
}
export async function recentStudentImports(teacher:string,classId:string){await ownedClass(teacher,classId);const text=await readStoreText(indexKey(teacher));const index=text===null?[]:indexSchema.parse(JSON.parse(text));return index.filter(r=>r.classId===classId).slice(-10).reverse();}
export async function studentImportStatus(teacher:string,id:string){return summary(await readBatch(teacher,id));}
const codeFor=(batch:Batch,row:Batch["rows"][number])=>createHmac("sha256",batch.secret).update(`${row.line}:${row.username}`).digest("hex").slice(0,24);
export async function runStudentImport(teacher:string,id:string){
  const batch=await readBatch(teacher,id),classroom=await ownedClass(teacher,batch.classId),token=randomUUID();
  if(new Date(batch.expiresAt).getTime()<=Date.now())throw new StudentImportError(410,"批次已过期，请联系管理员处理未激活账号");
  const claimed=await mutateStoreText(key(teacher,id),raw=>{if(!raw)throw new StudentImportError(404,"批次不存在");const b=batchSchema.parse(JSON.parse(raw));if(b.lease&&b.lease.until>Date.now())return{text:raw,result:false};b.lease={token,until:Date.now()+120_000};return{text:JSON.stringify(b),result:true};});
  if(!claimed)return;
  try{
    for(const row of batch.rows.filter(r=>r.status==="pending").slice(0,20)){
      let status:"created"|"existing"|"failed"="failed",message="本行未完成，可重试",studentId:string|null=null;
      try{const code=codeFor(batch,row),result=await provisionClassStudent({username:row.username,displayName:row.displayName,teacherId:teacher,classId:batch.classId,batchId:id,row:row.line,activationHash:createHash("sha256").update(row.username+":"+code).digest("hex"),expiresAt:batch.expiresAt});
        if(result.student){studentId=result.student.id;await joinClass(studentId,classroom.joinCode);status="created";message="已加入班级，等待学生激活";}
        else{status="existing";message="已有账号，未覆盖、未自动归班";}
      }catch(error){message=error instanceof Error&&error.message==="STUDENT_ACCOUNT_CAPACITY"?"账号存储已达当前容量，请先处理容量后重试":"本行未完成，可重试";}
      await mutateStoreText(key(teacher,id),raw=>{if(!raw)throw new StudentImportError(404,"批次不存在");const b=batchSchema.parse(JSON.parse(raw));if(b.lease?.token!==token||b.lease.until<=Date.now())throw new StudentImportError(409,"导入租约已过期，请重新读取");const saved=b.rows.find(r=>r.line===row.line)!;Object.assign(saved,{status,message,studentId});return{text:JSON.stringify(b),result:true};});
    }
  }finally{await mutateStoreText(key(teacher,id),raw=>{if(!raw)throw new StudentImportError(404,"批次不存在");const b=batchSchema.parse(JSON.parse(raw));if(b.lease?.token===token)b.lease=null;return{text:JSON.stringify(b),result:true};});}
}
export async function retryStudentImport(teacher:string,id:string){await readBatch(teacher,id);await mutateStoreText(key(teacher,id),raw=>{const b=batchSchema.parse(JSON.parse(raw!));if(b.lease&&b.lease.until>Date.now())throw new StudentImportError(409,"导入仍在进行");for(const row of b.rows)if(row.status==="failed"){row.status="pending";row.message="等待重试";}return{text:JSON.stringify(b),result:true};});}
export async function exportStudentActivations(teacher:string,id:string){const b=await readBatch(teacher,id);if(new Date(b.expiresAt).getTime()<=Date.now())throw new StudentImportError(410,"本批激活码已过期");
  const pending=await pendingClassActivations(teacher,id);
  const cell=(s:string)=>'"'+s.replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';
  return '\uFEFF用户名,姓名,一次性激活码,有效期\r\n'+b.rows.filter(r=>r.status==="created"&&r.studentId&&pending.has(r.studentId)).map(r=>[r.username,r.displayName,codeFor(b,r),b.expiresAt].map(cell).join(',')).join('\r\n');
}
