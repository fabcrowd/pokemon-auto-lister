import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateHost, publicHttpsUrl } from '../tools/extension-wasm/lib/net.js';

test('private and local names are blocked', () => {
  for (const host of [
    'localhost', 'localhost.', 'foo.localhost', 'router.lan', 'printer.local',
    '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1',
    '100.64.0.1', '0.0.0.1', '::1', '::', '[::1]', 'fe80::1', 'fc00::1', 'fec0::1',
    '[::ffff:127.0.0.1]', '::ffff:7f00:1',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
});

test('public hosts are allowed', () => {
  for (const host of ['cards.example', '1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});

test('publicHttpsUrl rejects private, credential, and non-https targets', () => {
  assert.equal(publicHttpsUrl('http://example.com/a.jpg'), null);
  assert.equal(publicHttpsUrl('https://user:pass@example.com/a.jpg'), null);
  assert.equal(publicHttpsUrl('https://192.168.1.5/a.jpg'), null);
  assert.equal(publicHttpsUrl('https://cdn.example/a.jpg').href, 'https://cdn.example/a.jpg');
  assert.equal(publicHttpsUrl('/secret', 'https://127.0.0.1/card'), null);
  assert.equal(publicHttpsUrl('/a.jpg', 'https://cdn.example/card').href, 'https://cdn.example/a.jpg');
});

test('the shipped URL check never accepts a local http source', () => {
  for (const url of ['http://127.0.0.1:3100/img/0.jpg', 'http://127.0.0.1/a.jpg', 'https://127.0.0.1/a.jpg', 'http://localhost:8080/a.jpg']) {
    assert.equal(publicHttpsUrl(url), null, url);
  }
});

test('reserved IPv4 ranges beyond the private blocks are blocked', () => {
  for (const host of [
    '192.0.0.1', '192.0.0.255', '198.18.0.1', '198.19.255.254',
    '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '[::ffff:224.0.0.1]',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
    assert.equal(publicHttpsUrl(`https://${host}/a.jpg`), null, host);
  }
});

test('addresses next to the reserved ranges stay public', () => {
  for (const host of ['192.0.1.1', '192.0.2.1', '198.17.255.255', '198.20.0.1', '223.255.255.255']) {
    assert.equal(isPrivateHost(host), false, host);
  }
});
