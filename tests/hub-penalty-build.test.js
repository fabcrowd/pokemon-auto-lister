import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'scripts', 'build-hub-penalty.py');
const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const hasNumpy = spawnSync(python, ['-c', 'import numpy'], { encoding: 'utf8' }).status === 0;

// Runs a Python snippet with the build script loaded as `m`; prints JSON.
function run(snippet) {
  const code = [
    'import importlib.util, json, sys',
    'import numpy as np',
    `spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(script)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    snippet,
  ].join('\n');
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the penalty is the centred mean cosine to the k nearest crops, in thousandths, one signed byte per row', { skip: !hasNumpy }, () => {
  const out = run(`
sims = np.array([[0.9, 0.1, 0.5, 0.5], [0.7, 0.1, 0.5, 0.5], [0.1, 0.1, 0.5, 0.5]], dtype=np.float32)
phys = np.array([True, True, True, False])
b = m.penalty_bytes(sims, phys, k=2, lam=0.2)
print(json.dumps({"n": len(b), "v": np.frombuffer(b, dtype=np.int8).astype(int).tolist()}))
`);
  // Top-2 means per row: 0.8, 0.1, 0.5, 0.5. Mean over the three physical rows: 0.4667.
  assert.equal(out.n, 4);
  const expected = [0.8, 0.1, 0.5, 0.5].map((r) => Math.round((0.2 * (r - (0.8 + 0.1 + 0.5) / 3)) / 0.001));
  assert.deepEqual(out.v, expected);
});

test('penalties beyond a byte are clamped, not wrapped', { skip: !hasNumpy }, () => {
  const out = run(`
sims = np.array([[1.0, -1.0, 0.0]] * 3, dtype=np.float32)
b = m.penalty_bytes(sims, np.array([True, True, True]), k=2, lam=100.0)
print(json.dumps(np.frombuffer(b, dtype=np.int8).astype(int).tolist()))
`);
  assert.deepEqual(out, [127, -127, 0]);
});

test('the script refuses a catalog or meta file that is not the pinned release', { skip: !hasNumpy }, () => {
  const out = run(`
pins = m.pinned_hashes()
print(json.dumps(pins))
`);
  const setup = readFileSync(path.join(repoRoot, 'tools', 'extension-wasm', 'lib', 'setup.js'), 'utf8');
  for (const name of ['catalog.bin.gz', 'meta.json']) {
    assert.match(setup, new RegExp(out[name]), name);
    assert.match(out[name], /^[0-9a-f]{64}$/);
  }
});
