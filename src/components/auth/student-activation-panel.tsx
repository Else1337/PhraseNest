"use client";
import { MiaGuideProvider, MiaGuide, MiaReplay } from "@/components/onboarding/mia-guide";
import {useState,type FormEvent} from "react";
import {brand} from "@/lib/brand";
export function StudentActivationPanel(){ return <MiaGuideProvider scope="guest"><ActivationContent /></MiaGuideProvider>; }
function ActivationContent(){
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError("");const form=new FormData(event.currentTarget);
    try{const response=await fetch("/api/auth/activate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.fromEntries(form)),signal:AbortSignal.timeout(30_000)}),body=await response.json();if(!response.ok)throw Error(body.error??"激活未完成");window.location.replace("/");}catch(error){setError(error instanceof Error?error.message:"暂时无法激活");setBusy(false);}}
  return <main className="auth-shell"><section className="auth-brand-panel"><div className="auth-brand">拾</div><div><p className="kicker">{brand.title}</p><h1>从这里，开始积累</h1></div></section><section className="auth-form-panel"><div className="auth-form-wrap"><h2>激活学习账号</h2><p>使用老师发给你的用户名和一次性激活码，设置自己的密码。</p><MiaGuide id="activation" paused={busy} /><MiaReplay id="activation">Mia 带你看看</MiaReplay><form data-mia-anchor="activation-form" onSubmit={submit}><label><span>用户名</span><input name="username" autoComplete="username" required minLength={3} maxLength={30}/></label><label><span>激活码</span><input name="code" autoComplete="one-time-code" required minLength={24} maxLength={24}/></label><label><span>设置密码</span><input name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128}/></label>{error&&<p role="alert" className="auth-error">{error}</p>}<button className="dark-button" disabled={busy}>{busy?"正在激活…":"激活并登录"}</button></form><p><a href="/login">已有账号，返回登录</a></p></div></section></main>;
}
