// Verifies the bearer token a browser attaches to authenticated /api requests, and gives
// the rest of the server a single Supabase client (service role — bypasses RLS, since the
// existing architecture pattern is "the browser only ever talks to our server," not
// directly to third parties; the one exception is the Auth handshake itself, which the
// browser's own Supabase client performs directly).

const { createClient } = require('@supabase/supabase-js');
const { requireEnvOrThrow } = require('./util');

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

module.exports = { supabase, verifyRequestAuth, verifyToken };
