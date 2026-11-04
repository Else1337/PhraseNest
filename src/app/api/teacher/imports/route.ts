// Historical batches and activation records remain stored. Provisioning is admin-only.
export async function GET(){return Response.json({error:"账号导入已移至管理员后台"},{status:403});}
export async function POST(){return Response.json({error:"请联系管理员批量加入学生；教师端不再创建账号"},{status:403});}
