import { redirect } from "next/navigation";
import { TeacherDashboard } from "@/components/teacher/teacher-dashboard";
import { getCurrentTeacher } from "@/lib/auth/teacher-store";
import { getStudentsByIds } from "@/lib/auth/auth-store";
import { listTeacherClasses } from "@/lib/teacher/class-store";

export default async function TeacherPage() {
  const teacher = await getCurrentTeacher(); if (!teacher) redirect("/teacher/login");
  const classRecords = await listTeacherClasses(teacher.id);
  const students = await getStudentsByIds([...new Set(classRecords.flatMap((item) => item.studentIds))]);
  const classes = classRecords.map((item) => ({ id: item.id, name: item.name, joinCode: item.joinCode, students: item.studentIds.flatMap((id) => {const student=students.find(s=>s.id===id);return student?[student]:[];}) }));
  return <TeacherDashboard teacher={teacher} initialClasses={classes} />;
}
