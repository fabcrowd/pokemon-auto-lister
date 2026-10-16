// Renders the store icons and the promo tile from docs/store/*.svg.
// icon.svg is the source of truth; icon-small.svg is the simplified art used at 16 px.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storeDir = path.join(root, 'docs', 'store');
const iconDir = path.join(root, 'tools', 'extension-wasm', 'icons');
const full = fs.readFileSync(path.join(storeDir, 'icon.svg'));
const small = fs.readFileSync(path.join(storeDir, 'icon-small.svg'));

// Render at 4x and downsample so thin strokes keep clean edges at 16 and 48 px.
async function renderIcon(svg, size) {
  return sharp(svg, { density: 72 * 4 * (size / 128) * 4 })
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

const sizes = [
  { size: 16, svg: small },
  { size: 48, svg: full },
  { size: 128, svg: full },
];
const rendered = {};
for (const { size, svg } of sizes) {
  rendered[size] = await renderIcon(svg, size);
  fs.mkdirSync(iconDir, { recursive: true });
  fs.writeFileSync(path.join(iconDir, `icon${size}.png`), rendered[size]);
}

const inner = full.toString('utf8').replace(/<svg[^>]*>/, '').replace('</svg>', '');
const promo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 280" width="440" height="280">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0c12"/>
      <stop offset="1" stop-color="#07080c"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#8b5cf6"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.2" cy="0.5" r="0.6">
      <stop offset="0" stop-color="#6366f1" stop-opacity="0.35"/>
      <stop offset="1" stop-color="#6366f1" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="440" height="280" fill="url(#bg)"/>
  <rect width="440" height="280" fill="url(#glow)"/>
  <svg x="22" y="68" width="144" height="144" viewBox="0 0 128 128">${inner}</svg>
  <g font-family="'Segoe UI', Arial, Helvetica, sans-serif" fill="#dde1ee">
    <text x="182" y="108" font-size="30" font-weight="700">Card Scanner</text>
    <text x="182" y="144" font-size="30" font-weight="700">&amp; Price Checker</text>
    <text x="182" y="176" font-size="19" font-weight="600" fill="#a5a8f7">for Pokémon TCG</text>
  </g>
  <rect x="182" y="194" width="64" height="4" rx="2" fill="url(#bar)"/>
  <text x="182" y="222" font-family="'Segoe UI', Arial, Helvetica, sans-serif" font-size="14" fill="#8b92ab">Recognition runs on your device</text>
</svg>`;
await sharp(Buffer.from(promo), { density: 192 })
  .resize(440, 280)
  .flatten({ background: '#07080c' })
  .png()
  .toFile(path.join(storeDir, 'promo-small-440x280.png'));

// Preview sheet: every size on a light and a dark toolbar, plus a 4x enlargement.
const previewDir = process.argv[2];
if (previewDir) {
  const tile = 200;
  const scales = [1, 4];
  const composites = [];
  const bgs = ['#ffffff', '#202124'];
  for (const [row] of bgs.entries()) {
    let x = 10;
    for (const scale of scales) {
      for (const size of [16, 48, 128]) {
        const px = size * scale;
        if (px > 192) continue;
        composites.push({
          input: scale === 1 ? rendered[size] : await sharp(rendered[size]).resize(px, px, { kernel: 'nearest' }).png().toBuffer(),
          left: x,
          top: row * tile + Math.round((tile - px) / 2),
        });
        x += px + 16;
      }
    }
  }
  fs.mkdirSync(previewDir, { recursive: true });
  await sharp({ create: { width: 820, height: tile * 2, channels: 4, background: '#ffffff' } })
    .composite([
      { input: { create: { width: 820, height: tile, channels: 4, background: bgs[0] } }, left: 0, top: 0 },
      { input: { create: { width: 820, height: tile, channels: 4, background: bgs[1] } }, left: 0, top: tile },
      ...composites,
    ])
    .png()
    .toFile(path.join(previewDir, 'icon-preview.png'));
}
