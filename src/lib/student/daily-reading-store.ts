import { z } from "zod";
import { mutateStoreText, readStoreText } from "@/lib/storage/file-store";
const position = z.object({ blockId: z.string().max(80), offset: z.number().min(0).max(100_000), progress: z.number().min(0).max(100), updatedAt: z.string() });
const record = z.object({ value: z.string().max(4_000), meaning: z.string().max(1_000).default(""), sourceIds: z.array(z.string()).max(40), knowledgeId: z.string().optional(), firstMarkedAt: z.string().nullable().default(null), nextReviewAt: z.string().nullable().default(null) });
const event = z.object({ id: z.string().uuid(), articleId: z.string().max(200), blockId: z.string().max(80), itemId: z.string().max(200), type: z.enum(["presented", "answer_revealed", "self_report", "collected", "answer", "review_scheduled"]), at: z.string(), value: z.string().max(4_000).optional(), revealedBeforeAnswer: z.boolean().optional() });
const inquiry = z.object({ id: z.string().uuid(), articleId: z.string(), blockId: z.string(), quote: z.string().max(4_000), question: z.string().max(2_000), answer: z.string().max(20_000), status: z.enum(["generating", "complete", "failed"]), createdAt: z.string(), leaseUntil: z.number() });
export const dailyReadingSchema = z.object({ version: z.literal(1), positions: z.record(z.string(), position), registry: z.record(z.string(), record), events: z.array(event).max(6_000), inquiries: z.array(inquiry).max(300) });
export type DailyReadingState = z.infer<typeof dailyReadingSchema>;
export const emptyDailyReading = (): DailyReadingState => ({ version: 1, positions: {}, registry: {}, events: [], inquiries: [] });
const key = (id: string) => "daily-reading/" + z.string().uuid().parse(id) + ".json";
const parse = (text: string | null) => text === null ? emptyDailyReading() : dailyReadingSchema.parse(JSON.parse(text));
export async function readDailyReading(id: string) { return parse(await readStoreText(key(id))); }
export async function mutateDailyReading<T>(id: string, change: (state: DailyReadingState) => T) {
  return mutateStoreText(key(id), (text) => { const state = parse(text); const result = change(state); dailyReadingSchema.parse(state); return { text: JSON.stringify(state), result }; });
}
export function dailyLearningSnapshot(state: DailyReadingState) {
  return { distinction: "日课呈现、看过答案、自评、独立作答分别记录；未评定的作答不等于正确或掌握。", recent: state.events.slice(-24).map((event) => ({ ...event, expression: state.registry[event.itemId]?.value, sourceIds: state.registry[event.itemId]?.sourceIds })),
    questions: state.inquiries.filter((item) => item.status === "complete").slice(-5).map(({ quote, question, articleId }) => ({ quote, question, sourceId: articleId })) };
}
