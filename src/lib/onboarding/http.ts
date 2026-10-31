import { z } from "zod";
import { isSameStudentOrigin } from "@/lib/auth/request-origin";
import { readBoundedText, RequestSafetyError } from "@/lib/security/request-safety";
import { finishGuide, guideActionSchema, readGuides } from "./store";
import { guideAllowed, type GuideScope } from "./catalog";
const headers = { "Cache-Control": "private, no-store" };
export async function guideResponse(request: Request, scope: GuideScope, owner: string | undefined) {
  if (!owner) return Response.json({ error: "请先登录" }, { status: 401, headers });
  try {
    if (request.method === "GET") return Response.json(await readGuides(scope, owner), { headers });
    if (!isSameStudentOrigin(request)) return Response.json({ error: "不支持跨站修改" }, { status: 403, headers });
    const body = guideActionSchema.parse(JSON.parse(await readBoundedText(request, 1024)));
    if (!guideAllowed(scope, body.guideId)) return Response.json({ error: "引导不属于当前账号类型" }, { status: 400, headers });
    return Response.json(await finishGuide(scope, owner, body.guideId, body.status), { headers });
  } catch (error) {
    const status = error instanceof RequestSafetyError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503;
    return Response.json({ error: status === 503 ? "引导进度暂未保存，请稍后重试" : "引导设置格式不正确" }, { status, headers });
  }
}
