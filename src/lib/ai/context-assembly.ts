export type ContextAssembly = "baseline" | "task-v2";

// Opt in locally. This does not promote lean-v1 or alter cloud configuration.
export function contextAssemblyPolicy(value = process.env.ZHIBI_CONTEXT_ASSEMBLY): ContextAssembly {
  return value === "task-v2" ? "task-v2" : "baseline";
}
