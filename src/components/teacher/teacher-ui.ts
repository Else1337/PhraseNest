import { readWorkspaceJson } from "@/lib/student/workspace-client";
export type TeacherStudent = { id: string; username: string; displayName: string };
export type TeacherClass = { id: string; name: string; joinCode: string; students: TeacherStudent[] };
export type MaterialStatus = "queued" | "processing" | "failed" | "draft" | "published";
export type TeacherMaterialSummary = { id: string; title: string; class_ids: string; status: MaterialStatus; updated_at: string };
export type TeacherMaterial = TeacherMaterialSummary & { content: string };
export const materialClassIds = (material: TeacherMaterialSummary): string[] => JSON.parse(material.class_ids);
export const materialStatusLabel = (status: MaterialStatus) => ({queued:"待提取",processing:"提取中",failed:"待重试",draft:"草稿",published:"已发布"})[status];
export async function teacherJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const value: unknown = await readWorkspaceJson(response);
  return value as T;
}
export const teacherPost = <T>(url: string, body: unknown, signal?: AbortSignal) => teacherJson<T>(url, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal});

