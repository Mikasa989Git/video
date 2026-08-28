// Shared helpers: .env.local loading (no dependency), ffmpeg/ffprobe path resolution,
// a minimal RFC4180-ish CSV/JSON-lines helpers, and a tiny cost ledger.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// --- .env.local loader (keeps this project dependency-free) ---
function loadEnv() {
  const envPath = path.join(ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (process.env[key] !== undefined) continue; // real env vars win over .env.local
    let val = rawVal.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    console.error(`Set it directly ($env:${name} = "...") or add it to .env.local (see .env.example).`);
    process.exit(1);
  }
  return v;
}

// --- ffmpeg/ffprobe resolution ---
// Known fallback location from the winget install performed earlier this project.
const KNOWN_FFMPEG_DIR = 'C:\\Users\\zheni\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.1-full_build\\bin';

function resolveTool(name) {
  const envOverride = process.env.FFMPEG_PATH;
  if (envOverride && envOverride !== 'ffmpeg') {
    return envOverride.replace(/ffmpeg(\.exe)?$/i, name + (process.platform === 'win32' ? '.exe' : ''));
  }
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return name; // already on PATH
  } catch {
    const candidate = path.join(KNOWN_FFMPEG_DIR, name + '.exe');
    if (fs.existsSync(candidate)) return candidate;
    return name; // let it fail loudly with a clear ENOENT if truly missing
  }
}

function ffmpegPath() { return resolveTool('ffmpeg'); }
function ffprobePath() { return resolveTool('ffprobe'); }

function ffprobeDuration(file) {
  const out = execFileSync(ffprobePath(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file])
    .toString().trim();
  return parseFloat(out);
}

// --- tiny cost ledger, printed at the end of a run ---
class CostLedger {
  constructor() { this.entries = []; }
  add(stage, usd, detail = '') {
    this.entries.push({ stage, usd, detail });
    console.log(`  [cost] ${stage}: $${usd.toFixed(4)}${detail ? ' — ' + detail : ''}`);
  }
  total() { return this.entries.reduce((s, e) => s + e.usd, 0); }
  printSummary() {
    console.log('\n--- Cost summary ---');
    for (const e of this.entries) console.log(`  ${e.stage.padEnd(14)} $${e.usd.toFixed(4)}  ${e.detail}`);
    console.log(`  ${'TOTAL'.padEnd(14)} $${this.total().toFixed(4)}`);
  }
}

// --- misc ---
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video';
}

module.exports = { loadEnv, requireEnv, ffmpegPath, ffprobePath, ffprobeDuration, CostLedger, ensureDir, slugify, ROOT };
