// Per-job state, generalized from the single-global-`currentJob` design into a Map keyed
// by jobId so multiple users' videos can run at once. Each entry keeps exactly the shape
// server.js used to hang off the single `currentJob` — this is a mechanical
// generalization, not a redesign, since pipeline.js's checkpoint contract was already
// per-invocation (onProgress is just an opaque callback closed over per call).
//
// Route handlers in server.js are responsible for checking job.userId against the
// requesting user before handing back anything from here — this module doesn't enforce
// ownership itself.

const path = require('path');
const { ensureDir, slugify, ROOT } = require('./util');
const { runPipeline } = require('./pipeline');
const { supabase, SKIP_AUTH } = require('./auth');

// jobId -> { id, dir, userId, topic, lengthMinutes, voiceId,
//            status: 'running'|'awaiting-approval'|'done'|'error',
//            events: [], sseClients: [], pendingApproval: { stage, resolve } | null }
const jobs = new Map();

function broadcast(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.events.push(event);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of job.sseClients) res.write(line);
}

function makeOnProgress(jobId) {
  return function onProgress(evt) {
    const job = jobs.get(jobId);
    if (!job) return;
    if (evt.status === 'checkpoint') {
      job.status = 'awaiting-approval';
      broadcast(jobId, evt);
      return new Promise((resolve) => {
        job.pendingApproval = { stage: evt.stage, resolve };
      }).then((result) => {
        job.status = 'running';
        job.pendingApproval = null;
        return result;
      });
    }
    if (evt.stage === 'complete') job.status = 'done';
    if (evt.stage === 'error') job.status = 'error';
    broadcast(jobId, evt);
  };
}

// Re-entrant by design: /api/revise resets an existing job's status/events and calls
// this again on the same jobId to re-run the pipeline against the same job directory
// (its own skip-if-exists caching means untouched stages are instantly reused).
function runJob(jobId) {
  const job = jobs.get(jobId);
  runPipeline(
    { topic: job.topic, lengthMinutes: job.lengthMinutes, voiceId: job.voiceId, jobDir: job.dir },
    makeOnProgress(jobId)
  ).then(async () => {
    if (!SKIP_AUTH) await supabase().from('video_jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', jobId);
  }).catch(async () => {
    // runPipeline already emitted an 'error' progress event before rejecting; just make
    // sure an unhandled rejection doesn't crash the server, and that the persisted record
    // reflects the failure too.
    if (!SKIP_AUTH) await supabase().from('video_jobs').update({ status: 'error' }).eq('id', jobId).catch(() => {});
  });
}

async function startJob({ userId, topic, lengthMinutes, voiceId }) {
  const jobId = `${slugify(topic)}-${Date.now()}`;
  const jobDir = path.join(ROOT, 'output', jobId);
  ensureDir(jobDir);
  jobs.set(jobId, { id: jobId, dir: jobDir, userId, topic, lengthMinutes, voiceId, status: 'running', events: [], sseClients: [], pendingApproval: null, startedAt: Date.now() });
  if (!SKIP_AUTH) await supabase().from('video_jobs').insert({ id: jobId, user_id: userId, topic, length_minutes: lengthMinutes, status: 'running', job_dir: jobDir });
  runJob(jobId);
  return jobId;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

// The most recent in-flight (or just-finished-this-connection) job for a user, so a page
// reload can resume the right job instead of assuming there's only ever one in the world.
function getActiveJobForUser(userId) {
  let best = null;
  for (const job of jobs.values()) {
    if (job.userId !== userId) continue;
    if (!best || job.startedAt > best.startedAt) best = job;
  }
  return best;
}

// Used by server.js's process-level crash handlers — a single uncaught exception could
// otherwise leave every in-flight job's SSE clients hanging forever with no explanation.
function markAllRunningJobsErrored(message) {
  for (const [jobId, job] of jobs) {
    if (job.status === 'running' || job.status === 'awaiting-approval') {
      job.status = 'error';
      broadcast(jobId, { stage: 'error', status: 'done', error: message });
    }
  }
}

module.exports = { broadcast, startJob, getJob, runJob, markAllRunningJobsErrored, getActiveJobForUser };
