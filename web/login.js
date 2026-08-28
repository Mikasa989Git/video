import { getSession, signUp, signIn } from './auth-client.js';

const form = document.getElementById('auth-form');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const submitBtn = document.getElementById('submit-btn');
const serverErrorEl = document.getElementById('form-server-error');
const noticeEl = document.getElementById('form-notice');
const titleEl = document.getElementById('form-title');
const subtitleEl = document.getElementById('form-subtitle');
const toggleTextEl = document.getElementById('toggle-text');
const toggleBtn = document.getElementById('toggle-mode-btn');

const params = new URLSearchParams(window.location.search);
const nextPath = params.get('next') || '/app.html';

let mode = 'signin'; // or 'signup'

function applyMode() {
  if (mode === 'signin') {
    titleEl.textContent = 'Sign in';
    subtitleEl.textContent = 'Welcome back.';
    submitBtn.textContent = 'Sign in';
    toggleTextEl.textContent = "Don't have an account?";
    toggleBtn.textContent = 'Sign up';
  } else {
    titleEl.textContent = 'Create an account';
    subtitleEl.textContent = 'Start generating videos in a couple minutes.';
    submitBtn.textContent = 'Sign up';
    toggleTextEl.textContent = 'Already have an account?';
    toggleBtn.textContent = 'Sign in';
  }
  serverErrorEl.hidden = true;
  noticeEl.hidden = true;
}

toggleBtn.addEventListener('click', () => {
  mode = mode === 'signin' ? 'signup' : 'signin';
  applyMode();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  serverErrorEl.hidden = true;
  noticeEl.hidden = true;
  submitBtn.disabled = true;

  const email = emailEl.value.trim();
  const password = passwordEl.value;

  try {
    if (mode === 'signup') {
      const { error } = await signUp(email, password);
      if (error) throw error;
      noticeEl.textContent = 'Account created — check your email to confirm, then sign in.';
      noticeEl.hidden = false;
      mode = 'signin';
      applyMode();
    } else {
      const { error } = await signIn(email, password);
      if (error) throw error;
      window.location.href = nextPath;
    }
  } catch (err) {
    serverErrorEl.textContent = err.message || String(err);
    serverErrorEl.hidden = false;
  } finally {
    submitBtn.disabled = false;
  }
});

applyMode();

// Already signed in? Skip straight past the login form.
getSession().then((session) => {
  if (session) window.location.href = nextPath;
});
