import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/session";
import { adminSetupRequired } from "@/lib/admin/auth";
import { AdminLogin } from "@/components/admin/admin-login";
export const runtime="nodejs";
export default async function AdminLoginPage(){if(await getCurrentAdmin())redirect("/admin");return <AdminLogin setupRequired={await adminSetupRequired()}/>;}
