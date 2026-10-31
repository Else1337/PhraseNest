"use client";

import { type FormEvent, useState } from "react";

type Teacher = { id: string; email: string; displayName: string; status: "pending" | "approved" | "rejected"; createdAt: string };
export function TeacherApproval() {
  const [code, setCode] = useState(""); const [teachers, setTeachers] = useState<Teacher[]>([]); const [error, setError] = useState("");
  async function load(event?: FormEvent) { event?.preventDefault(); const response = await fetch("/api/admin/teachers", { headers: { "x-admin-code": code } }); const body = await response.json() as { teachers?: Teacher[]; error?: string }; if (!response.ok) return setError(body.error ?? "读取失败"); setTeachers(body.teachers ?? []); setError(""); }
  async function review(id: string, status: "approved" | "rejected") { const response = await fetch("/api/admin/teachers", { method: "POST", headers: { "Content-Type": "application/json", "x-admin-code": code }, body: JSON.stringify({ teacherId: id, status }) }); if (!response.ok) return setError("审批失败"); await load(); }
  return <main className="admin-shell"><section><p className="kicker">管理员</p><h1>教师账号审批</h1><form onSubmit={load}><label><span>管理员口令</span><input type="password" value={code} onChange={(event) => setCode(event.target.value)} required /></label><button className="dark-button">读取申请</button></form>{error && <p className="auth-error">{error}</p>}<div className="approval-list">{teachers.map((teacher) => <article key={teacher.id}><div><span>{teacher.status}</span><strong>{teacher.displayName}</strong><small>{teacher.email}</small></div><footer><button type="button" onClick={() => void review(teacher.id, "rejected")}>拒绝</button><button type="button" onClick={() => void review(teacher.id, "approved")}>批准</button></footer></article>)}</div></section></main>;
}
