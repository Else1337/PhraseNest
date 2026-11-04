"use client";
import { useState,type FormEvent } from "react";
import { useRouter } from "next/navigation";
import styles from "./admin.module.css";
export function AdminLogin({setupRequired}:{setupRequired:boolean}){
  const router=useRouter(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();const data=Object.fromEntries(new FormData(e.currentTarget));setBusy(true);setError("");try{const r=await fetch("/api/admin/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...data,action:setupRequired?"bootstrap":"login"})}),body=await r.json();if(!r.ok)throw Error(body.error??"登录未完成");router.replace("/admin");router.refresh();}catch(error){setError(error instanceof Error?error.message:"登录未完成");}finally{setBusy(false);}}
  return <main className={styles.login}><a href="/login">拾语 / PhraseNest</a><h1>{setupRequired?"建立管理工作台":"欢迎回来"}</h1><p>管理员登录 · 与教师、学生身份独立</p><form onSubmit={submit}>{setupRequired&&<><label>初始化口令<input name="bootstrapCode" type="password" autoComplete="off" required/></label><label>显示名称<input name="displayName" required maxLength={40}/></label></>}<label>管理员账号<input name="username" required minLength={3} maxLength={30} autoComplete="username"/></label><label>密码<input name="password" type="password" required minLength={10} autoComplete={setupRequired?"new-password":"current-password"}/></label><button disabled={busy}>{busy?"正在验证…":setupRequired?"创建管理员":"进入工作台"}</button>{error&&<p role="alert" className={styles.error}>{error}</p>}</form></main>;
}
