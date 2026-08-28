// Topic -> full narration script, in this channel's established voice, formatted exactly
// how segment.js expects it: one complete sentence per line, nothing else.

const { requireEnv } = require('./util');

const STYLE_EXAMPLE = `Everyone wants to get rich.

But if I asked you right now, how does someone actually become wealthy?

What's the plan?

Buy stocks?

Start a business?

Buy real estate?

Trade crypto?

The internet gives you a thousand answers.

But strip away all the noise, and there are really four games people play to build serious wealth.`;

// Calibrated against a real run: an 815-word script produced a 5:44 (343.9s) voiceover,
// i.e. ~142 words/minute at this narration pace. Used only to size the request to Claude —
// actual runtime is whatever the real voiceover ends up being (verified later by Whisper).
const WORDS_PER_MINUTE = 145;

function buildSystemPrompt(targetWords) {
  return `You write narration scripts for a fast-paced, retention-optimized explainer YouTube channel about money, business, and decision-making frameworks.

Voice and structure rules, learned from this channel's best-performing script:
- Short, punchy sentences. Many are under 8 words. Some are a single word for emphasis.
- Frequent rhetorical questions, often standalone on their own line ("What's the plan?").
- Direct first-person address — "I" statements, not "you" lectures ("If I have almost no money..." not "If you have no money...").
- The script builds toward a small number of named categories/paths/steps (e.g. "four paths," "three questions") and explicitly maps them early, then walks through each one with a concrete numeric example.
- Concrete numbers throughout (dollar amounts, percentages) to make abstract ideas tangible.
- A clear arc: hook question -> "here's the map" reveal of the framework -> walk through each part with an example -> a moment where people commonly get it wrong -> recap the whole framework -> a punchy closing line.
- No stage directions, scene descriptions, markdown, headers, or titles. Output ONLY the spoken narration.
- One complete sentence (or single-word emphasis line) per line, with a blank line between each. Nothing else on any line.
- Target as close to ${targetWords} words as you can hit — treat this as a precise budget, not a rough guide. Undershooting slightly is fine; overshooting is not.

Example of the exact voice and formatting (the opening of a real script from this channel, on a different topic):

${STYLE_EXAMPLE}

Write a brand-new, complete script in this exact voice and format on the topic the user gives you. Do not reuse the example's content — write fresh material for the new topic.`;
}

async function generateScript(topic, { lengthMinutes = 8, feedback, wordTarget, model = process.env.CLAUDE_MODEL || 'claude-sonnet-5' } = {}) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const targetWords = wordTarget || Math.round(lengthMinutes * WORDS_PER_MINUTE);
  const userContent = feedback
    ? `Topic: ${topic}\n\nA previous draft was rejected with this feedback — write a fresh script that addresses it: ${feedback}`
    : `Topic: ${topic}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      // This model produces a "thinking" block by default even with no explicit thinking
      // param, and it shares the same max_tokens budget as the actual script text. Caught
      // in production: for this system prompt, a single real call measured 1435 thinking
      // tokens (vs. ~70 for a much shorter prompt) — on an unlucky draw that can run long
      // enough to consume the whole budget before any visible text starts, producing a
      // response with zero text content. Generous headroom here makes that rare rather
      // than eliminating it outright; see the retry-on-empty-response handling in
      // lengthfit.js's caller for the other half of the mitigation.
      max_tokens: 16384,
      system: buildSystemPrompt(targetWords),
      messages: [{ role: 'user', content: userContent }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  const text = json.content.map(c => c.text || '').join('');
  if (!text.trim()) throw new Error(`Claude returned an empty response for "${topic}" (targetWords=${targetWords}) — stop_reason: ${json.stop_reason}`);
  const usage = json.usage || {};
  const script = sanitizeScript(text);
  if (!script) throw new Error(`Script came out empty after sanitizing Claude's response — raw response was: ${JSON.stringify(text.slice(0, 300))}`);
  return { script, usage };
}

// Despite instructions, a model can still wrap output in a code fence or prepend a
// pleasantry line ("Here's the script:"). Either would otherwise become a literal
// on-screen shot in the final video, so strip anything that clearly isn't narration.
function sanitizeScript(text) {
  let t = text.trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  const lines = t.split(/\r?\n/);
  const preambleRe = /^(here'?s|here is|title:|script:|sure[,!]|certainly)/i;
  let start = 0;
  while (start < lines.length && preambleRe.test(lines[start].trim())) start++;
  // Never let this strip the ENTIRE response — if every line matched "preamble", that
  // means the match is wrong for this content, not that the content is disposable. Caught
  // in production: a short, low-word-target script under length-fit retries got fully
  // consumed by this loop, producing a silently empty script.
  const stripped = lines.slice(start).join('\n').trim();
  return stripped || t;
}

module.exports = { generateScript };
