// The automation of what took several hours of manual creative work today: turning a
// segmented script into one image prompt per shot. Processes shots in batches (an LLM
// call per ~25-30 shots) and carries a short rolling summary of visual motifs already
// established (recurring diagrams/icons) into the next batch, so the video builds a
// coherent visual system instead of reinventing unrelated art shot-to-shot.

const { requireEnv } = require('./util');

const BATCH_SIZE = 25;
const USD_PER_1K_INPUT = 0.003;  // approx claude-sonnet pricing; adjust if model changes
const USD_PER_1K_OUTPUT = 0.015;

function buildSystemPrompt(style) {
  const narratorLine = style.narrator?.enabled
    ? `A recurring narrator character is available: ${style.narrator.description}. Use "narrator": true only for shots that are personal, first-person, or direct-address ("I have...", "Let's say I...", a rhetorical question aimed at the viewer, a transition/aside). Use "narrator": false for conceptual/abstract shots (diagrams, icon lists, numeric examples, comparisons) — those should be pure scene content with no character, for visual variety.`
    : `This style has no recurring character — every shot is a pure scene/diagram/icon composition. Always set "narrator": false.`;

  return `You are the art director for a fast-paced retention-optimized explainer video. Visual style for every shot: ${style.styleLine}

${narratorLine}

For each shot given (its exact narration line), write ONE concise visual scene description — just the scene-specific content, NOT the style preamble (that gets prepended automatically later). Roughly 15-30 words each.

Critical for coherence: build a small recurring visual system across the video (e.g. a running diagram that gets revealed/highlighted piece by piece, a consistent icon set for recurring concepts, a repeated composition for parallel structure) rather than a wholly new, disconnected image for every single line. You will be told what visual motifs have already been established in earlier batches — reuse and evolve them where the narration calls back to the same idea, rather than inventing something unrelated.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{"motifsSummary": "one or two sentences naming the recurring visual motifs now established, for the next batch", "shots": [{"scene": 1, "narrator": true, "prompt": "..."}, ...]}

The "shots" array must have exactly one entry per shot given, in the same order, with matching "scene" numbers.`;
}

function extractJson(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t);
}

async function callClaude(system, user, model) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 4096, system, messages: [{ role: 'user', content: user }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  const text = json.content.map(c => c.text || '').join('');
  return { text, usage: json.usage || {} };
}

async function generatePromptsForBatch(batch, style, motifsSoFar, model, feedback) {
  const system = buildSystemPrompt(style);
  const shotList = batch.map(s => `${s.scene}. ${s.text}`).join('\n');
  const feedbackLine = feedback ? `\n\nThe client reviewed a previous version of these prompts and asked for this change — apply it: ${feedback}` : '';
  const user = `Visual motifs established so far: ${motifsSoFar || '(none yet — this is the start of the video)'}\n\nShots:\n${shotList}${feedbackLine}`;

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const { text, usage } = await callClaude(system, user, model);
      const parsed = extractJson(text);
      if (!Array.isArray(parsed.shots) || parsed.shots.length !== batch.length) {
        throw new Error(`expected ${batch.length} shots, got ${parsed.shots?.length}`);
      }
      for (let i = 0; i < batch.length; i++) {
        if (parsed.shots[i].scene !== batch[i].scene) {
          throw new Error(`scene mismatch at index ${i}: expected ${batch[i].scene}, got ${parsed.shots[i].scene}`);
        }
      }
      return { shots: parsed.shots, motifsSummary: parsed.motifsSummary || motifsSoFar, usage };
    } catch (err) {
      lastErr = err;
      console.warn(`  [promptgen] batch retry ${attempt}/3: ${err.message}`);
    }
  }
  throw lastErr;
}

async function generateImagePrompts(shots, style, { costLedger, feedback, model = process.env.CLAUDE_MODEL || 'claude-sonnet-5' } = {}) {
  const results = [];
  let motifsSoFar = '';
  let totalIn = 0, totalOut = 0;
  for (let i = 0; i < shots.length; i += BATCH_SIZE) {
    const batch = shots.slice(i, i + BATCH_SIZE);
    console.log(`  [promptgen] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(shots.length / BATCH_SIZE)} (shots ${batch[0].scene}-${batch[batch.length - 1].scene})...`);
    const { shots: batchResult, motifsSummary, usage } = await generatePromptsForBatch(batch, style, motifsSoFar, model, feedback);
    results.push(...batchResult);
    motifsSoFar = motifsSummary;
    totalIn += usage.input_tokens || 0;
    totalOut += usage.output_tokens || 0;
  }
  if (costLedger) {
    const usd = (totalIn / 1000) * USD_PER_1K_INPUT + (totalOut / 1000) * USD_PER_1K_OUTPUT;
    costLedger.add('promptgen', usd, `${totalIn} in / ${totalOut} out tokens`);
  }
  return results;
}

module.exports = { generateImagePrompts };
