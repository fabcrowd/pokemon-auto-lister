import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const install = readFileSync(path.join(root, 'src', 'service', 'windows', 'install.ps1'), 'utf8');
const uninstall = readFileSync(path.join(root, 'src', 'service', 'windows', 'uninstall.ps1'), 'utf8');

test('install.ps1 defines a TaskName used for registration', () => {
  assert.match(install, /\$TaskName\s*=/);
});

test('install.ps1 resolves the project/node path to an absolute path rather than a hardcoded relative one', () => {
  assert.match(install, /\$PSScriptRoot/);
  assert.match(install, /Resolve-Path|\.\.\\\.\.\\\.\./);
});

test('install.ps1 warns or refuses when the project path looks like it lives on the Desktop', () => {
  assert.match(install, /Desktop/i);
});

test('install.ps1 registers a scheduled task via Register-ScheduledTask or schtasks', () => {
  assert.match(install, /Register-ScheduledTask|schtasks/);
});

test('install.ps1 configures the task to run at logon and restart on failure', () => {
  assert.match(install, /AtLogOn/);
  assert.match(install, /RestartCount/);
});

test('uninstall.ps1 removes the scheduled task by TaskName', () => {
  assert.match(uninstall, /\$TaskName\s*=/);
  assert.match(uninstall, /Unregister-ScheduledTask|schtasks.*\/Delete/);
});

test('install.ps1 is idempotent by requesting confirmation suppression on re-registration', () => {
  assert.match(install, /-Force/);
});
