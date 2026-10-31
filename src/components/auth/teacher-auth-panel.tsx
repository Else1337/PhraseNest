"use client";

import { type FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function TeacherAuthPanel() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/auth/teacher/${mode}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: form.get("email"), password: form.get("password"), ...(mode === "register" ? { displayName: form.get("displayName") } : {}) }) });
      const body = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(body.error ?? "操作失败");
      if (mode === "register") { setMessage(body.message ?? "申请已提交"); setMode("login"); }
      else { router.replace("/teacher"); router.refresh(); }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); }
    finally { setBusy(false); }
  }
  return <main className="teacher-auth"><section><p className="kicker">拾语 PhraseNest</p><h1>教师端</h1></section><section><div className="auth-tabs"><button type="button" className={mode === "login" ? "selected" : ""} onClick={() => setMode("login")}>登录</button><button type="button" className={mode === "register" ? "selected" : ""} onClick={() => setMode("register")}>申请账号</button></div><form onSubmit={submit}>{mode === "register" && <label><span>教师姓名</span><input name="displayName" required maxLength={40} /></label>}<label><span>邮箱</span><input name="email" type="email" autoComplete="email" required /></label><label><span>密码</span><input name="password" type="password" minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} required /></label>{message && <p className="auth-success">{message}</p>}{error && <p className="auth-error" role="alert">{error}</p>}<button className="dark-button" disabled={busy}>{busy ? "请稍候" : mode === "login" ? "登录" : "提交申请"}</button></form><a href="/login">学生端</a></section></main>;
}
