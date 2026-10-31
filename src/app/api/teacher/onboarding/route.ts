import { getCurrentTeacher } from "@/lib/auth/teacher-store";
import { guideResponse } from "@/lib/onboarding/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return guideResponse(request, "teacher", (await getCurrentTeacher())?.id); }
export const POST = GET;
