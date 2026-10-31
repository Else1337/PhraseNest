import {protectStudentAi} from "@/lib/security/ai-handler";
import { NextResponse } from "next/server";
import { getCurrentStudent } from "@/lib/auth/session";
import { classifyCorpusKnowledge } from "@/lib/ai/corpus-classifier";
import { getStudentLearningHub, updateCorpusItem } from "@/lib/student/learning-store";

export const runtime = "nodejs";

async function handlePost(_request: Request, context: { params: Promise<{ id: string }> }) {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { id } = await context.params;
  const hub = await getStudentLearningHub(student.id);
  const item = [...hub.materials, ...hub.vocabulary].find((entry) => entry.id === id);
  if (!item) return NextResponse.json({ error: "语料不存在" }, { status: 404 });
  const section = item.type === "material" ? "materials" : "vocabulary";
  const folders = hub.folders.filter((folder) => folder.section === section);
  try {
    const result = await classifyCorpusKnowledge(item, folders.map((folder) => folder.name));
    const folder = folders.find((entry) => entry.name === result.folderName)!;
    const updated = await updateCorpusItem(student.id, item.id, { folderId: folder.id, tags: result.tags, classificationMethod: "ai" });
    return NextResponse.json({ item: updated, classification: result });
  } catch {
    return NextResponse.json({ item, fallback: true, message: "已使用本地规则完成分类，AI 分类稍后可重试" }, { status: 202 });
  }
}

export const POST=protectStudentAi(handlePost);
