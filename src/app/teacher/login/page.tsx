import { redirect } from "next/navigation";
import { TeacherAuthPanel } from "@/components/auth/teacher-auth-panel";
import { getCurrentTeacher } from "@/lib/auth/teacher-store";

export default async function TeacherLoginPage() { if (await getCurrentTeacher()) redirect("/teacher"); return <TeacherAuthPanel />; }
