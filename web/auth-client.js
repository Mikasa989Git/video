// Shared Supabase auth wrapper for every page (login.html, pricing.html, app.js). Loaded
// as an ES module — no bundler; the Supabase client itself comes from a CDN ESM build,
// consistent with this project's no-build-step approach everywhere else.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

let _client = null;
let _clientPromise = null;
let _configPromise = null;

// Cached — every function below needs this, and it never changes within a page load.
async function getConfig() {
  if (!_configPromise) _configPromise = fetch('/api/public-config').then(r => r.json());
  return _configPromise;
}

async function getClient() {
  if (_client) return _client;
  if (!_clientPromise) {
    _clientPromise = (async () => {
      const cfg = await getConfig();
      if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        throw new Error('Supabase is not configured on the server (missing SUPABASE_URL/SUPABASE_ANON_KEY).');
      }
      _client = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      return _client;
    })();
  }
  return _clientPromise;
}

const SKIP_AUTH_SESSION = { access_token: null, user: { email: 'test@local' } };

// Used on every page just to decide "signed in or not" for nav/CTA state — if Supabase
// itself isn't configured yet (e.g. before SUPABASE_URL/SUPABASE_ANON_KEY are set), that
// should read as "not signed in," not an uncaught error breaking the whole page. If the
// server has SKIP_AUTH on (see src/auth.js), everyone reads as already signed in.
export async function getSession() {
  const cfg = await getConfig();
  if (cfg.authDisabled) return SKIP_AUTH_SESSION;
  try {
    const client = await getClient();
    const { data: { session } } = await client.auth.getSession();
    return session; // null if not signed in
  } catch (err) {
    console.warn('[auth] could not check session:', err.message);
    return null;
  }
}

export async function getAccessToken() {
  const session = await getSession();
  return session ? session.access_token : null;
}

export async function signUp(email, password) {
  const client = await getClient();
  return client.auth.signUp({ email, password });
}

export async function signIn(email, password) {
  const client = await getClient();
  return client.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  const cfg = await getConfig();
  if (cfg.authDisabled) { window.location.href = '/'; return; } // nothing to actually sign out of
  const client = await getClient();
  await client.auth.signOut();
  window.location.href = '/login.html';
}

// Attaches the current session's bearer token to a fetch call against our own /api/*
// routes. Not usable for EventSource/<audio>/<video> src, which can't carry custom
// headers — those build a URL with withToken() instead.
export async function authedFetch(url, options = {}) {
  const token = await getAccessToken();
  const headers = { ...(options.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// For EventSource/<audio src>/<video src>/<a href> — appends ?token=... (or &token=...)
// since those browser APIs can't set custom headers.
export async function withToken(url) {
  const token = await getAccessToken();
  const sep = url.includes('?') ? '&' : '?';
  return token ? `${url}${sep}token=${encodeURIComponent(token)}` : url;
}

// Redirects to /login.html (preserving the current path as ?next=) if not signed in.
// Callers should await this before doing anything that assumes a signed-in user.
export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    window.location.href = '/login.html?next=' + encodeURIComponent(window.location.pathname + window.location.search);
    return null;
  }
  return session;
}
