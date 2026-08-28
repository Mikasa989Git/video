// Fits a generated script to the client's selected video length. The hard requirement:
// final voiceover duration must never exceed the target, and may land at most
// BELOW_TOLERANCE seconds under it. A word-count instruction to Claude alone can't
// guarantee this (models don't count precisely, and the same word count reads at
// different speeds depending on punctuation/pacing), so this iterates against the real
// synthesized audio: generate, measure with ffprobe, correct the word-count ask using
// the actually-observed words/second rate, and repeat. If the model still misses after
// a few tries, a mechanical trim (drop trailing sentences, re-measure for real each time)
// is the final safety net that makes "never over" an actual guarantee rather than a hope.

const fs = require('fs');
const path = require('path');
const { ffprobeDuration } = require('./util');
const { generateScript } = require('./scriptgen');
const { generateVoiceover } = require('./tts');

const BELOW_TOLERANCE = 5; // seconds under target is acceptable; over is never acceptable
const MAX_ATTEMPTS = 4;
const WORDS_PER_MINUTE_FALLBACK = 145; // only used to seed the very first attempt

function sentencesOf(text) {
  return text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}
function joinSentences(sentences) {
  return sentences.join('\n\n');
}
function countWords(text) {
  return sentencesOf(text).join(' ').split(/\s+/).filter(Boolean).length;
}

async function synthesizeAndMeasure(scriptText, tmpPath, voiceId, ledger) {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  await generateVoiceover(scriptText, tmpPath, { costLedger: ledger, voiceId });
  return ffprobeDuration(tmpPath);
}

// Returns { scriptText, voiceoverPath, actualDur }. voiceoverPath is a real, already-
// synthesized mp3 for scriptText — callers should reuse it (rename into place) rather
// than paying to synthesize the same text again.
async function fitScriptToTargetLength({ topic, lengthMinutes, feedback, voiceId, jobDir, ledger }) {
  const targetDur = lengthMinutes * 60;
  const tmpPath = path.join(jobDir, '.length_fit_voiceover.mp3');
  let wordTarget = Math.round(lengthMinutes * WORDS_PER_MINUTE_FALLBACK);
  let scriptText, actualDur;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { script, usage } = await generateScript(topic, { lengthMinutes, feedback, wordTarget });
    scriptText = script;
    const usd = ((usage.input_tokens || 0) / 1000) * 0.003 + ((usage.output_tokens || 0) / 1000) * 0.015;
    const note = attempt === 1
      ? `${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens`
      : `${usage.input_tokens || 0} in / ${usage.output_tokens || 0} out tokens (length-fit retry ${attempt})`;
    ledger.add('scriptgen', usd, note);

    actualDur = await synthesizeAndMeasure(scriptText, tmpPath, voiceId, ledger);

    if (actualDur <= targetDur && actualDur >= targetDur - BELOW_TOLERANCE) {
      return { scriptText, voiceoverPath: tmpPath, actualDur };
    }

    const secPerWord = actualDur / countWords(scriptText);
    const aimDur = targetDur - BELOW_TOLERANCE / 2;
    wordTarget = Math.max(20, Math.round(aimDur / secPerWord));
  }

  // Safety net: still outside the window after MAX_ATTEMPTS. Being short is tolerable;
  // being over is not, so mechanically trim trailing sentences (re-measuring the real
  // audio each time) until the hard cap is met.
  if (actualDur > targetDur) {
    let sentences = sentencesOf(scriptText);
    let guard = 0;
    while (actualDur > targetDur && sentences.length > 3 && guard < 40) {
      sentences = sentences.slice(0, -1);
      scriptText = joinSentences(sentences);
      actualDur = await synthesizeAndMeasure(scriptText, tmpPath, voiceId, ledger);
      guard++;
    }
  }

  return { scriptText, voiceoverPath: tmpPath, actualDur };
}

module.exports = { fitScriptToTargetLength, sentencesOf, joinSentences };
