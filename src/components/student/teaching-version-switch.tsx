"use client";

import { useSyncExternalStore } from "react";
import { normalizeTeachingVersion, teachingVersionLabels, teachingVersionStorageKey, type TeachingVersion } from "@/lib/ai/teaching-version";

const changedEvent = "phrasenest-teaching-version-change";
let transientVersion: TeachingVersion = "new";
function subscribe(changed: () => void) {
  window.addEventListener("storage", changed);
  window.addEventListener(changedEvent, changed);
  return () => { window.removeEventListener("storage", changed); window.removeEventListener(changedEvent, changed); };
}
function snapshot(): TeachingVersion {
  try { return normalizeTeachingVersion(localStorage.getItem(teachingVersionStorageKey)); }
  catch { return transientVersion; }
}
function select(version: TeachingVersion) {
  transientVersion = version;
  try { localStorage.setItem(teachingVersionStorageKey, version); }
  catch { console.warn("[teaching-version]", { persisted: false }); }
  window.dispatchEvent(new Event(changedEvent));
}
export function useTeachingVersion() {
  const version = useSyncExternalStore(subscribe, snapshot, () => "new" as const);
  return { version, select };
}
export function TeachingVersionSwitch({ version, onChange, disabled }: { version: TeachingVersion; onChange: (version: TeachingVersion) => void; disabled: boolean }) {
  const next = version === "new" ? "old" : "new";
  return <button type="button" className="dw-teaching-version" data-teaching-version={version} aria-pressed={version === "old"} aria-label={`教学版本：${teachingVersionLabels[version]}；点击切换为${teachingVersionLabels[next]}`} title="切换教学提示词与 Skill，下一条消息生效；旧版为046版本" disabled={disabled} onClick={() => onChange(next)}>{teachingVersionLabels[version]}</button>;
}
