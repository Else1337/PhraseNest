import { redirect } from "next/navigation";
import { getCurrentAdmin } from "@/lib/admin/session";
import { AdminWorkbench } from "@/components/admin/admin-workbench";
export const runtime="nodejs";
export default async function AdminPage(){const admin=await getCurrentAdmin();if(!admin)redirect("/admin/login");return <AdminWorkbench admin={admin}/>;}
