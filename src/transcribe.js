// Wraps ffmpeg's built-in Whisper filter to get REAL measured timestamps from the actual
// voiceover audio, instead of estimating pacing from word counts.
//
// queue=10 is load-bearing: a smaller queue (e.g. the ffmpeg-filter default rolling buffer)
// re-transcribes overlapping audio at each chunk boundary and duplicates words, which
// silently inflates the word count and desyncs alignment by the end of a file. Verified
// today: queue=3 produced 702 words against a 665-word script; queue=10 produced 664.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ffmpegPath, ROOT } = require('./util');

const MODEL_PATH = path.join(__dirname, '..', 'models', 'ggml-base.en.bin');

function transcribe(audioPath, outJsonPath) {
  if (fs.existsSync(outJsonPath)) {
    console.log(`  [transcribe] using cached ${path.basename(outJsonPath)}`);
    return loadTranscript(outJsonPath);
  }
  if (!fs.existsSync(MODEL_PATH)) {
    throw new Error(`Whisper model not found at ${MODEL_PATH}`);
  }
  console.log(`  [transcribe] running Whisper on ${path.basename(audioPath)}...`);

  // ffmpeg filtergraph option strings are colon-delimited (key=value:key=value:...), and
  // an absolute Windows path's drive-letter colon (e.g. "C:/Users/...") breaks that parser
  // even when backslash-escaped — ffmpeg's filter syntax has multiple nested escaping
  // layers and getting a drive-letter colon through all of them reliably isn't worth it.
  // Simplest fix: run ffmpeg with ROOT as its cwd and use paths *relative* to ROOT for
  // anything embedded in the filter string, so there's no drive letter/colon to fight.
  const modelRel = path.relative(ROOT, MODEL_PATH).replace(/\\/g, '/');
  const destRel = path.relative(ROOT, outJsonPath).replace(/\\/g, '/');
  const audioAbs = path.resolve(audioPath); // fine as a plain -i argument, not filter-embedded

  const filter = `whisper=model=${modelRel}:language=en:format=json:destination=${destRel}:queue=10:max_len=20:use_gpu=false`;
  try {
    execFileSync(ffmpegPath(), ['-y', '-i', audioAbs, '-ar', '16000', '-ac', '1', '-af', filter, '-f', 'null', '-'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: ROOT,
    });
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    throw new Error(`ffmpeg whisper transcription failed: ${stderr.slice(-2000) || err.message}`);
  }
  return loadTranscript(outJsonPath);
}

function loadTranscript(file) {
  // The whisper filter doesn't escape quote characters that show up inside transcribed
  // text (e.g. quoted dialogue), which breaks strict JSON.parse per line. Each line's
  // shape is fixed, so pull it apart with a regex instead — greedy .* correctly grabs
  // everything up to the final "} on the line.
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const re = /^\{"start":(\d+),"end":(\d+),"text":"(.*)"\}$/;
  return lines.map(l => {
    const m = re.exec(l);
    if (!m) throw new Error('Unparseable transcript line: ' + l.slice(0, 80));
    return { start: Number(m[1]), end: Number(m[2]), text: m[3] };
  });
}

module.exports = { transcribe };
