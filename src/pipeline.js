// The single shared implementation of the 7-stage topic -> video pipeline. Used by both
// generate-video.js (CLI) and server.js (web UI) so there's exactly one place that knows
// how to run it — no behavior gets to drift between the two entry points.
//
// onProgress(event) is called throughout with { stage, status, detail, current, total,
// costSoFar } — status is 'start' | 'progress' | 'done' | 'checkpoint'. For 'checkpoint'
// events, onProgress's return value (it may be a Promise) is awaited and must resolve to
// { approved: true, content? } or { approved: false, feedback }. The CLI auto-approves
// immediately; the web server pauses for real by returning a Promise it resolves later
// from a separate HTTP request (see server.js). Callers that don't care about progress
// can pass a no-op that always resolves approved:true.

const fs = require('fs');
const path = require('path');
const { ensureDir, CostLedger, ROOT, ffprobeDuration } = require('./util');
const { generateScript } = require('./scriptgen');
const { generateVoiceover } = require('./tts');
const { fitScriptToTargetLength, sentencesOf, joinSentences } = require('./lengthfit');
const { segmentScript } = require('./segment');
const { transcribe } = require('./transcribe');
const { alignShots } = require('./align');
const { generateImagePrompts } = require('./promptgen');
const { ensureReferenceImage, generateImages } = require('./imagegen');
const { assembleVideo } = require('./assemble');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); }

const STAGES = ['script', 'voiceover', 'segment', 'transcribe', 'align', 'promptgen', 'images', 'assemble'];
const DEFAULT_STYLE = 'corporate-explainer';

async function checkpoint(onProgress, stage, content) {
  const result = await onProgress({ stage, status: 'checkpoint', content });
  return result || { approved: true };
}

// options: { topic, lengthMinutes, voiceId, styleName, jobDir }
async function runPipeline(options, onProgress = () => ({ approved: true })) {
  const { topic, lengthMinutes = 8, voiceId, styleName = DEFAULT_STYLE, jobDir } = options;
  if (!topic) throw new Error('topic is required');
  if (!lengthMinutes) throw new Error('lengthMinutes is required');

  const stylePath = path.join(ROOT, 'config', 'styles', `${styleName}.json`);
  if (!fs.existsSync(stylePath)) throw new Error(`Unknown style "${styleName}" — expected ${stylePath}`);
  const style = readJson(stylePath);

  ensureDir(jobDir);
  const imagesDir = path.join(jobDir, 'images');
  const refImagePath = path.join(ROOT, 'config', 'styles', `${styleName}_reference.png`);
  const costLedgerPath = path.join(jobDir, 'cost.json');

  const p = {
    script: path.join(jobDir, 'script.txt'),
    voiceover: path.join(jobDir, 'voiceover.mp3'),
    shots: path.join(jobDir, 'shots.json'),
    transcript: path.join(jobDir, 'transcript.json'),
    aligned: path.join(jobDir, 'aligned_shots.json'),
    prompts: path.join(jobDir, 'image_prompts.json'),
    video: path.join(jobDir, 'final_video.mp4'),
  };

  const ledger = new CostLedger();
  // Persisted after every addition (not just at the end) so a mid-run crash never hides
  // money that was actually already spent — a real gap in the first version of this.
  const originalAdd = ledger.add.bind(ledger);
  ledger.add = (...args) => {
    originalAdd(...args);
    fs.writeFileSync(costLedgerPath, JSON.stringify({ entries: ledger.entries, total: ledger.total() }, null, 2));
    onProgress({ stage: 'cost', status: 'progress', costSoFar: ledger.total() });
  };

  try {
    // 1. Script — length-fitted against the client's selected duration (final voiceover
    // must never run over that duration, and may land at most 5s under it — see
    // lengthfit.js), then paused for approval. A rejection with feedback re-fits from
    // scratch with that feedback folded in.
    onProgress({ stage: 'script', status: 'start' });
    let scriptText;
    let fittedVoiceoverPath = null;
    if (fs.existsSync(p.script)) {
      scriptText = fs.readFileSync(p.script, 'utf8');
    } else {
      let feedback;
      for (;;) {
        const fitted = await fitScriptToTargetLength({ topic, lengthMinutes, feedback, voiceId, jobDir, ledger });
        const result = await checkpoint(onProgress, 'script', fitted.scriptText);
        if (result.approved) {
          scriptText = result.content || fitted.scriptText;
          if (scriptText === fitted.scriptText) {
            fittedVoiceoverPath = fitted.voiceoverPath;
          } else if (fs.existsSync(fitted.voiceoverPath)) {
            // Hand-edited script no longer matches the fitted audio — its length is now
            // the client's call, not something we can keep guaranteeing automatically.
            fs.unlinkSync(fitted.voiceoverPath);
          }
          break;
        }
        if (fs.existsSync(fitted.voiceoverPath)) fs.unlinkSync(fitted.voiceoverPath);
        feedback = result.feedback;
      }
      fs.writeFileSync(p.script, scriptText);
    }
    onProgress({ stage: 'script', status: 'done' });

    // 2. Voiceover — pauses for approval (listen before paying for images); a rejection
    // regenerates the audio, optionally with a different voice. Reuses the audio already
    // synthesized while fitting the script's length, when available, instead of paying
    // to synthesize the same text twice.
    onProgress({ stage: 'voiceover', status: 'start' });
    if (!fs.existsSync(p.voiceover)) {
      const targetDur = lengthMinutes * 60;
      let currentVoiceId = voiceId;
      let useFitted = true;
      for (;;) {
        if (useFitted && fittedVoiceoverPath && fs.existsSync(fittedVoiceoverPath) && currentVoiceId === voiceId) {
          fs.renameSync(fittedVoiceoverPath, p.voiceover);
        } else {
          await generateVoiceover(scriptText, p.voiceover, { costLedger: ledger, voiceId: currentVoiceId });
        }
        useFitted = false;

        // Safety net: a hand-edited script or a newly-picked voice can both land over
        // the target duration without ever going through the length-fit loop above —
        // "never over" is a hard requirement, so mechanically trim here too if needed.
        let dur = ffprobeDuration(p.voiceover);
        if (dur > targetDur) {
          let sentences = sentencesOf(scriptText);
          let guard = 0;
          while (dur > targetDur && sentences.length > 3 && guard < 40) {
            sentences = sentences.slice(0, -1);
            scriptText = joinSentences(sentences);
            fs.unlinkSync(p.voiceover);
            await generateVoiceover(scriptText, p.voiceover, { costLedger: ledger, voiceId: currentVoiceId });
            dur = ffprobeDuration(p.voiceover);
            guard++;
          }
          fs.writeFileSync(p.script, scriptText);
        }

        const result = await checkpoint(onProgress, 'voiceover', { ready: true });
        if (result.approved) break;
        fs.unlinkSync(p.voiceover);
        currentVoiceId = result.voiceId || currentVoiceId;
      }
    }
    onProgress({ stage: 'voiceover', status: 'done' });

    // 3. Segment into shots
    onProgress({ stage: 'segment', status: 'start' });
    let shots;
    if (fs.existsSync(p.shots)) {
      shots = readJson(p.shots);
    } else {
      shots = segmentScript(scriptText);
      writeJson(p.shots, shots);
    }
    onProgress({ stage: 'segment', status: 'done', detail: `${shots.length} shots` });

    // 4. Transcribe voiceover for real timestamps
    onProgress({ stage: 'transcribe', status: 'start' });
    const transcript = transcribe(p.voiceover, p.transcript);
    onProgress({ stage: 'transcribe', status: 'done' });

    // 5. Align shots to real timestamps
    onProgress({ stage: 'align', status: 'start' });
    let aligned;
    if (fs.existsSync(p.aligned)) {
      aligned = readJson(p.aligned);
    } else {
      const actualDur = ffprobeDuration(p.voiceover);
      aligned = alignShots(shots, transcript, actualDur);
      writeJson(p.aligned, aligned);
    }
    onProgress({ stage: 'align', status: 'done' });

    // 6. Generate image prompts — no client review (removed per feedback: the scene/prompt
    // summary wasn't useful to look at before images exist to actually judge). Runs
    // straight through into image generation.
    onProgress({ stage: 'promptgen', status: 'start' });
    let prompts;
    if (fs.existsSync(p.prompts)) {
      prompts = readJson(p.prompts);
    } else {
      prompts = await generateImagePrompts(shots, style, { costLedger: ledger });
      writeJson(p.prompts, prompts);
    }
    const shotsWithPrompts = shots.map(s => {
      const pr = prompts.find(x => x.scene === s.scene);
      return { ...s, narrator: !!pr?.narrator, prompt: pr?.prompt || s.text };
    });
    onProgress({ stage: 'promptgen', status: 'done' });

    // 7. Generate images + assemble — no per-image checkpoint (reviewing 100+ images
    // individually isn't practical); this runs straight through.
    onProgress({ stage: 'images', status: 'start', current: 0, total: shotsWithPrompts.length });
    await ensureReferenceImage(style, refImagePath, ledger);
    const { succeeded, failed } = await generateImages(
      shotsWithPrompts, style, imagesDir,
      style.narrator?.enabled ? refImagePath : null,
      ledger,
      (current, total) => onProgress({ stage: 'images', status: 'progress', current, total })
    );
    if (failed > 0) {
      throw new Error(`${failed} image(s) failed to generate. Re-run with the same job directory to retry just those.`);
    }
    onProgress({ stage: 'images', status: 'done' });

    onProgress({ stage: 'assemble', status: 'start' });
    assembleVideo(aligned, imagesDir, p.voiceover, p.video, style);
    onProgress({ stage: 'assemble', status: 'done' });

    onProgress({ stage: 'complete', status: 'done', videoPath: p.video, costSoFar: ledger.total(), costEntries: ledger.entries });
    return { videoPath: p.video, ledger, jobDir };
  } catch (err) {
    onProgress({ stage: 'error', status: 'done', error: err.message, costSoFar: ledger.total() });
    throw err;
  }
}

module.exports = { runPipeline, STAGES, DEFAULT_STYLE };
