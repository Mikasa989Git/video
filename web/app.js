import { requireAuth, authedFetch, withToken, signOut } from './auth-client.js';

const STAGES = ['script', 'voiceover', 'segment', 'transcribe', 'align', 'promptgen', 'images', 'assemble'];
const STAGE_LABELS = {
  script: 'Writing script', voiceover: 'Generating voiceover', segment: 'Breaking into scenes',
  transcribe: 'Analyzing timing', align: 'Syncing scenes to audio', promptgen: 'Directing visuals',
  images: 'Generating images', assemble: 'Assembling video',
};

const views = {
  form: document.getElementById('view-form'),
  progress: document.getElementById('view-progress'),
  checkpoint: document.getElementById('view-checkpoint'),
  result: document.getElementById('view-result'),
  error: document.getElementById('view-error'),
};

function showView(name) {
  for (const key of Object.keys(views)) views[key].hidden = key !== name;
}

document.getElementById('signout-btn').addEventListener('click', signOut);

// The job this browser tab is currently tracking — set when a video is started, or
// resumed from /api/me's activeJobId on load (each user's jobs live server-side keyed by
// id now, rather than there being a single global job for the whole server).
let currentJobId = null;

// --- populate optional voice picker ---
const previewPlayer = document.getElementById('voice-preview-player');
let currentlyPlayingBtn = null;

function stopPreview() {
  previewPlayer.pause();
  if (currentlyPlayingBtn) currentlyPlayingBtn.classList.remove('playing');
  currentlyPlayingBtn = null;
}

function playVoiceSample(voiceId, btn) {
  if (currentlyPlayingBtn === btn) { stopPreview(); return; } // toggle off if clicked again
  stopPreview();
  btn.classList.add('loading');
  previewPlayer.src = `/api/voice-sample/${voiceId}`;
  previewPlayer.play().catch(() => {}); // e.g. user hasn't interacted with the page yet
  currentlyPlayingBtn = btn;
}
previewPlayer.addEventListener('playing', () => { if (currentlyPlayingBtn) { currentlyPlayingBtn.classList.remove('loading'); currentlyPlayingBtn.classList.add('playing'); } });
previewPlayer.addEventListener('ended', stopPreview);
previewPlayer.addEventListener('error', () => { if (currentlyPlayingBtn) currentlyPlayingBtn.classList.remove('loading'); });

async function loadOptions() {
  try {
    const voices = await (await fetch('/api/voices')).json();
    const picker = document.getElementById('voice-picker');
    for (const v of voices) {
      if (!v.voiceId || v.voiceId.startsWith('REPLACE_WITH')) continue; // not configured yet
      const row = document.createElement('label');
      row.className = 'voice-option';
      row.innerHTML = `
        <input type="radio" name="voice" value="${v.voiceId}">
        <span class="voice-option-label">${v.label}</span>
        <button type="button" class="voice-play-btn" aria-label="Preview ${v.label}">&#9654;</button>
      `;
      row.querySelector('.voice-play-btn').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        playVoiceSample(v.voiceId, e.currentTarget);
      });
      picker.appendChild(row);
    }
  } catch { /* voices are optional; leave just "Default" */ }
}

// --- form validation ---
const topicEl = document.getElementById('topic');
const lengthEl = document.getElementById('length');
const submitBtn = document.getElementById('submit-btn');
const form = document.getElementById('generate-form');
const serverErrorEl = document.getElementById('form-server-error');

function isValid() {
  return topicEl.value.trim().length > 0 && Number(lengthEl.value) > 0;
}
function refreshSubmitState() {
  submitBtn.disabled = !isValid();
}
topicEl.addEventListener('input', refreshSubmitState);
lengthEl.addEventListener('input', refreshSubmitState);

document.querySelectorAll('.length-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.length-option').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    lengthEl.value = btn.dataset.value;
    lengthEl.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('length-picker').closest('.field').classList.remove('invalid');
  });
});

function markInvalid(el, invalid) {
  el.closest('.field').classList.toggle('invalid', invalid);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  stopPreview();
  serverErrorEl.hidden = true;
  const topicInvalid = topicEl.value.trim().length === 0;
  const lengthInvalid = !(Number(lengthEl.value) > 0);
  markInvalid(topicEl, topicInvalid);
  markInvalid(lengthEl, lengthInvalid);
  if (topicInvalid || lengthInvalid) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Starting…';

  try {
    const res = await authedFetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: topicEl.value.trim(),
        lengthMinutes: Number(lengthEl.value),
        voiceId: (document.querySelector('input[name="voice"]:checked') || {}).value || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    currentJobId = data.jobId;
    startProgressView();
  } catch (err) {
    serverErrorEl.textContent = err.message;
    serverErrorEl.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate Video';
  }
});

// --- progress view ---
const progressSubtitle = document.getElementById('progress-subtitle');
const costValueEl = document.getElementById('cost-value');
const imagesSubprogress = document.getElementById('images-subprogress');
const imagesFill = document.getElementById('images-fill');
const imagesCount = document.getElementById('images-count');

function resetStepper() {
  for (const stage of STAGES) {
    const li = document.querySelector(`#stepper li[data-stage="${stage}"]`);
    li.classList.remove('active', 'done');
  }
  imagesSubprogress.hidden = true;
  imagesFill.style.width = '0%';
  costValueEl.textContent = '$0.00';
}

function applyStageEvent(evt) {
  const idx = STAGES.indexOf(evt.stage);
  if (idx === -1) return;
  const li = document.querySelector(`#stepper li[data-stage="${evt.stage}"]`);
  if (evt.status === 'start') {
    li.classList.add('active');
    li.classList.remove('done');
    progressSubtitle.textContent = STAGE_LABELS[evt.stage] + '…';
  } else if (evt.status === 'done') {
    li.classList.remove('active');
    li.classList.add('done');
  } else if (evt.status === 'progress' && evt.stage === 'images') {
    imagesSubprogress.hidden = false;
    const pct = evt.total ? Math.round((evt.current / evt.total) * 100) : 0;
    imagesFill.style.width = pct + '%';
    imagesCount.textContent = `${evt.current}/${evt.total}`;
    progressSubtitle.textContent = `Generating images (${evt.current}/${evt.total})…`;
  }
}

let eventSource = null;
let hasSeenJob = false;

function startProgressView() {
  hasSeenJob = true;
  resetStepper();
  showView('progress');
  connectProgressStream();
}

// Called once on load too (after resuming currentJobId from /api/me), so reloading or
// opening the page mid-run shows the real current state instead of a blank form.
async function connectProgressStream() {
  if (!currentJobId) return;
  if (eventSource) eventSource.close();
  const url = await withToken(`/api/progress?jobId=${encodeURIComponent(currentJobId)}`);
  eventSource = new EventSource(url);
  eventSource.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    if (evt.stage === 'idle') return;
    if (!hasSeenJob) {
      hasSeenJob = true;
      resetStepper();
      showView('progress');
    }
    if (evt.stage === 'cost') {
      costValueEl.textContent = '$' + evt.costSoFar.toFixed(2);
      return;
    }
    if (evt.stage === 'complete') {
      costValueEl.textContent = '$' + evt.costSoFar.toFixed(2);
      eventSource.close();
      showResult(evt);
      return;
    }
    if (evt.stage === 'error') {
      eventSource.close();
      showError(evt.error);
      return;
    }
    if (evt.status === 'checkpoint') {
      showCheckpoint(evt);
      return;
    }
    if (views.checkpoint.hidden === false) showView('progress'); // leaving a checkpoint back into progress
    applyStageEvent(evt);
  };
  eventSource.onerror = () => {
    // Connection hiccup — EventSource auto-reconnects; nothing to do here except avoid
    // silently failing forever if the server is actually gone.
  };
}

// --- checkpoint view (script / voiceover / prompts review) ---
const checkpointTitle = document.getElementById('checkpoint-title');
const checkpointSubtitle = document.getElementById('checkpoint-subtitle');
const checkpointScriptBlock = document.getElementById('checkpoint-script-block');
const checkpointScriptText = document.getElementById('checkpoint-script-text');
const checkpointVoiceoverBlock = document.getElementById('checkpoint-voiceover-block');
const checkpointAudio = document.getElementById('checkpoint-audio');
const checkpointPromptsBlock = document.getElementById('checkpoint-prompts-block');
const promptsSummaryEl = document.getElementById('prompts-summary');
const checkpointFeedback = document.getElementById('checkpoint-feedback');
const checkpointServerError = document.getElementById('checkpoint-server-error');

const CHECKPOINT_INFO = {
  script: { title: 'Review the script', subtitle: 'Read it over, edit anything directly, then approve to continue.' },
  voiceover: { title: 'Review the voiceover', subtitle: 'Listen to the narration before it goes to image generation.' },
  promptgen: { title: 'Review the visual direction', subtitle: "Here's a preview of the planned scenes before generating all the images." },
};

let currentCheckpointStage = null;

async function showCheckpoint(evt) {
  currentCheckpointStage = evt.stage;
  const info = CHECKPOINT_INFO[evt.stage] || { title: 'Review', subtitle: '' };
  checkpointTitle.textContent = info.title;
  checkpointSubtitle.textContent = info.subtitle;
  checkpointServerError.hidden = true;
  checkpointFeedback.value = '';

  checkpointScriptBlock.hidden = evt.stage !== 'script';
  checkpointVoiceoverBlock.hidden = evt.stage !== 'voiceover';
  checkpointPromptsBlock.hidden = evt.stage !== 'promptgen';

  if (evt.stage === 'script') {
    checkpointScriptText.value = evt.content || '';
  } else if (evt.stage === 'voiceover') {
    checkpointAudio.src = await withToken(`/api/current-audio?jobId=${encodeURIComponent(currentJobId)}&t=${Date.now()}`);
  } else if (evt.stage === 'promptgen') {
    const c = evt.content || {};
    const sampleLines = (c.sample || []).map(s => `<div class="prompts-summary-row"><strong>Scene ${s.scene}</strong>${s.narrator ? ' (narrator)' : ''}: ${s.prompt}</div>`).join('');
    promptsSummaryEl.innerHTML = `<p>${c.totalShots} scenes planned (${c.narratorShots} with the narrator on screen). First few:</p>${sampleLines}`;
  }

  showView('checkpoint');
}

async function submitApproval(body) {
  checkpointServerError.hidden = true;
  try {
    const res = await authedFetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, jobId: currentJobId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    showView('progress');
  } catch (err) {
    checkpointServerError.textContent = err.message;
    checkpointServerError.hidden = false;
  }
}

document.getElementById('checkpoint-approve-btn').addEventListener('click', () => {
  const body = { approved: true };
  if (currentCheckpointStage === 'script') body.editedContent = checkpointScriptText.value;
  submitApproval(body);
});

document.getElementById('checkpoint-regenerate-btn').addEventListener('click', () => {
  const feedback = checkpointFeedback.value.trim();
  if (!feedback) {
    checkpointServerError.textContent = 'Describe what you want changed first.';
    checkpointServerError.hidden = false;
    return;
  }
  submitApproval({ approved: false, feedback });
});

// --- result view ---
const resultVideo = document.getElementById('result-video');
const downloadLink = document.getElementById('download-link');
const costBreakdownEl = document.getElementById('cost-breakdown');

async function showResult(evt) {
  const jobId = jobIdFromPath(evt.videoPath);
  const videoUrl = await withToken(`/api/video/${jobId}`);
  resultVideo.src = videoUrl;
  downloadLink.href = videoUrl;

  costBreakdownEl.innerHTML = '';
  for (const entry of evt.costEntries || []) {
    const row = document.createElement('div');
    row.className = 'cost-breakdown-row';
    row.innerHTML = `<span>${entry.stage}${entry.detail ? ' — ' + entry.detail : ''}</span><span>$${entry.usd.toFixed(4)}</span>`;
    costBreakdownEl.appendChild(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 'cost-breakdown-row total';
  totalRow.innerHTML = `<span>Total</span><span>$${evt.costSoFar.toFixed(4)}</span>`;
  costBreakdownEl.appendChild(totalRow);

  showView('result');
}

function jobIdFromPath(videoPath) {
  // videoPath looks like .../output/<jobId>/final_video.mp4
  const parts = videoPath.split(/[\\/]/);
  return parts[parts.length - 2];
}

document.getElementById('make-another-btn').addEventListener('click', () => {
  currentJobId = null;
  form.reset();
  document.querySelectorAll('.field.invalid').forEach(f => f.classList.remove('invalid'));
  document.querySelectorAll('.length-option.selected').forEach(b => b.classList.remove('selected'));
  submitBtn.disabled = true;
  submitBtn.textContent = 'Generate Video';
  showView('form');
});

// --- revise box (request changes to a finished video) ---
const reviseInput = document.getElementById('revise-input');
const reviseBtn = document.getElementById('revise-btn');
const reviseServerError = document.getElementById('revise-server-error');

reviseBtn.addEventListener('click', async () => {
  const instructions = reviseInput.value.trim();
  reviseServerError.hidden = true;
  if (!instructions) {
    reviseServerError.textContent = 'Describe the change you want first.';
    reviseServerError.hidden = false;
    return;
  }
  reviseBtn.disabled = true;
  reviseBtn.textContent = 'Applying…';
  try {
    const res = await authedFetch('/api/revise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions, jobId: currentJobId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    reviseInput.value = '';
    hasSeenJob = true; // already have an open EventSource; just switch views for the new cycle
    resetStepper();
    showView('progress');
  } catch (err) {
    reviseServerError.textContent = err.message;
    reviseServerError.hidden = false;
  } finally {
    reviseBtn.disabled = false;
    reviseBtn.textContent = 'Request Changes';
  }
});

// --- error view ---
function showError(message) {
  document.getElementById('error-message').textContent = message;
  showView('error');
}
document.getElementById('error-back-btn').addEventListener('click', () => {
  submitBtn.disabled = !isValid();
  submitBtn.textContent = 'Generate Video';
  showView('form');
});

// --- boot: require auth + an active subscription before showing anything, then resume
// whatever job (if any) this user already has in flight ---
async function boot() {
  const session = await requireAuth(); // redirects to /login.html if not signed in
  if (!session) return;

  refreshSubmitState();
  loadOptions();

  let me;
  try {
    me = await (await authedFetch('/api/me')).json();
  } catch {
    showError('Could not reach the server. Try reloading.');
    return;
  }
  if (!me.subscription) {
    window.location.href = '/pricing.html';
    return;
  }

  if (me.activeJobId) {
    currentJobId = me.activeJobId;
    await connectProgressStream();
  } else {
    showView('form');
  }
}
boot();
