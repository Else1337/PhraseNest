import { cookies } from "next/headers";
import { ADMIN_COOKIE, adminByToken } from "./auth";
import { RequestSafetyError } from "@/lib/security/request-safety";
export async function getCurrentAdmin(){const token=(await cookies()).get(ADMIN_COOKIE)?.value;return token?adminByToken(token):null;}
export async function requireAdmin(){const admin=await getCurrentAdmin();if(!admin)throw new RequestSafetyError(401,"请先登录管理员账号");return admin;}
