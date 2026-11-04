import { randomUUID } from "node:crypto";
import { learnerDatabase, type Query } from "@/lib/learner/database";
export async function adminAudit(actor:string,action:string,target:string,reason:string,query?:Query){await (query??(await learnerDatabase()).query)("INSERT INTO lp_admin_audit(id,actor,action,target,reason,created_at) VALUES(?,?,?,?,?,?)",[randomUUID(),actor,action,target,reason.slice(0,2000),new Date().toISOString()]);}
