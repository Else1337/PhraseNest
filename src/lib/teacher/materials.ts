import { createHash } from "node:crypto";
import { z } from "zod";
import { learnerDatabase } from "@/lib/learner/database";
import { listTeacherClasses,listStudentClasses } from "./class-store";
import { LibraryStore,libraryTerms,libraryTextVersion } from "@/lib/library/store";
import { documentMime,parseDocument } from "@/lib/library/parse";
import { readStoreBinary,writeStoreBinaryExclusive } from "@/lib/storage/file-store";
import type { LearningResource } from "@/lib/student/learning-resources";
import {runModelScope} from "@/lib/admin/model-scope";
export async function teacherMaterials(teacherId:string){return (await learnerDatabase()).query("SELECT id,teacher_id,document_id,version,title,class_ids,status,created_at,updated_at FROM lp_class_materials WHERE teacher_id=? ORDER BY updated_at DESC LIMIT 200",[teacherId]);}
export async function teacherMaterialDetail(teacherId:string,id:string){return (await (await learnerDatabase()).query("SELECT * FROM lp_class_materials WHERE teacher_id=? AND id=?",[teacherId,id]))[0]??null;}
export async function uploadTeacherMaterial(teacherId:string,bytes:Uint8Array,name:string,signal:AbortSignal){
  z.string().uuid().parse(teacherId);if(bytes.length>10*1024*1024||!bytes.length)throw new Error("FILE_SIZE");
  const hash=createHash("sha256").update(bytes).digest("hex"),db=await learnerDatabase(),existing=(await db.query("SELECT * FROM lp_class_materials WHERE teacher_id=? AND version=? LIMIT 1",[teacherId,hash]))[0];if(existing)return existing;
  const fingerprint=createHash("sha256").update(`${teacherId}:${hash}`).digest("hex"),id=`${fingerprint.slice(0,8)}-${fingerprint.slice(8,12)}-4${fingerprint.slice(13,16)}-a${fingerprint.slice(17,20)}-${fingerprint.slice(20,32)}`,key=`dialogue-uploads/${teacherId}/${id}.bin`;documentMime(bytes,name);const original=await readStoreBinary(key);if(!original)try{await writeStoreBinaryExclusive(key,Uint8Array.from(bytes));}catch(error){const won=await readStoreBinary(key);if(!won||createHash("sha256").update(won).digest("hex")!==hash)throw error;}
  // Text/PDF/Word parsing is deterministic; only scanned pages/images use the existing OCR provider.
  const now=new Date().toISOString();await db.query("INSERT INTO lp_class_materials(id,teacher_id,document_id,version,title,content,class_ids,status,created_at,updated_at) VALUES(?,?,?,?,?,'','[]','queued',?,?) ON CONFLICT(id) DO NOTHING",[id,teacherId,id,hash,name.slice(0,200),now,now]);return parseTeacherMaterial(teacherId,id,signal);
}
export async function parseTeacherMaterial(teacherId:string,id:string,signal:AbortSignal){
 const db=await learnerDatabase(),row=await teacherMaterialDetail(teacherId,id);if(!row)throw new Error("MATERIAL_NOT_FOUND");if(row.status==="draft"||row.status==="published")return row;
 const claimed=await db.query("UPDATE lp_class_materials SET status='processing',updated_at=? WHERE id=? AND teacher_id=? AND (status IN ('queued','failed') OR (status='processing' AND updated_at<?)) RETURNING id",[new Date().toISOString(),id,teacherId,new Date(Date.now()-130_000).toISOString()]);if(!claimed.length)return row;
 try{const bytes=await readStoreBinary(`dialogue-uploads/${teacherId}/${row.document_id}.bin`);if(!bytes)throw new Error("ORIGINAL_MISSING");const parsed=await parseDocument(bytes,documentMime(bytes,String(row.title)),signal,async(url,s)=>runModelScope({studentId:teacherId,surface:"teacher_ocr",guest:true},async()=>{const {recognizeLearningImage}=await import("@/lib/ai/learning-image");return (await recognizeLearningImage(url,s)).text;}));await db.query("UPDATE lp_class_materials SET content=?,status='draft',updated_at=? WHERE id=? AND teacher_id=?",[parsed.content,new Date().toISOString(),id,teacherId]);}
 catch(error){await db.query("UPDATE lp_class_materials SET status='failed',updated_at=? WHERE id=? AND teacher_id=?",[new Date().toISOString(),id,teacherId]);console.warn("[teacher-material-parse-pending]",{type:error instanceof Error?error.name:"unknown"});}
 return (await teacherMaterialDetail(teacherId,id))!;
}
export async function publishTeacherMaterial(teacherId:string,id:string,input:{title:string;content:string;classIds:string[];publish:boolean}){
  const db=await learnerDatabase(),material=(await db.query("SELECT * FROM lp_class_materials WHERE id=? AND teacher_id=?",[id,teacherId]))[0];if(!material)throw new Error("MATERIAL_NOT_FOUND");
  const classes=await listTeacherClasses(teacherId);if(input.classIds.some(id=>!classes.some(c=>c.id===id)))throw new Error("CLASS_FORBIDDEN");
  if(input.publish&&!input.classIds.length)throw new Error("CHOOSE_CLASS");
  if(input.publish)await new LibraryStore(db).register(teacherId,{id:`class-source:${id}`,title:input.title,content:input.content,role:"教师校本资料（参考材料，非学生原错）",kind:"document",sourceFileId:String(material.document_id)});
  await db.query("UPDATE lp_class_materials SET title=?,content=?,class_ids=?,status=?,updated_at=? WHERE id=? AND teacher_id=?",[input.title,input.content,JSON.stringify(input.classIds),input.publish?"published":"draft",new Date().toISOString(),id,teacherId]);
}
export async function publishedClassSources(studentId:string,options:{id?:string;metadataOnly?:boolean}={}):Promise<LearningResource[]>{
  const classes=await listStudentClasses(studentId);if(!classes.length)return [];
  const owners=[...new Set(classes.map(c=>c.teacherId))],db=await learnerDatabase();
  const rows=await db.query(`SELECT id,title,${options.metadataOnly?"'' AS content":"content"},class_ids FROM lp_class_materials WHERE status='published' AND teacher_id IN (${owners.map(()=>"?").join(",")}) ${options.id?"AND id=?":""} ORDER BY updated_at DESC LIMIT 500`,[...owners,...(options.id?[options.id.replace(/^class-source:/,"")]:[])]);
  return rows.filter(r=>z.array(z.string().uuid()).parse(JSON.parse(String(r.class_ids))).some(id=>classes.some(c=>c.id===id))).map(r=>({id:`class-source:${r.id}`,title:String(r.title),content:String(r.content),role:"教师校本资料（参考材料，非学生作答）",kind:"document",note:"由本班教师发布；引用用于教学，不作为学生错误证据。"}));
}
export async function searchClassSources(studentId:string,query:string,offset:number,kind?:string){
 if(kind&&kind!=="document")return {results:[],nextOffset:null};const sources=await publishedClassSources(studentId,{metadataOnly:true});if(!sources.length)return {results:[],nextOffset:null};
 const terms=libraryTerms(query).slice(0,12),db=await learnerDatabase();
 const match=terms.length?`AND EXISTS (SELECT 1 FROM lib_terms t WHERE t.student_id=d.student_id AND t.document_id=d.id AND t.version=b.version AND t.ordinal=b.ordinal AND t.term IN (${terms.map(()=>"?").join(",")}))`:"";
 const rows=await db.query(`SELECT d.source_id,d.title,d.role,b.version,b.start_line,b.end_line,b.content,p.content AS original FROM lib_documents d JOIN lib_blocks b ON b.student_id=d.student_id AND b.document_id=d.id AND b.version=d.current_version JOIN lp_class_materials p ON p.teacher_id=d.student_id AND d.source_id='class-source:' || p.id WHERE p.status='published' AND d.source_id IN (${sources.map(()=>"?").join(",")}) ${match} ORDER BY p.updated_at DESC,d.source_id,b.start_line LIMIT 6 OFFSET ?`,[...sources.map(s=>s.id),...terms,offset]);
 return {results:rows.slice(0,5).filter(r=>libraryTextVersion({title:String(r.title),role:String(r.role),content:String(r.original)})===r.version).map(r=>({id:String(r.source_id),title:r.title,role:r.role,kind:"document",startLine:Number(r.start_line),endLine:Number(r.end_line),snippet:String(r.content).slice(0,900),note:"教师校本资料，非学生原错"})),nextOffset:rows.length>5?offset+5:null};
}
export async function teacherMaterialOriginal(teacherId:string,id:string){const row=(await teacherMaterials(teacherId)).find(r=>r.id===id);return row?readStoreBinary(`dialogue-uploads/${teacherId}/${row.document_id}.bin`):null;}
