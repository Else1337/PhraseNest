// Portable Node.js build for the public source snapshot. No deployment or data import.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const command = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));
const child = spawn(process.execPath, [command, 'build', '--webpack'], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, ZHIBI_NODE_DEPLOY: '1', NEXT_TELEMETRY_DISABLED: '1' }
});
child.on('error', () => { console.error('Build process could not start'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
