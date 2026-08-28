// Verifies the bearer token a browser attaches to authenticated /api requests, and gives
// the rest of the server a single Supabase client (service role — bypasses RLS, since the
// existing architecture pattern is "the browser only ever talks to our server," not
// directly to third parties; the one exception is the Auth handshake itself, which the
// browser's own Supabase client performs directly).

const { createClient } = require('@supabase/supabase-js');
const { requireEnvOrThrow } = require('./util');

// Test-only escape hatch for trying the product before Supabase/PayPlus are set up (e.g.
// a quick friend demo) — never on by default, and deliberately loud about it in logs.
// Risk, made explicit: with this on, EVERY request is treated as the same fixed user (no
// real login wall, no per-visitor isolation) and there is no usage cap — anyone who can
// reach the deployed URL can generate videos on your API keys' real money. Turn it off
// (unset the env var, redeploy) as soon as the test is done.
const SKIP_AUTH = process.env.SKIP_AUTH === 'true';
const SKIP_AUTH_USER = { userId: 'skip-auth-test-user', email: 'test@local' };
if (SKIP_AUTH) console.warn('[auth] SKIP_AUTH=true — authentication is DISABLED. Every request is treated as the same test user. Do not leave this on.');

let _client = null;
function supabase() {
  if (!_client) {
    _client = createClient(requireEnvOrThrow('SUPABASE_URL'), requireEnvOrThrow('SUPABASE_SERVICE_ROLE_KEY'));
  }
  return _client;
}

// Returns { userId, email } for a valid access token, or null (never throws — callers
// should treat null as "not authenticated" and respond 401).
async function verifyToken(token) {
  if (SKIP_AUTH) return SKIP_AUTH_USER;
  if (!token) return null;
  try {
    const { data, error } = await supabase().auth.getUser(token);
    if (error || !data?.user) return null;
    return { userId: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}

// Native EventSource can't set custom headers, so the SSE route can't use this for its
// token — see verifyToken() directly with a `?token=` query param there instead.
async function verifyRequestAuth(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  return verifyToken(token);
}

module.exports = { supabase, verifyRequestAuth, verifyToken, SKIP_AUTH };
