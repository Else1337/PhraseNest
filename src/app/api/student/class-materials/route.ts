import { getCurrentStudent } from "@/lib/auth/session";
import { publishedClassSources } from "@/lib/teacher/materials";
export async function GET(){const student=await getCurrentStudent();if(!student)return Response.json({error:"请先登录"},{status:401});return Response.json({items:(await publishedClassSources(student.id,{metadataOnly:true})).map(({id,title,role,note})=>({id,title,role,note}))},{headers:{"Cache-Control":"private, no-store"}});}
