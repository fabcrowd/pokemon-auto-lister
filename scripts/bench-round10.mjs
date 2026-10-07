import { readFileSync } from 'node:fs';
import path from 'node:path';

const SPLIT_CROPS = 'C:\\Users\\daroo\\Desktop\\Repos\\cardscanner\\pokemon-auto-lister\\data\\split-crops';
const SERVER = 'http://127.0.0.1:3000/detect';

const TEST_IMAGES = [
  '3878825c4b77_card0.jpg',
  '3878825c4b77_card1.jpg',
  '4acbe1635451_card0.jpg',
  '4acbe1635451_card1.jpg',
  '61142692df3c_card0.jpg',
  '61142692df3c_card1.jpg',
  '61142692df3c_card2.jpg',
  '61142692df3c_card3.jpg',
  '61142692df3c_card4.jpg',
  '61142692df3c_card5.jpg',
  '61142692df3c_card6.jpg',
  '61142692df3c_card7.jpg',
  '61142692df3c_card8.jpg',
  '61142692df3c_card9.jpg',
  '61142692df3c_card10.jpg',
  '61142692df3c_card11.jpg',
];

async function detectCard(imagePath) {
  const buf = readFileSync(imagePath);
  const b64 = buf.toString('base64');
  const res = await fetch(SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image_b64: b64 }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('=== ROUND 10 BENCHMARK ===');
  console.log('Changes: use hasUsableIdentity() in retry + fallback gate (fixes ok=true/Unknown bypass)\n');

  let identified = 0;
  let abstained = 0;
  let errors = 0;
  const results = [];

  for (const fname of TEST_IMAGES) {
    const fullPath = path.join(SPLIT_CROPS, fname);
    try {
      const data = await detectCard(fullPath);
      const card = data.cards?.[0];
      if (!card) {
        results.push(`[ERROR] ${fname}: no cards in response`);
        errors++;
        continue;
      }
      if (card.abstain) {
        results.push(`[ABSTAIN] ${fname}`);
        abstained++;
      } else {
        const name = card.identity?.name ?? 'Unknown';
        const set = card.identity?.set ?? 'null';
        const price = card.market_price != null ? '$' + card.market_price : 'no price';
        results.push(`[OK] ${fname} -> ${name} | ${set} | ${price}`);
        identified++;
      }
    } catch (err) {
      results.push(`[ERROR] ${fname}: ${err.message}`);
      errors++;
    }
  }

  const total = TEST_IMAGES.length;
  console.log(`Identified: ${identified} / ${total} (${Math.round(identified/total*100)}%)`);
  console.log(`Abstained: ${abstained}`);
  console.log(`Errors: ${errors}`);
  console.log('');
  results.forEach(r => console.log(r));
}

main().catch(console.error);
