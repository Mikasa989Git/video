#!/usr/bin/env node
// Web UI + API for the video engine. Plain Node `http`, no framework — the one dependency
// this project has ever needed is @supabase/supabase-js, for auth/session verification and
// the database (see the "Accounts, Subscriptions & Multi-User" plan). Multiple users can
// generate videos at the same time; each job is scoped to the user who started it.
//
// Usage: node server.js [--port 3939]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv, ensureDir, slugify, ROOT } = require('./src/util');
const { runPipeline } = require('./src/pipeline');
const { ensureVoiceSample } = require('./src/tts');
const { planRevision } = require('./src/revise');
const { verifyRequestAuth, verifyToken, supabase, SKIP_AUTH } = require('./src/auth');
const { startJob, getJob, runJob, markAllRunningJobsErrored, getActiveJobForUser } = require('./src/jobs');
const payplus = require('./src/payplus');

loadEnv();

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  if (i !== -1) return Number(process.argv[i + 1]);
  // Render (and most PaaS hosts) assign the port via $PORT and require the app to bind
  // to it — a hardcoded port means the platform's health check never reaches the app.
  return Number(process.env.PORT) || 3939;
})();

const WEB_DIR = path.join(__dirname, 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg' };

const PRICING_TIERS = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'pricing-tiers.json'), 'utf8')).tiers;
function tierById(id) { return PRICING_TIERS.find(t => t.id === id) || null; }

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(filePath);
  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': content.length });
  res.end(content);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sceneImagePath(jobDir, scene) {
  return path.join(jobDir, 'images', `scene${String(scene).padStart(3, '0')}.png`);
}
function rmIfExists(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

// Applies a revision plan by deleting only the cache files that need to regenerate, then
// re-running the pipeline on the SAME job directory — its existing skip-if-exists
// resumability means everything untouched is reused instantly, at zero extra cost.
function applyRevisionPlan(jobDir, plan) {
  const p = {
    voiceover: path.join(jobDir, 'voiceover.mp3'),
    ttsChunks: path.join(jobDir, '.tts_chunks'),
    shots: path.join(jobDir, 'shots.json'),
    transcript: path.join(jobDir, 'transcript.json'),
    aligned: path.join(jobDir, 'aligned_shots.json'),
    prompts: path.join(jobDir, 'image_prompts.json'),
    video: path.join(jobDir, 'final_video.mp4'),
    concatList: path.join(jobDir, '.images_concat.txt'),
    script: path.join(jobDir, 'script.txt'),
  };

  if (plan.scope === 'script') {
    fs.writeFileSync(p.script, plan.newScript);
    for (const key of ['voiceover', 'ttsChunks', 'shots', 'transcript', 'aligned', 'prompts', 'video', 'concatList']) rmIfExists(p[key]);
    rmIfExists(path.join(jobDir, 'images'));
    return { voiceId: undefined };
  }

  if (plan.scope === 'voice') {
    for (const key of ['voiceover', 'ttsChunks', 'transcript', 'aligned', 'video', 'concatList']) rmIfExists(p[key]);
    return { voiceId: plan.voiceId };
  }

  if (plan.scope === 'scenes') {
    const prompts = JSON.parse(fs.readFileSync(p.prompts, 'utf8'));
    for (const edit of plan.sceneEdits || []) {
      const entry = prompts.find(x => x.scene === edit.scene);
      if (entry) entry.prompt = edit.newPrompt;
      rmIfExists(sceneImagePath(jobDir, edit.scene));
    }
    fs.writeFileSync(p.prompts, JSON.stringify(prompts, null, 2));
    for (const key of ['video', 'concatList']) rmIfExists(p[key]);
    return { voiceId: undefined };
  }

  throw new Error(`Unknown revision scope "${plan.scope}"`);
}

// Fetches the caller's active subscription (with its tier merged in), lazily rolling the
// billing period forward (and zeroing usage) if it's expired — a pull-based reset instead
// of a separate cron job, checked the one place usage actually matters.
async function getActiveSubscription(userId) {
  if (SKIP_AUTH) {
    const tier = tierById('studio') || PRICING_TIERS[PRICING_TIERS.length - 1];
    return { id: 'skip-auth', user_id: userId, tier_id: tier.id, status: 'active', videos_used_current_period: 0, current_period_start: new Date().toISOString(), current_period_end: new Date(Date.now() + 30 * 86400000).toISOString(), tier };
  }
  const { data: sub } = await supabase().from('subscriptions').select('*').eq('user_id', userId).eq('status', 'active').maybeSingle();
  if (!sub) return null;
  const tier = tierById(sub.tier_id);
  if (!tier) return null;

  if (new Date(sub.current_period_end) < new Date()) {
    const newStart = new Date();
    const newEnd = new Date(newStart);
    newEnd.setMonth(newEnd.getMonth() + 1);
    sub.videos_used_current_period = 0;
    sub.current_period_start = newStart.toISOString();
    sub.current_period_end = newEnd.toISOString();
    await supabase().from('subscriptions').update({
      videos_used_current_period: 0,
      current_period_start: sub.current_period_start,
      current_period_end: sub.current_period_end,
    }).eq('id', sub.id);
  }

  return { ...sub, tier };
}

function originFor(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/voices') {
      const voicesPath = path.join(ROOT, 'config', 'voices.json');
      const data = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
      return sendJson(res, 200, data.voices || []);
    }

    if (req.method === 'GET' && url.pathname === '/api/pricing-tiers') {
      return sendJson(res, 200, PRICING_TIERS);
    }

    // SUPABASE_URL/SUPABASE_ANON_KEY are meant to be public (that's how every Supabase
    // browser app ships them) — this just avoids needing a build step to inject them into
    // static JS. Never expose SUPABASE_SERVICE_ROLE_KEY this way; that one stays server-only.
    if (req.method === 'GET' && url.pathname === '/api/public-config') {
      return sendJson(res, 200, { supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY, authDisabled: SKIP_AUTH });
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/voice-sample/')) {
      const voiceId = url.pathname.slice('/api/voice-sample/'.length);
      if (!/^[a-z0-9]+$/i.test(voiceId)) return sendJson(res, 400, { error: 'invalid voice id' });
      const samplePath = path.join(ROOT, 'config', 'voice-samples', `${voiceId}.mp3`);
      await ensureVoiceSample(voiceId, samplePath); // cached after the first request per voice
      const content = fs.readFileSync(samplePath);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': content.length, 'Cache-Control': 'public, max-age=31536000' });
      return res.end(content);
    }

    // --- account / billing routes ---

    if (req.method === 'GET' && url.pathname === '/api/me') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const subscription = await getActiveSubscription(auth.userId);
      const activeJob = getActiveJobForUser(auth.userId);
      return sendJson(res, 200, { email: auth.email, subscription, activeJobId: activeJob ? activeJob.id : null });
    }

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const tier = tierById(body.tierId);
      if (!tier) return sendJson(res, 400, { error: 'unknown tier' });

      const origin = originFor(req);
      const link = await payplus.createPaymentLink({
        userId: auth.userId,
        tier,
        email: auth.email,
        customerName: auth.email,
        successUrl: `${origin}/pricing.html?status=success`,
        failureUrl: `${origin}/pricing.html?status=failure`,
        callbackUrl: `${origin}/api/webhooks/payplus`,
      });
      return sendJson(res, 200, { paymentPageLink: link });
    }

    if (req.method === 'POST' && url.pathname === '/api/webhooks/payplus') {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const verified = payplus.verifyCallbackSignature(body, req.headers['hash'], req.headers['user-agent']);
      if (!verified) { res.writeHead(401); return res.end('invalid signature'); }

      const parsed = payplus.parseCallbackPayload(body);
      if (!parsed.success || !parsed.userId || !parsed.tierId) { res.writeHead(200); return res.end('ignored'); }

      // Idempotency: PayPlus may retry a callback; only act on a transaction uid once.
      const { error: dupeErr } = await supabase().from('payplus_events').insert({
        event_uid: parsed.transactionUid, event_type: 'charge', payload: body,
      });
      if (dupeErr) { res.writeHead(200); return res.end('already processed'); } // unique constraint hit

      const tier = tierById(parsed.tierId);
      const recurringUid = await payplus.createRecurringSubscription({
        cardToken: parsed.cardToken, customerUid: parsed.customerUid, tier,
      });

      const now = new Date();
      const periodEnd = new Date(now); periodEnd.setMonth(periodEnd.getMonth() + 1);
      await supabase().from('subscriptions').upsert({
        user_id: parsed.userId,
        tier_id: tier.id,
        status: 'active',
        payplus_recurring_uid: recurringUid,
        payplus_card_token: parsed.cardToken,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        videos_used_current_period: 0,
      }, { onConflict: 'user_id' });

      res.writeHead(200); return res.end('ok');
    }

    if (req.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const sub = await getActiveSubscription(auth.userId);
      if (!sub) return sendJson(res, 409, { error: 'no active subscription' });
      if (sub.payplus_recurring_uid) await payplus.cancelSubscription(sub.payplus_recurring_uid);
      await supabase().from('subscriptions').update({ status: 'canceled' }).eq('id', sub.id);
      return sendJson(res, 200, { ok: true });
    }

    // --- video generation routes (all scoped to the authenticated user) ---

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });

      const subscription = await getActiveSubscription(auth.userId);
      if (!subscription) return sendJson(res, 402, { error: 'No active subscription — subscribe to a plan first.' });

      const body = JSON.parse((await readBody(req)) || '{}');
      const { topic, lengthMinutes, voiceId } = body;
      if (!topic || !String(topic).trim()) return sendJson(res, 400, { error: 'topic is required' });
      const ALLOWED_LENGTHS = [5, 10, 15];
      if (!ALLOWED_LENGTHS.includes(Number(lengthMinutes))) {
        return sendJson(res, 400, { error: `lengthMinutes must be one of ${ALLOWED_LENGTHS.join(', ')}` });
      }
      if (Number(lengthMinutes) > subscription.tier.max_video_length_minutes) {
        return sendJson(res, 403, { error: `Your plan (${subscription.tier.name}) supports up to ${subscription.tier.max_video_length_minutes} minute videos.` });
      }
      if (subscription.videos_used_current_period >= subscription.tier.included_videos_per_month) {
        return sendJson(res, 403, { error: `You've used all ${subscription.tier.included_videos_per_month} videos included in your plan this period.` });
      }

      const jobId = await startJob({ userId: auth.userId, topic: String(topic).trim(), lengthMinutes: Number(lengthMinutes), voiceId: voiceId || undefined });
      if (!SKIP_AUTH) await supabase().from('subscriptions').update({ videos_used_current_period: subscription.videos_used_current_period + 1 }).eq('id', subscription.id);
      return sendJson(res, 200, { jobId });
    }

    if (req.method === 'POST' && url.pathname === '/api/approve') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const job = getJob(body.jobId);
      if (!job || job.userId !== auth.userId) return sendJson(res, 404, { error: 'job not found' });
      if (!job.pendingApproval) return sendJson(res, 409, { error: 'No checkpoint is currently awaiting approval.' });
      const { resolve } = job.pendingApproval;
      if (body.approved) {
        resolve({ approved: true, content: body.editedContent, voiceId: body.voiceId });
      } else {
        resolve({ approved: false, feedback: body.feedback || '', voiceId: body.voiceId });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/revise') {
      const auth = await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const job = getJob(body.jobId);
      if (!job || job.userId !== auth.userId) return sendJson(res, 404, { error: 'job not found' });
      if (job.status !== 'done') return sendJson(res, 409, { error: 'No completed video to revise right now.' });
      const instructions = String(body.instructions || '').trim();
      if (!instructions) return sendJson(res, 400, { error: 'instructions is required' });

      const jobDir = job.dir;
      const scriptText = fs.readFileSync(path.join(jobDir, 'script.txt'), 'utf8');
      const shots = JSON.parse(fs.readFileSync(path.join(jobDir, 'shots.json'), 'utf8'));
      const prompts = JSON.parse(fs.readFileSync(path.join(jobDir, 'image_prompts.json'), 'utf8'));
      const shotsWithPrompts = shots.map(s => {
        const pr = prompts.find(x => x.scene === s.scene);
        return { ...s, narrator: !!pr?.narrator, prompt: pr?.prompt || s.text };
      });

      let planResult;
      try {
        planResult = await planRevision(instructions, { scriptText, shotsWithPrompts });
      } catch (err) {
        return sendJson(res, 500, { error: `Couldn't plan that revision: ${err.message}` });
      }

      const { voiceId } = applyRevisionPlan(jobDir, planResult.plan);
      job.status = 'running';
      job.events = [];
      job.pendingApproval = null;
      if (voiceId) job.voiceId = voiceId;
      runJob(job.id);
      return sendJson(res, 200, { ok: true, notes: planResult.plan.notes, scope: planResult.plan.scope });
    }

    if (req.method === 'GET' && url.pathname === '/api/progress') {
      // Native EventSource can't set an Authorization header, so this one route also
      // accepts the access token as a query param (the browser side builds the URL that
      // way specifically for this endpoint — see web/auth-client.js's authedEventSource).
      const auth = await verifyToken(url.searchParams.get('token')) || await verifyRequestAuth(req);
      if (!auth) { res.writeHead(401); return res.end('not signed in'); }
      const jobId = url.searchParams.get('jobId');
      const job = jobId ? getJob(jobId) : null;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      if (job && job.userId === auth.userId) {
        // Replay history so a client that (re)connects mid-job still sees full progress.
        for (const evt of job.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        job.sseClients.push(res);
        req.on('close', () => {
          job.sseClients = job.sseClients.filter(r => r !== res);
        });
      } else {
        res.write(`data: ${JSON.stringify({ stage: 'idle', status: 'done' })}\n\n`);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/video/')) {
      // <video src> / download-link <a href> can't carry an Authorization header either —
      // same query-param-token accommodation as /api/progress.
      const auth = await verifyToken(url.searchParams.get('token')) || await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const jobId = url.pathname.slice('/api/video/'.length);
      if (!/^[a-z0-9-]+$/i.test(jobId)) return sendJson(res, 400, { error: 'invalid job id' });
      const job = getJob(jobId);
      if (!job || job.userId !== auth.userId) return sendJson(res, 404, { error: 'video not found' });
      const videoPath = path.join(job.dir, 'final_video.mp4');
      if (!fs.existsSync(videoPath)) return sendJson(res, 404, { error: 'video not found' });
      const content = fs.readFileSync(videoPath);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': content.length });
      return res.end(content);
    }

    if (req.method === 'GET' && url.pathname === '/api/current-audio') {
      // <audio src> can't carry an Authorization header — same query-param-token
      // accommodation as /api/progress.
      const auth = await verifyToken(url.searchParams.get('token')) || await verifyRequestAuth(req);
      if (!auth) return sendJson(res, 401, { error: 'not signed in' });
      const jobId = url.searchParams.get('jobId');
      const job = jobId ? getJob(jobId) : null;
      if (!job || job.userId !== auth.userId) return sendJson(res, 404, { error: 'no active job' });
      const audioPath = path.join(job.dir, 'voiceover.mp3');
      if (!fs.existsSync(audioPath)) return sendJson(res, 404, { error: 'voiceover not ready yet' });
      const content = fs.readFileSync(audioPath);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': content.length });
      return res.end(content);
    }

    if (req.method === 'GET') return serveStatic(req, res, url.pathname);

    res.writeHead(404); res.end('Not found');
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

// A crashed backend takes down every SSE connection and the whole page with it — bad for
// a product server. This was hit for real: the process exited with code 4 mid-run.
// Whatever the root cause, an unexpected error here should never kill the server.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  markAllRunningJobsErrored(`Internal error: ${err.message}`);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  markAllRunningJobsErrored(`Internal error: ${err instanceof Error ? err.message : err}`);
});

server.listen(PORT, () => {
  console.log(`Video engine UI running at http://localhost:${PORT}`);
});
