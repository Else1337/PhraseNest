import { listStoreKeys } from "@/lib/storage/file-store";
import { readDialogueWorkspace, ensureDailyMemory } from "@/lib/student/dialogue-store";
import { getStudentLearningHub } from "@/lib/student/learning-store";
import { beijingDate } from "@/lib/student/dialogue-model";

export async function dispatchDailyMemory(now = new Date()) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Shanghai", hour: "numeric", hourCycle: "h23" }).format(now));
  if (hour < 7) return;
  const date = beijingDate(now);
  const keys = (await listStoreKeys("dialogue/")).filter((key) => /^dialogue\/[0-9a-f-]{36}\.json$/.test(key));
  let delivered = 0;
  let failed = 0;
  // Deliberately bounded concurrency: R2 and the legacy corpus store must not be
  // flooded. The hourly trigger repairs partial delivery using the same date key.
  for (let i = 0; i < keys.length; i += 4) {
    await Promise.all(keys.slice(i, i + 4).map(async (key) => {
      try {
        const studentId = key.slice("dialogue/".length, -".json".length);
        const state = await readDialogueWorkspace(studentId);
        if (!state.preferences.dailyEnabled || state.days.some((day) => day.date === date && day.cards.length)) return;
        const learning = await getStudentLearningHub(studentId);
        const day = await ensureDailyMemory(studentId, [...learning.vocabulary, ...learning.materials], now);
        if (day.cards.length) delivered++;
      } catch { failed++; }
    }));
  }
  console.info("[daily-memory-dispatch]", { date, accounts: keys.length, delivered, failed });
  if (failed) throw new Error(`DAILY_DELIVERY_FAILED:${failed}`);
}
