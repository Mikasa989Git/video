// Script -> voiceover.mp3 via OpenAI's TTS API (tts-1). Uses the same OpenAI key already
// required for image generation — no separate account/quota to run out of, and ~6.7x
// cheaper than the ElevenLabs model this replaced ($0.015 vs $0.10 per 1,000 characters).
//
// tts-1 caps input at 4096 characters per request, so this chunks at sentence boundaries
// (never splitting a sentence across two calls) and concatenates the resulting audio with
// ffmpeg (stream copy, no re-encode — no quality loss, no seam risk).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { requireEnv, ffmpegPath, ensureDir } = require('./util');

const MAX_CHARS_PER_CHUNK = 3800; // conservative vs tts-1's hard 4096-char limit
const DEFAULT_VOICE = process.env.OPENAI_TTS_VOICE || 'onyx';

function chunkScript(scriptText, maxChars) {
  const sentences = scriptText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const s of sentences) {
    const candidate = current ? current + ' ' + s : s;
    if (candidate.length > maxChars && current) {
      chunks.push(current);
      current = s;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function ttsChunk(text, voice, apiKey) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new Error(msg);
  }
  return Buffer.from(await res.arrayBuffer());
}

// OpenAI tts-1: $15 per 1,000,000 characters = $0.000015/char, flat, pay-as-you-go.
const USD_PER_CHAR = 0.000015;

async function generateVoiceover(scriptText, outPath, { costLedger, voiceId } = {}) {
  if (fs.existsSync(outPath)) {
    console.log(`  [tts] using cached ${path.basename(outPath)}`);
    return outPath;
  }
  const apiKey = requireEnv('OPENAI_API_KEY');
  const voice = voiceId || DEFAULT_VOICE;

  const chunks = chunkScript(scriptText, MAX_CHARS_PER_CHUNK);
  console.log(`  [tts] generating voiceover (voice: ${voice}) in ${chunks.length} chunk(s)...`);

  const tmpDir = path.join(path.dirname(outPath), '.tts_chunks');
  ensureDir(tmpDir);
  const chunkPaths = [];
  let totalChars = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}.mp3`);
    if (!fs.existsSync(chunkPath)) {
      console.log(`    chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)...`);
      const audio = await ttsChunk(chunks[i], voice, apiKey);
      fs.writeFileSync(chunkPath, audio);
    }
    chunkPaths.push(chunkPath);
    totalChars += chunks[i].length;
  }

  if (chunkPaths.length === 1) {
    fs.copyFileSync(chunkPaths[0], outPath);
  } else {
    const listPath = path.join(tmpDir, 'concat_list.txt');
    const listText = chunkPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listPath, listText, 'utf8');
    execFileSync(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  }

  if (costLedger) costLedger.add('tts', totalChars * USD_PER_CHAR, `${totalChars} chars, ${chunks.length} chunk(s), voice=${voice}`);
  return outPath;
}

const SAMPLE_TEXT = "Hi there — this is what I sound like. I'll be narrating your video.";

// Generates and caches a short (~5s) preview clip for one voice, so the UI's voice
// picker can let someone hear a voice before choosing it. Cached on disk permanently —
// the sample text never changes, so there's nothing to regenerate after the first time.
async function ensureVoiceSample(voiceId, samplePath, costLedger) {
  if (fs.existsSync(samplePath)) return samplePath;
  const apiKey = requireEnv('OPENAI_API_KEY');
  const audio = await ttsChunk(SAMPLE_TEXT, voiceId, apiKey);
  ensureDir(path.dirname(samplePath));
  fs.writeFileSync(samplePath, audio);
  if (costLedger) costLedger.add('tts-sample', SAMPLE_TEXT.length * USD_PER_CHAR, `voice=${voiceId}`);
  return samplePath;
}

module.exports = { generateVoiceover, chunkScript, ensureVoiceSample };
