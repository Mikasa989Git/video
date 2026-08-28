// Interprets a client's free-form "make changes" request into a structured plan, so the
// server can invalidate only the cache files that actually need to change and let the
// pipeline's existing skip-if-exists resumability do the rest — never a blind full re-run.

const { requireEnv } = require('./util');

function buildSystemPrompt() {
  return `You are the producer for a video-generation pipeline. A client has finished watching their generated video and is requesting a change. Decide the SMALLEST scope of change that satisfies their request, from these three:

- "script": the request needs different words spoken — rewording, tone, length, adding/removing content, correcting a fact. This regenerates the voiceover and everything downstream (all images), so only use it when the request genuinely requires different narration.
- "voice": the request is only about how the narration sounds — a different voice, faster/slower, different gender/tone — with the SAME script text.
- "scenes": the request is only about specific visuals — "change the picture where...", "the image at X looks wrong", "make scene N show Y instead" — the words stay the same, only certain shots' image prompts change. You will be given the full shot list with scene numbers, narration text, and current image prompts — identify exactly which scene number(s) are affected.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{"scope": "script" | "voice" | "scenes", "newScript": "..." (only if scope is script — the complete revised script, one sentence per line, blank line between each, same voice/format rules as before), "voiceId": "..." (only if scope is voice — one of: alloy, ash, coral, echo, fable, nova, onyx, sage, shimmer), "sceneEdits": [{"scene": N, "newPrompt": "..."}] (only if scope is scenes), "notes": "one sentence explaining the change for the client"}`;
}

function extractJson(text) {
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  return JSON.parse(t);
}

async function planRevision(instructions, { scriptText, shotsWithPrompts, model = process.env.CLAUDE_MODEL || 'claude-sonnet-5' } = {}) {
  const apiKey = requireEnv('ANTHROPIC_API_KEY');
  const shotList = shotsWithPrompts
    .map(s => `${s.scene}. [${s.narrator ? 'narrator' : 'no narrator'}] "${s.text}" — current image: ${s.prompt}`)
    .join('\n');
  const user = `Client's request: ${instructions}\n\nCurrent script:\n${scriptText}\n\nCurrent shot list:\n${shotList}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 8192, system: buildSystemPrompt(), messages: [{ role: 'user', content: user }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `HTTP ${res.status}`);
  const text = json.content.map(c => c.text || '').join('');
  const plan = extractJson(text);
  if (!['script', 'voice', 'scenes'].includes(plan.scope)) {
    throw new Error(`revise: model returned unknown scope "${plan.scope}"`);
  }
  const usd = ((json.usage?.input_tokens || 0) / 1000) * 0.003 + ((json.usage?.output_tokens || 0) / 1000) * 0.015;
  return { plan, usd, usage: json.usage || {} };
}

module.exports = { planRevision };
