import { createSkill } from "@mastra/core/skills";
import data from "./exam-tutor-data";
import legacyData from "./legacy-exam-tutor-data";

// Native inline skills keep references server-side and readable on demand,
// without filesystem mounts, shell access or a second skill runtime.
export const examTutorSkill = createSkill(data);
export const legacyExamTutorSkill = createSkill(legacyData);

// This uploaded package contains Else's original dialogue and preferences.
// The caller supplies the authenticated username, never a request body value.
export function examTutorEnabled(username: string) {
  return username.toLowerCase() === "else";
}
