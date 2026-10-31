export const teachingVersions = ["new", "old"] as const;
export type TeachingVersion = typeof teachingVersions[number];
export const teachingVersionStorageKey = "phrasenest.teaching-version.v1";
export const teachingVersionLabels: Record<TeachingVersion, string> = { new: "新版", old: "旧版" };
export function normalizeTeachingVersion(value: unknown): TeachingVersion {
  return value === "old" ? "old" : "new";
}
