import path from 'node:path';

/** True when `child` is a folder below `parent` (not the parent itself, not a sibling that shares a prefix). */
export function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** A local server answers only requests addressed to it by a loopback name, which a web page elsewhere cannot forge. */
export function localHostAllowed(host, port) {
  return new RegExp(`^(127\\.0\\.0\\.1|localhost):${port}$`).test(host || '');
}
