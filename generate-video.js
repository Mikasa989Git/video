#!/usr/bin/env node
// CLI orchestrator: node generate-video.js --topic "..." [--length 8] [--voice-id ...]
//   [--out ./output/slug]
// Style is fixed (config/styles/corporate-explainer.json) — not a CLI option.
//
// Thin wrapper around src/pipeline.js, which is the single shared implementation used by
// both this CLI and server.js (the web UI) — no behavior differs between the two.

const path = require('path');
const { loadEnv, slugify, ROOT } = require('./src/util');
const { runPipeline } = require('./src/pipeline');

loadEnv();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.topic) {
    console.error('Usage: node generate-video.js --topic "..." [--length 8] [--voice-id ...] [--out ./output/slug]');
    process.exit(1);
  }
  const lengthMinutes = args.length ? Number(args.length) : 8;
  const jobDir = args.out
    ? path.resolve(args.out)
    : path.join(ROOT, 'output', `${slugify(args.topic)}-${Date.now()}`);

  console.log(`Job directory: ${jobDir}`);
  console.log(`Target length: ~${lengthMinutes} min`);

  const STAGE_LABELS = {
    script: '[1/7] Script', voiceover: '[2/7] Voiceover', segment: '[3/7] Segmenting script into shots',
    transcribe: '[4/7] Transcribing voiceover (Whisper)', align: '[5/7] Aligning shots to real timestamps',
    promptgen: '[6/7] Generating image prompts', images: '[7/7] Generating images', assemble: '[7/7] Assembling video',
  };

  function onProgress(evt) {
    if (evt.status === 'checkpoint') {
      // Non-interactive CLI use: auto-approve every checkpoint so behavior is unchanged
      // from before checkpoints existed. Interactive review only happens in the web UI.
      console.log(`  (auto-approving ${evt.stage} checkpoint)`);
      return { approved: true };
    }
    if (evt.stage === 'cost' || evt.stage === 'error' || evt.stage === 'complete') return;
    if (evt.status === 'start') console.log(`\n${STAGE_LABELS[evt.stage] || evt.stage}`);
    if (evt.stage === 'images' && evt.status === 'progress') {
      process.stdout.write(`\r  [imagegen] ${evt.current}/${evt.total}`);
      if (evt.current === evt.total) process.stdout.write('\n');
    }
    if (evt.status === 'done' && evt.detail) console.log(`  ${evt.detail}`);
  }

  const { videoPath, ledger } = await runPipeline(
    { topic: args.topic, lengthMinutes, voiceId: args['voice-id'], styleName: args.style, jobDir },
    onProgress
  );

  ledger.printSummary();
  console.log(`\nDone: ${videoPath}`);
}

main().catch(err => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
