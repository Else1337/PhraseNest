"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import styles from "./teacher-workspace.module.css";
export function TeacherDialog({title,description,close,children,wide=false}:{title:string;description?:string;close:()=>void;children:ReactNode;wide?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null),id=useId(),descriptionId=useId();
  useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
  return <dialog ref={ref} className={styles.sheet} data-wide={wide} aria-labelledby={id} aria-describedby={description?descriptionId:undefined} onCancel={event=>{event.preventDefault();close();}} onClick={event=>{if(event.target===event.currentTarget)close();}}>
    <header className={styles.sheetHeader}><div><h2 id={id}>{title}</h2>{description&&<p id={descriptionId}>{description}</p>}</div><button type="button" className={styles.iconButton} aria-label="关闭窗口" onClick={close}><X size={21}/></button></header>
    {children}
  </dialog>;
}

