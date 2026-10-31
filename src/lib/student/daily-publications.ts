import { z } from "zod";
import { importedLearningRecordSchema } from "./history-import";
import { readStoreText } from "@/lib/storage/file-store";
import { generatedDailyPublications } from "./scheduled-tasks";
// Per-account, private publication snapshots. Never bundled into public assets.
// Publishing a snapshot does not mean that future Notion sync is connected.
export const dailyPublicationsSchema = z.object({ version: z.literal(1), studentId: z.string().uuid(), fetchedAt: z.string().datetime(), records: z.array(importedLearningRecordSchema.extend({ id: z.string().max(200) })).max(120) });
export async function readDailyPublications(studentId: string) {
  const owner = z.string().uuid().parse(studentId);
  const text = await readStoreText("daily-sources/" + owner + ".json");
  const generated = await generatedDailyPublications(owner);
  if (text === null) return generated;
  const data = dailyPublicationsSchema.parse(JSON.parse(text));
  if (data.studentId !== owner) throw new Error("Publication owner mismatch");
  return [...data.records.map((record) => ({ ...record, studentId: owner, importedAt: data.fetchedAt })), ...generated];
}
