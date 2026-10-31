const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

// Mastra's final output.usage can be a run aggregate. The last StepResult's
// usage remains per-inference. Copy now, before the outer stream mutates it.
export function stepUsageSnapshot(output: unknown): Record<string, unknown> {
  const steps = record(output).steps;
  return structuredClone(record(Array.isArray(steps) ? record(steps.at(-1)).usage : undefined));
}

export function parseUsageFingerprint(value: unknown): Record<string, unknown> {
  try { return record(JSON.parse(typeof value === "string" ? value : "{}")); }
  catch { return {}; } // Legacy/invalid metadata is unclassified, never v2.
}

export function meteredFingerprint(fingerprint: string, version?: 2, scope = "step") {
  return version === 2 ? JSON.stringify({ ...parseUsageFingerprint(fingerprint), metering: { version: 2, scope } }) : fingerprint;
}

export const isStepMetered = (fingerprint: unknown) => record(parseUsageFingerprint(fingerprint).metering).version === 2;
