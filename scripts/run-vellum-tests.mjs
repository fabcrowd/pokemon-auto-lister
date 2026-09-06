import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const python = path.join(root, 'tools', 'vellum-ai', '.venv', 'Scripts', 'python.exe');
const result = spawnSync(
  python,
  ['-m', 'unittest', 'discover', '-s', path.join(root, 'tools', 'vellum-ai', 'tests'), '-v'],
  { stdio: 'inherit', cwd: path.join(root, 'tools', 'vellum-ai') },
);
process.exit(result.status ?? 1);
