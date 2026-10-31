import { getCurrentStudent } from "@/lib/auth/session";
import { guideResponse } from "@/lib/onboarding/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return guideResponse(request, "student", (await getCurrentStudent())?.id); }
export const POST = GET;
