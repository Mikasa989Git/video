// Maps each shot to a REAL start/duration by building an anchor list (cumulative
// word-count -> real timestamp) from the Whisper transcript, then interpolating.
//
// Two fixes learned the hard way today, both load-bearing:
//
// 1. Number-run collapsing: the script says amounts as words ("two thousand dollars"),
//    Whisper often hears/transcribes the same audio as a numeral ("$2,000"). Plain
//    whitespace word-counting treats those as 3 words vs 1, and a script full of dollar
//    figures compounds that into many seconds of drift by the end. Counting a run of
//    consecutive number-ish tokens as a single unit on both sides keeps the counts in sync.
//
// 2. Trust our own word count, not Whisper's, for the final boundary: Whisper's count for
//    a whole file can land short (dropped words) or long (still occasionally, even at
//    queue=10) relative to the script's true count. Either way, drop any anchor beyond our
//    own true total and always finish with one trustworthy anchor at
//    (our true total words, real audio duration) — this makes interpolation span exactly
//    [0, totalWords] -> [0, actualDurationMs] regardless of which direction Whisper drifted.

const NUMBER_WORDS = new Set(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred','thousand','million','billion','percent','dollar','dollars','cent','cents','grand']);

function countAlignmentUnits(s) {
  const words = s.split(/\s+/).filter(Boolean);
  let count = 0, inNumRun = false;
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!clean) continue; // pure punctuation (e.g. a standalone "-"), not a spoken word
    const isNum = /\d/.test(w) || NUMBER_WORDS.has(clean);
    if (isNum) {
      if (!inNumRun) { count++; inNumRun = true; }
    } else {
      count++;
      inNumRun = false;
    }
  }
  return count;
}

function buildAnchors(segments) {
  const anchors = [{ wordIdx: 0, timeMs: 0 }];
  let cumWords = 0;
  for (const seg of segments) {
    if (seg.start >= anchors[anchors.length - 1].timeMs) {
      anchors.push({ wordIdx: cumWords, timeMs: seg.start });
    }
    cumWords += countAlignmentUnits(seg.text);
  }
  const clean = [];
  for (const a of anchors) {
    if (clean.length === 0 || a.wordIdx > clean[clean.length - 1].wordIdx) clean.push(a);
  }
  return clean;
}

function interpolate(anchors, wordIdx) {
  if (wordIdx <= anchors[0].wordIdx) return anchors[0].timeMs;
  if (wordIdx >= anchors[anchors.length - 1].wordIdx) return anchors[anchors.length - 1].timeMs;
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i], b = anchors[i + 1];
    if (wordIdx >= a.wordIdx && wordIdx <= b.wordIdx) {
      const frac = (wordIdx - a.wordIdx) / (b.wordIdx - a.wordIdx);
      return a.timeMs + frac * (b.timeMs - a.timeMs);
    }
  }
  return anchors[anchors.length - 1].timeMs;
}

// shots: [{scene, text, words}] in order. transcript: [{start,end,text}] in ms.
// actualDurationSec: real ffprobe-measured audio duration.
function alignShots(shots, transcript, actualDurationSec) {
  const actualMs = actualDurationSec * 1000;
  let anchors = buildAnchors(transcript);

  const shotsWithUnits = shots.map(s => ({ ...s, alignWords: countAlignmentUnits(s.text) }));
  const totalUnits = shotsWithUnits.reduce((s, b) => s + b.alignWords, 0);

  anchors = anchors
    .filter(a => a.wordIdx < totalUnits)
    .map(a => ({ wordIdx: a.wordIdx, timeMs: Math.min(a.timeMs, actualMs) }));
  anchors.push({ wordIdx: totalUnits, timeMs: actualMs });

  const aligned = [];
  let cumWords = 0;
  for (const shot of shotsWithUnits) {
    const startMs = interpolate(anchors, cumWords);
    cumWords += shot.alignWords;
    const endMs = interpolate(anchors, cumWords);
    aligned.push({
      scene: shot.scene,
      text: shot.text,
      words: shot.words,
      start: startMs / 1000,
      dur: Math.max(0.15, (endMs - startMs) / 1000),
    });
  }
  return aligned;
}

module.exports = { alignShots, countAlignmentUnits };
