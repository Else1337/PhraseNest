import { createSkill } from "@mastra/core/skills";
import data from "./writing-review-data";
import legacyData from "./legacy-writing-review-data";

// Same native Mastra extension point as the existing exam tutor. No new agent,
// tool runtime, model provider, personal-data store or external integration.
export const writingReviewSkill = createSkill(data);
export const legacyWritingReviewSkill = createSkill(legacyData);
