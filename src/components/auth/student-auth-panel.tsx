"use client";

import { FormEvent, useState } from "react";
import { readWorkspaceJson } from "@/lib/student/workspace-client";
import { brand } from "@/lib/brand";
import { PhraseMark } from "@/components/brand/phrase-mark";
import styles from "./student-auth-panel.module.css";

export function StudentAuthPanel({ initialError = "" }: { initialError?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [guestBusy, setGuestBusy] = useState(false);
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

  return <main className={styles.entry}>
    <section className={styles.content} aria-labelledby="auth-heading">
        <header className={styles.header}>
          <PhraseMark className={styles.mark} />
          <p className={styles.wordmark} aria-label={brand.title}><strong>{brand.name}</strong><span>{brand.englishName}</span></p>
          <h1 id="auth-heading">从这里，继续积累。</h1>
          <p className={styles.subtitle}>{mode === "login" ? "登录你的拾语账号" : "建立你的学习空间"}</p>
        </header>
        <div className={styles.tabs} role="tablist" aria-label="登录方式">
          <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>登录</button>
          <button type="button" role="tab" aria-selected={mode === "register"} onClick={() => { setMode("register"); setError(""); }}>首次注册</button>
        </div>
        <form className={styles.form} method="post" action={mode === "login" ? "/api/auth/login" : "/api/auth/register"} onSubmit={submit}>
          {mode === "register" && <label><span>怎么称呼你</span><input name="displayName" autoComplete="name" maxLength={30} required placeholder="例如：林同学" /></label>}
          <label><span>用户名</span><input name="username" autoComplete="username" minLength={3} maxLength={30} pattern="[a-z0-9_]+" required placeholder={mode === "login" ? "输入用户名" : "3 到 30 位小写字母、数字或下划线"} /></label>
          <label><span>密码</span><input name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required placeholder={mode === "login" ? "输入密码" : "至少 8 位"} /></label>
          {error && <div className={styles.error} role="alert">{error}</div>}
          <button type="submit" className={styles.primary} disabled={busy || guestBusy}>{busy ? "请稍候…" : mode === "login" ? "登录" : "创建账号"}</button>
        </form>
        <div className={styles.divider} aria-hidden="true"><span>或先看看</span></div>
        <form method="post" action="/api/auth/guest" className={styles.guest} onSubmit={async event => {
          event.preventDefault(); setGuestBusy(true); setError("");
          try {
            await readWorkspaceJson(await fetch("/api/auth/guest", { method: "POST", signal: AbortSignal.timeout(180_000) }));
            window.location.replace("/");
          } catch (error) { setError(error instanceof Error && error.name === "TimeoutError" ? "体验资料准备较慢，请稍后重试。" : error instanceof Error ? error.message : "暂时无法进入体验，请重试。"); }
          finally { setGuestBusy(false); }
        }}>
          <button type="submit" className={styles.secondary} disabled={busy || guestBusy}>{guestBusy ? "正在准备你的体验空间…" : "游客体验"}</button>
        </form>
        <p className={`auth-activation ${styles.activation}`}><a href="/activate">老师已为你创建账号？使用激活码</a></p>
    </section>
  </main>;
}
