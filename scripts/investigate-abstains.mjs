import { readFileSync } from 'node:fs';
import path from 'node:path';

const SPLIT_CROPS = 'C:\\Users\\daroo\\Desktop\\Repos\\cardscanner\\pokemon-auto-lister\\data\\split-crops';
const DETECT = 'http://127.0.0.1:3000/detect';
const SCAN = 'http://127.0.0.1:3000/api/scan';
const SIDECAR = 'http://127.0.0.1:8787/detect-multi';

const ABSTAINS = [
  '3878825c4b77_card1.jpg',
  '4acbe1635451_card0.jpg',
  '61142692df3c_card1.jpg',
  '61142692df3c_card3.jpg',
  '61142692df3c_card4.jpg',
  '61142692df3c_card5.jpg',
  '61142692df3c_card6.jpg',
  '61142692df3c_card11.jpg',
];

async function callSidecar(buf, fname) {
  const fd = new FormData();
  fd.append('photo', new File([buf], fname, { type: 'image/jpeg' }));
  try {
    const res = await fetch(SIDECAR, { method: 'POST', body: fd });
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text().then(t => t.slice(0, 100))}` };
    return res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function callDetect(buf) {
  const b64 = buf.toString('base64');
  try {
    const res = await fetch(DETECT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_b64: b64 }),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function callScan(buf, fname) {
  const fd = new FormData();
  fd.append('photos', new File([buf], fname, { type: 'image/jpeg' }));
  try {
    const res = await fetch(SCAN, { method: 'POST', body: fd });
    if (!res.ok) return { error: `HTTP ${res.status}: ${await res.text().then(t => t.slice(0, 100))}` };
    return res.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function main() {
  for (const fname of ABSTAINS) {
    const fp = path.join(SPLIT_CROPS, fname);
    const buf = readFileSync(fp);
    const sizekb = (buf.length / 1024).toFixed(0);
    console.log(`\n=== ${fname} (${sizekb}kb) ===`);

    // Sidecar: what does it see in this crop?
    const sidecar = await callSidecar(buf, fname);
    if (sidecar.error) {
      console.log(`  sidecar: ERROR ${sidecar.error}`);
    } else {
      const cards = sidecar.cards || [];
      console.log(`  sidecar: ${cards.length} detection(s)`);
      cards.forEach((c, i) => {
        console.log(`    [${i}] class=${c.class} conf=${c.conf?.toFixed(3)} box=${JSON.stringify(c.box)}`);
      });
    }

    // /detect: what does the full pipeline return?
    const det = await callDetect(buf);
    if (det.error) {
      console.log(`  /detect: ERROR ${det.error}`);
    } else {
      const c = det.cards?.[0];
      if (!c) {
        console.log(`  /detect: no cards`);
      } else if (c.abstain) {
        console.log(`  /detect: ABSTAIN conf=${c.confidence}`);
      } else {
        console.log(`  /detect: OK -> ${c.identity?.name} | ${c.identity?.set} | $${c.market_price}`);
      }
    }

    // /api/scan: can Pokegrade identify it at all?
    const sc = await callScan(buf, fname);
    if (sc.error) {
      console.log(`  /api/scan: ERROR ${sc.error}`);
    } else if (!sc.ok || !sc.identity) {
      const vellum = sc.vellumConfidence ? ` vellumConf=${sc.vellumConfidence}` : '';
      console.log(`  /api/scan: ABSTAIN ok=${sc.ok}${vellum} identity=${JSON.stringify(sc.identity)}`);
    } else {
      const price = sc.suggested ? JSON.stringify(sc.suggested) : 'no price';
      const vellumConf = sc.vellumConfidence ? ` [vellum=${sc.vellumConfidence}]` : '';
      console.log(`  /api/scan: OK -> ${sc.identity?.name} | ${sc.identity?.set}${vellumConf} | ${price}`);
    }
  }
  console.log('\nDone.');
}

main().catch(console.error);
