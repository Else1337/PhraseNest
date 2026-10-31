import { redirect } from "next/navigation";
import { getCurrentStudent } from "@/lib/auth/session";
import { DialogueWorkspaceApp, type WorkspacePage } from "./dialogue-workspace";

export async function StudentWorkspacePage({ page }: { page: WorkspacePage }) {
  const student = await getCurrentStudent();
  if (!student) redirect("/login");
  return <DialogueWorkspaceApp displayName={student.displayName} page={page} />;
}
