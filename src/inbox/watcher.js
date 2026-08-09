import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Written inside a processed folder so a re-scan (or process restart) never
// re-enqueues the same drop.
const PROCESSED_MARKER = '.autolister-processed';
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isImageFile(name) {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function pickFrontImage(photoPaths) {
  const front = photoPaths.find((photoPath) => path.basename(photoPath).toLowerCase().startsWith('front'));
  return front ?? photoPaths[0];
}

export async function scanInbox({ inboxDir, queue, onEnqueue }) {
  if (!existsSync(inboxDir)) {
    return [];
  }

  const enqueuedIds = [];

  for (const entry of readdirSync(inboxDir)) {
    const folderPath = path.join(inboxDir, entry);
    if (!statSync(folderPath).isDirectory()) {
      continue;
    }

    const markerPath = path.join(folderPath, PROCESSED_MARKER);
    if (existsSync(markerPath)) {
      continue;
    }

    const photoPaths = readdirSync(folderPath)
      .filter(isImageFile)
      .map((name) => path.join(folderPath, name))
      .sort();

    if (photoPaths.length === 0) {
      continue;
    }

    const id = queue.enqueue({
      title: entry,
      photos: photoPaths,
      frontImagePath: pickFrontImage(photoPaths),
      mercari: true,
      ebay: true,
    });
    writeFileSync(markerPath, new Date().toISOString());
    enqueuedIds.push(id);

    if (onEnqueue) {
      await onEnqueue(id);
    }
  }

  return enqueuedIds;
}

export function startInboxWatcher({ inboxDir, queue, onEnqueue, intervalMs = 5000 }) {
  const timer = setInterval(() => {
    scanInbox({ inboxDir, queue, onEnqueue }).catch((err) => {
      console.error(`Inbox scan of ${inboxDir} failed:`, err);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
