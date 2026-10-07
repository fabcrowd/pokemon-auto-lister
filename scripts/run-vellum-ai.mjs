import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vellumDir = path.join(root, 'tools', 'vellum-ai');
const candidates = [
  path.join(vellumDir, '.venv312', 'Scripts', 'python.exe'),
  path.join(vellumDir, '.venv', 'Scripts', 'python.exe'),
];
const python = candidates.find((p) => fs.existsSync(p));
if (!python) {
  console.error('No VellumAI venv found (.venv312 or .venv).');
  process.exit(1);
}
const server = path.join(vellumDir, 'identify_server.py');
const child = spawn(python, [server], {
  stdio: 'inherit',
  cwd: vellumDir,
  env: process.env,
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

