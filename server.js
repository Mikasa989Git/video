#!/usr/bin/env node
// Local web UI for the video engine. Plain Node `http`, no framework/dependencies —
// consistent with the rest of this project. One video generation at a time.
//
// Usage: node server.js [--port 3939]

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadEnv, ensureDir, slugify, ROOT } = require('./src/util');
const { runPipeline } = require('./src/pipeline');
const { ensureVoiceSample } = require('./src/tts');
const { planRevision } = require('./src/revise');

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

// --- single-job in-memory state ---
// { id, dir, topic, lengthMinutes, voiceId, status: 'running'|'awaiting-approval'|'done'|'error',
//   events: [], sseClients: [], pendingApproval: { stage, resolve } | null }
let currentJob = null;

function broadcast(event) {
  if (!currentJob) return;
  currentJob.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of currentJob.sseClients) res.write(line);
}

function onProgress(evt) {
  if (evt.status === 'checkpoint') {
    currentJob.status = 'awaiting-approval';
    broadcast(evt);
    return new Promise((resolve) => {
      currentJob.pendingApproval = { stage: evt.stage, resolve };
    }).then((result) => {
      currentJob.status = 'running';
      currentJob.pendingApproval = null;
      return result;
    });
  }
  if (evt.stage === 'complete') currentJob.status = 'done';
  if (evt.stage === 'error') currentJob.status = 'error';
  broadcast(evt);
}

function runJob() {
  runPipeline(
    { topic: currentJob.topic, lengthMinutes: currentJob.lengthMinutes, voiceId: currentJob.voiceId, jobDir: currentJob.dir },
    onProgress
  ).catch(() => {
    // runPipeline already emitted an 'error' progress event before rejecting; nothing
    // further to do here besides making sure an unhandled rejection doesn't crash the
    // server process.
  });
}

function startJob({ topic, lengthMinutes, voiceId }) {
  const jobId = `${slugify(topic)}-${Date.now()}`;
  const jobDir = path.join(ROOT, 'output', jobId);
  ensureDir(jobDir);
  currentJob = { id: jobId, dir: jobDir, topic, lengthMinutes, voiceId, status: 'running', events: [], sseClients: [], pendingApproval: null };
  runJob();
  return jobId;
}

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && url.pathname === '/api/voices') {
      const voicesPath = path.join(ROOT, 'config', 'voices.json');
      const data = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
      return sendJson(res, 200, data.voices || []);
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/voice-sample/')) {
      const voiceId = url.pathname.slice('/api/voice-sample/'.length);
      if (!/^[a-z]+$/i.test(voiceId)) return sendJson(res, 400, { error: 'invalid voice id' });
      const samplePath = path.join(ROOT, 'config', 'voice-samples', `${voiceId}.mp3`);
      await ensureVoiceSample(voiceId, samplePath); // cached after the first request per voice
      const content = fs.readFileSync(samplePath);
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': content.length, 'Cache-Control': 'public, max-age=31536000' });
      return res.end(content);
    }

    if (req.method === 'POST' && url.pathname === '/api/generate') {
      if (currentJob && (currentJob.status === 'running' || currentJob.status === 'awaiting-approval')) {
        return sendJson(res, 409, { error: 'A video is already generating. Wait for it to finish first.' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { topic, lengthMinutes, voiceId } = body;
      if (!topic || !String(topic).trim()) return sendJson(res, 400, { error: 'topic is required' });
      const ALLOWED_LENGTHS = [5, 10, 15];
      if (!ALLOWED_LENGTHS.includes(Number(lengthMinutes))) {
        return sendJson(res, 400, { error: `lengthMinutes must be one of ${ALLOWED_LENGTHS.join(', ')}` });
      }
      const jobId = startJob({ topic: String(topic).trim(), lengthMinutes: Number(lengthMinutes), voiceId: voiceId || undefined });
      return sendJson(res, 200, { jobId });
    }

    if (req.method === 'POST' && url.pathname === '/api/approve') {
      if (!currentJob || !currentJob.pendingApproval) {
        return sendJson(res, 409, { error: 'No checkpoint is currently awaiting approval.' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const { resolve } = currentJob.pendingApproval;
      if (body.approved) {
        resolve({ approved: true, content: body.editedContent, voiceId: body.voiceId });
      } else {
        resolve({ approved: false, feedback: body.feedback || '', voiceId: body.voiceId });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/revise') {
      if (!currentJob || currentJob.status !== 'done') {
        return sendJson(res, 409, { error: 'No completed video to revise right now.' });
      }
      const body = JSON.parse((await readBody(req)) || '{}');
      const instructions = String(body.instructions || '').trim();
      if (!instructions) return sendJson(res, 400, { error: 'instructions is required' });

      const jobDir = currentJob.dir;
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
      currentJob.status = 'running';
      currentJob.events = [];
      currentJob.pendingApproval = null;
      if (voiceId) currentJob.voiceId = voiceId;
      runJob();
      return sendJson(res, 200, { ok: true, notes: planResult.plan.notes, scope: planResult.plan.scope });
    }

    if (req.method === 'GET' && url.pathname === '/api/progress') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      if (currentJob) {
        // Replay history so a client that (re)connects mid-job still sees full progress.
        for (const evt of currentJob.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        currentJob.sseClients.push(res);
        req.on('close', () => {
          if (currentJob) currentJob.sseClients = currentJob.sseClients.filter(r => r !== res);
        });
      } else {
        res.write(`data: ${JSON.stringify({ stage: 'idle', status: 'done' })}\n\n`);
      }
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/video/')) {
      const jobId = url.pathname.slice('/api/video/'.length);
      if (!/^[a-z0-9-]+$/i.test(jobId)) return sendJson(res, 400, { error: 'invalid job id' });
      const videoPath = path.join(ROOT, 'output', jobId, 'final_video.mp4');
      if (!fs.existsSync(videoPath)) return sendJson(res, 404, { error: 'video not found' });
      const content = fs.readFileSync(videoPath);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': content.length });
      return res.end(content);
    }

    if (req.method === 'GET' && url.pathname === '/api/current-audio') {
      // Serves the in-progress job's voiceover for the voiceover-approval checkpoint.
      if (!currentJob) return sendJson(res, 404, { error: 'no active job' });
      const audioPath = path.join(currentJob.dir, 'voiceover.mp3');
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
// Whatever the root cause, an unexpected error here should never kill the server; it
// should surface as a broadcast error event for the current job at worst.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  if (currentJob && (currentJob.status === 'running' || currentJob.status === 'awaiting-approval')) {
    currentJob.status = 'error';
    broadcast({ stage: 'error', status: 'done', error: `Internal error: ${err.message}` });
  }
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  if (currentJob && (currentJob.status === 'running' || currentJob.status === 'awaiting-approval')) {
    currentJob.status = 'error';
    broadcast({ stage: 'error', status: 'done', error: `Internal error: ${err instanceof Error ? err.message : err}` });
  }
});

server.listen(PORT, () => {
  console.log(`Video engine UI running at http://localhost:${PORT}`);
});
