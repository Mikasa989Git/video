// gpt-image-1 wrapper. Generates one narrator reference image per STYLE (cached and
// reused across every video that uses that style — consistent brand identity, and no
// repeat cost), then one image per shot: narrator shots go through images.edit seeded
// from the reference for character consistency; everything else is plain generation.
// Rate-limited to this account's observed tier (~5 req/min) and resumable — any PNG
// that already exists on disk is skipped, so a crash only costs money for what's left.

const fs = require('fs');
const path = require('path');
const { requireEnv, ensureDir } = require('./util');

const CONCURRENCY = 1;
const MIN_INTERVAL_MS = 13000; // this account's observed gpt-image-1 tier; gpt-image-1-mini's limit is untested, keeping the same conservative pacing for now
const MAX_RETRIES = 4;
// Approximate — OpenAI bills image output by tokens (pixel-count-dependent), these are
// per-image estimates at the 1536x1024 landscape size used here, not the base 1024x1024
// rate quoted in most pricing pages. Verify against actual billing after the first run.
const USD_PER_IMAGE = {
  'gpt-image-1': { low: 0.02, medium: 0.06, high: 0.19 },
  'gpt-image-1-mini': { low: 0.008, medium: 0.02, high: 0.05 },
};
function priceOf(style) {
  return (USD_PER_IMAGE[style.image.model] || USD_PER_IMAGE['gpt-image-1'])[style.image.quality] || 0.06;
}

let lastRequestAt = 0;
async function paceRequest() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function withRetry(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await paceRequest();
      return await fn();
    } catch (err) {
      lastErr = err;
      const hinted = /try again in ([\d.]+)s/i.exec(err.message);
      const waitMs = hinted ? Math.ceil(parseFloat(hinted[1]) * 1000) + 1000 : 4000 * attempt;
      console.warn(`  [imagegen] retry ${attempt}/${MAX_RETRIES} ${label}: ${err.message} (waiting ${Math.round(waitMs / 1000)}s)`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

async function generatePlain(prompt, style, apiKey) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: style.image.model, prompt, size: style.image.size, quality: style.image.quality, n: 1 }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.data[0].b64_json;
}

async function generateWithReference(prompt, style, refPath, apiKey) {
  const form = new FormData();
  form.append('model', style.image.model);
  form.append('prompt', prompt + ' ' + style.referenceNote + ' ' + style.noTextSuffix);
  form.append('size', style.image.size);
  form.append('quality', style.image.quality);
  form.append('n', '1');
  form.append('image', new Blob([fs.readFileSync(refPath)], { type: 'image/png' }), 'reference.png');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  return json.data[0].b64_json;
}

async function ensureReferenceImage(style, refPath, costLedger) {
  if (!style.narrator?.enabled) return null;
  if (fs.existsSync(refPath)) {
    console.log(`  [imagegen] reusing cached reference: ${path.basename(refPath)}`);
    return refPath;
  }
  const apiKey = requireEnv('OPENAI_API_KEY');
  console.log('  [imagegen] generating new narrator reference image for this style...');
  const prompt = `${style.styleLine} Scene: ${style.narrator.description}, ${style.narrator.referencePoseLine}. ${style.noTextSuffix}`;
  const b64 = await withRetry(() => generatePlain(prompt, style, apiKey), 'reference');
  ensureDir(path.dirname(refPath));
  fs.writeFileSync(refPath, Buffer.from(b64, 'base64'));
  if (costLedger) costLedger.add('imagegen', priceOf(style), 'reference image (one-time per style)');
  return refPath;
}

function outFileName(scene) {
  return `scene${String(scene).padStart(3, '0')}.png`;
}

// Returns true if an API call was actually made (money spent), false if skipped because
// the file already existed (free — already paid for on a previous run).
async function processShot(shot, refPath, style, apiKey, outDir, idx, total, onProgress) {
  const fname = outFileName(shot.scene);
  const outPath = path.join(outDir, fname);
  if (fs.existsSync(outPath)) {
    console.log(`  [imagegen] [${idx}/${total}] skip (exists): ${fname}`);
    if (onProgress) onProgress(idx, total, fname);
    return false;
  }
  console.log(`  [imagegen] [${idx}/${total}] generating ${fname} (narrator: ${!!shot.narrator})...`);
  const b64 = await withRetry(
    () => (shot.narrator && refPath
      ? generateWithReference(shot.prompt, style, refPath, apiKey)
      : generatePlain(`${style.styleLine} Scene: ${shot.prompt}. ${style.noTextSuffix}`, style, apiKey)),
    fname
  );
  fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
  if (onProgress) onProgress(idx, total, fname);
  return true;
}

async function runPool(items, worker, concurrency) {
  let next = 0;
  const failures = [];
  let generatedCount = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try {
        if (await worker(items[i], i + 1, items.length)) generatedCount++;
      } catch (err) {
        console.error(`  [imagegen] [${i + 1}/${items.length}] FAILED: ${err.message}`);
        failures.push({ shot: items[i], error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, runner));
  return { failures, generatedCount };
}

// shotsWithPrompts: [{scene, text, words, narrator, prompt}]
async function generateImages(shotsWithPrompts, style, outDir, refPath, costLedger, onProgress) {
  ensureDir(outDir);
  const apiKey = requireEnv('OPENAI_API_KEY');
  const { failures, generatedCount } = await runPool(
    shotsWithPrompts,
    (shot, idx, total) => processShot(shot, refPath, style, apiKey, outDir, idx, total, onProgress),
    CONCURRENCY
  );
  const succeeded = shotsWithPrompts.length - failures.length;
  if (costLedger && generatedCount > 0) {
    costLedger.add('imagegen', generatedCount * priceOf(style), `${generatedCount} newly generated scene image(s) (of ${shotsWithPrompts.length} total)`);
  }
  if (failures.length) {
    const failPath = path.join(outDir, '..', 'generation_failures.json');
    fs.writeFileSync(failPath, JSON.stringify(failures, null, 2));
    console.warn(`  [imagegen] ${failures.length} failed — see ${failPath}. Re-run to retry just those.`);
  }
  return { succeeded, failed: failures.length };
}

module.exports = { ensureReferenceImage, generateImages };
