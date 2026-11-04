import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/session";
export default async function AdminTeachersPage(){redirect(await getCurrentAdmin()?"/admin":"/admin/login");}
