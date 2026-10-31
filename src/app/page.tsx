import { DialogueWorkspaceApp } from "@/components/student/dialogue-workspace";
import { getCurrentStudent } from "@/lib/auth/session";
import { redirect } from "next/navigation";
export const dynamic = "force-dynamic";

export default async function StudentHome() {
  const student = await getCurrentStudent();
  if (!student) redirect("/login");
  // Navigation must not wait for automatic course generation or AI calls.
  return <DialogueWorkspaceApp displayName={student.displayName} />;
}
