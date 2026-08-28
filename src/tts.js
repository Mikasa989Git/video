// Script -> voiceover.mp3 via ElevenLabs' text-to-speech API.
//
// ElevenLabs accepts long inputs per request, but this still chunks at sentence
// boundaries (never splitting a sentence across two calls) and concatenates the
// resulting audio with ffmpeg (stream copy, no re-encode — no quality loss, no seam
// risk) — the same approach as every other multi-chunk TTS call in this pipeline, so
// a client-side edit that changes chunk boundaries can't produce audible glitches.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { requireEnv, ffmpegPath, ensureDir } = require('./util');

const MAX_CHARS_PER_CHUNK = 4500;
const DEFAULT_VOICE = process.env.ELEVENLABS_VOICE_ID;
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';

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
  if (!voice) throw new Error('No ElevenLabs voice selected — set ELEVENLABS_VOICE_ID or pick a voice in config/voices.json');
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail?.message || JSON.stringify(j.detail) || msg; } catch {}
    throw new Error(msg);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ElevenLabs bills in "credits" whose $/credit varies by subscription plan, not a
// flat public rate like OpenAI's — this is a rough estimate for the running cost
// tracker only (based on this project's own prior measurement), not a real charge.
const USD_PER_CHAR = 0.0001;

async function generateVoiceover(scriptText, outPath, { costLedger, voiceId } = {}) {
  if (fs.existsSync(outPath)) {
    console.log(`  [tts] using cached ${path.basename(outPath)}`);
    return outPath;
  }
  const apiKey = requireEnv('ELEVENLABS_API_KEY');
  const voice = voiceId || DEFAULT_VOICE;

  const chunks = chunkScript(scriptText, MAX_CHARS_PER_CHUNK);
  if (chunks.length === 0) {
    throw new Error(`generateVoiceover got no text to synthesize (script was empty or whitespace-only after sanitizing) — outPath: ${outPath}`);
  }
  console.log(`  [tts] generating voiceover (voice: ${voice}) in ${chunks.length} chunk(s)...`);

  const tmpDir = path.join(path.dirname(outPath), '.tts_chunks');
  ensureDir(tmpDir);
  const chunkPaths = [];
  let totalChars = 0;
  for (let i = 0; i < chunks.length; i++) {
    // Keyed by a content hash, not just index — this directory is shared across every
    // synthesis attempt for a job (e.g. lengthfit.js tries several candidate scripts in a
    // row against the same tmpDir), so an index-only name would let attempt 2 silently
    // reuse attempt 1's audio at the same position if the text there actually differs.
    // Real bug this fixed: exactly that staleness, caught from a live production failure.
    const hash = crypto.createHash('sha1').update(chunks[i]).digest('hex').slice(0, 10);
    const chunkPath = path.join(tmpDir, `chunk_${String(i).padStart(3, '0')}_${hash}.mp3`);
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
    // Fail loudly and specifically here rather than handing ffmpeg a list it can't read —
    // "Invalid data found when processing input" from ffmpeg gives no hint which chunk (or
    // that it's a chunk problem at all) actually caused it.
    const missing = chunkPaths.filter(p => !fs.existsSync(p) || fs.statSync(p).size === 0);
    if (missing.length) throw new Error(`voiceover chunk file(s) missing or empty before concat: ${missing.join(', ')}`);

    const listPath = path.join(tmpDir, 'concat_list.txt');
    const listText = chunkPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listPath, listText, 'utf8');
    execFileSync(ffmpegPath(), ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  }

  if (costLedger) costLedger.add('tts', totalChars * USD_PER_CHAR, `${totalChars} chars, ${chunks.length} chunk(s), voice=${voice} (estimate — actual cost depends on your ElevenLabs plan)`);
  return outPath;
}

const SAMPLE_TEXT = "Hi there — this is what I sound like. I'll be narrating your video.";

// Generates and caches a short (~5s) preview clip for one voice, so the UI's voice
// picker can let someone hear a voice before choosing it. Cached on disk permanently —
// the sample text never changes, so there's nothing to regenerate after the first time.
async function ensureVoiceSample(voiceId, samplePath, costLedger) {
  if (fs.existsSync(samplePath)) return samplePath;
  const apiKey = requireEnv('ELEVENLABS_API_KEY');
  const audio = await ttsChunk(SAMPLE_TEXT, voiceId, apiKey);
  ensureDir(path.dirname(samplePath));
  fs.writeFileSync(samplePath, audio);
  if (costLedger) costLedger.add('tts-sample', SAMPLE_TEXT.length * USD_PER_CHAR, `voice=${voiceId}`);
  return samplePath;
}

module.exports = { generateVoiceover, chunkScript, ensureVoiceSample };
