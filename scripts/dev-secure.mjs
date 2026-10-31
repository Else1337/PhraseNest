// Read credentials in memory from an explicitly selected existing env file.
// Never copy the file, print its contents, or place it inside generated assets.
import { spawn } from "node:child_process";
import { mkdir, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (!args.includes("--port") && !args.includes("-p")) args.push("--port", "3002");
// This Windows preview must stay usable while entering credentials or chatting.
// Turbopack repeatedly invalidated /login in this workspace (12 navigations in
// eight seconds). Keep the local preview on Webpack; explicit opt-in is allowed.
if (!args.some((argument) => ["--webpack", "--turbopack", "--turbo"].includes(argument))) args.push("--webpack");
const envFlag = args.indexOf("--secrets-from");
if (envFlag >= 0) {
  const source = args[envFlag + 1];
  if (!source || !path.isAbsolute(source)) throw new Error("Use an explicit absolute env-file path");
  if ((await lstat(source)).isSymbolicLink()) throw new Error("Refusing a redirected credentials file");
  process.loadEnvFile(source);
  args.splice(envFlag, 2);
}
const temporary = path.join(root, "work", "tmp");
await mkdir(temporary, { recursive: true });
if (!args.includes("--hostname") && !args.includes("-H")) args.push("--hostname", "127.0.0.1");
const child = spawn(process.execPath, [path.join(root, "node_modules", "next", "dist", "bin", "next"), "dev", ...args], {
  cwd: root, stdio: ["inherit", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, TEMP: temporary, TMP: temporary, NODE_USE_ENV_PROXY: "1", ZHIBI_LOCAL_PREVIEW: "1", NEXT_TELEMETRY_DISABLED: "1", STUDENT_PROJECT_DATA_DIR: path.join(root, "data") }
});
// Compile the local entry routes before handoff, without credentials, model
// calls or creating student records. This is local startup, not a monitor.
let startup = "", warming = false;
const warmAbort = new AbortController();
const portFlag = args.findIndex((argument) => argument === "--port" || argument === "-p");
const port = Number(portFlag < 0 ? process.env.PORT ?? 3000 : args[portFlag + 1]);
async function warmPreview() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  const routes = [["/login", "GET"], ["/api/auth/login", "OPTIONS"], ["/", "GET"], ["/memory", "GET"], ["/api/student/workspace?view=chat", "GET"], ["/api/student/workspace/reply", "GET"], ["/api/student/workspace/reading", "OPTIONS"]];
  for (const [route, method] of routes) {
    try { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.any([warmAbort.signal, AbortSignal.timeout(90_000)]) }); await response.arrayBuffer(); if (![200, 204, 401].includes(response.status)) throw new Error("Not ready"); }
    catch { if (!warmAbort.signal.aborted) process.stderr.write("Local preview warm-up incomplete; a first request may take longer.\n"); return; }
  }
  process.stdout.write(`Local preview warmed: http://127.0.0.1:${port}\n`);
}
const relay = (output) => {
  let pending = "";
  return (chunk) => {
    pending += chunk.toString();
    const lines = pending.split("\n"); pending = lines.pop() ?? "";
    for (const line of lines) output.write(line.replace(/([?&](?:password|username)=)[^&\s]*/gi, "$1[redacted]") + "\n");
    if (!warming) { startup = (startup + chunk.toString()).slice(-8_000); if (startup.includes("Ready in")) { warming = true; void warmPreview(); } }
  };
};
child.stdout.on("data", relay(process.stdout));
child.stderr.on("data", relay(process.stderr));
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
child.once("exit", (code) => { warmAbort.abort(); process.exitCode = code ?? 1; });
child.once("error", () => { console.error("Development server could not start"); process.exitCode = 1; });
