import { redirect } from "next/navigation";
import { StudentAuthPanel } from "@/components/auth/student-auth-panel";
import { getCurrentStudent } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  if ("password" in query || "username" in query) redirect("/login");
  if (await getCurrentStudent()) redirect("/");
  return <StudentAuthPanel initialError={query.error === "credentials" ? "登录未完成，请核对账号密码后重试。" : query.error === "register" ? "注册未完成，请核对信息或使用已有账号登录。" : ""} />;
}
