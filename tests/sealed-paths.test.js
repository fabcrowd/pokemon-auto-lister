import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { isInside, localHostAllowed } from '../scripts/lib/sealed-paths.mjs';

const root = path.resolve('repo-root');

test('isInside accepts a folder strictly under the parent and nothing that escapes it', () => {
  assert.equal(isInside(path.join(root, 'data'), path.join(root, 'data', 'profile')), true);
  assert.equal(isInside(path.join(root, 'data'), path.join(root, 'data', 'a', 'b')), true);
  assert.equal(isInside(path.join(root, 'data'), path.join(root, 'data')), false);
  assert.equal(isInside(path.join(root, 'data'), path.join(root, 'data-other')), false);
  assert.equal(isInside(path.join(root, 'data'), path.join(root, 'data', '..', 'x')), false);
  assert.equal(isInside(path.join(root, 'data'), path.resolve(root, '..', 'elsewhere')), false);
});

test('localHostAllowed accepts only this server on a loopback name', () => {
  assert.equal(localHostAllowed('127.0.0.1:3100', 3100), true);
  assert.equal(localHostAllowed('localhost:3100', 3100), true);
  assert.equal(localHostAllowed('127.0.0.1:3101', 3100), false);
  assert.equal(localHostAllowed('evil.test:3100', 3100), false);
  assert.equal(localHostAllowed('127.0.0.1.evil.test:3100', 3100), false);
  assert.equal(localHostAllowed(undefined, 3100), false);
});

test('localHostAllowed does not treat the dots as wildcards', () => {
  assert.equal(localHostAllowed('127x0y0z1:3100', 3100), false);
});
