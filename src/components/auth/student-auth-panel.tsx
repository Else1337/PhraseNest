"use client";

import { FormEvent, useState } from "react";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
import { brand } from "@/lib/brand";

export function StudentAuthPanel({ initialError = "" }: { initialError?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
    const response = await fetch(mode === "login" ? "/api/auth/login" : "/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
        ...(mode === "register" ? { displayName: form.get("displayName") } : {})
      })
    });
    await readWorkspaceJson(response);
    // A fresh document avoids reusing a pre-login server-component cache.
    window.location.replace("/");
    } catch (error) { setError(error instanceof Error && error.name === "TimeoutError" ? "连接较慢，请稍后重试，账号信息已保留。" : error instanceof Error ? error.message : "登录失败，请重试。"); }
    finally { setBusy(false); }
  }

  return <main className="auth-shell">
    <section className="auth-brand-panel">
      <div className="auth-brand">拾</div>
      <div><p className="kicker">{brand.title}</p><h1>把作文变成学习</h1></div>
      <div className="auth-line-art" aria-hidden="true"><i /><b /><span /></div>
    </section>
    <section className="auth-form-panel">
      <div className="auth-form-wrap">
        <h2>{mode === "login" ? "登录" : "注册"}</h2>
        <div className="auth-tabs" role="tablist" aria-label="登录方式">
          <button type="button" role="tab" aria-selected={mode === "login"} className={mode === "login" ? "selected" : ""} onClick={() => { setMode("login"); setError(""); }}>登录</button>
          <button type="button" role="tab" aria-selected={mode === "register"} className={mode === "register" ? "selected" : ""} onClick={() => { setMode("register"); setError(""); }}>首次注册</button>
        </div>
        <form method="post" action={mode === "login" ? "/api/auth/login" : "/api/auth/register"} onSubmit={submit}>
          {mode === "register" && <label><span>怎么称呼你</span><input name="displayName" autoComplete="name" maxLength={30} required placeholder="例如：林同学" /></label>}
          <label><span>用户名</span><input name="username" autoComplete="username" minLength={3} maxLength={30} pattern="[a-z0-9_]+" required placeholder="3 到 30 位小写字母、数字或下划线" /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required placeholder={mode === "login" ? "输入密码" : "至少 8 位"} /></label>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <button type="submit" className="dark-button" disabled={busy}>{busy ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}</button>
        </form>
        <p><a href="/activate">老师已为你创建账号？使用激活码</a></p>
      </div>
    </section>
  </main>;
}
