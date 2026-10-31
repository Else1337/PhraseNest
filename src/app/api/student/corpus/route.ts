import { NextResponse } from "next/server";
import { getCurrentStudent } from "@/lib/auth/session";
import { getStudentLearningHub } from "@/lib/student/learning-store";

export const runtime = "nodejs";

export async function GET() {
  const student = await getCurrentStudent();
  if (!student) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const hub = await getStudentLearningHub(student.id);
  const now = Date.now();
  return NextResponse.json({
    overview: {
      materialCount: hub.materials.length,
      favoriteCount: hub.materials.filter((item) => item.favoriteAt).length,
      vocabularyCount: hub.vocabulary.length,
      dueCount: [...hub.materials, ...hub.vocabulary].filter((item) => new Date(item.nextReviewAt).getTime() <= now).length,
      recentSources: hub.sources.slice(0, 6)
    },
    materials: hub.materials,
    vocabulary: hub.vocabulary,
    folders: hub.folders,
    sources: hub.sources
  }, { headers: { "Cache-Control": "no-store" } });
}
