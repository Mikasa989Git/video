// Stitches the generated scene images + the voiceover into the finished 16:9 video, each
// image shown for exactly its Whisper-measured real duration.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ffmpegPath, ffprobeDuration, ensureDir } = require('./util');

function imgPath(outDir, scene) {
  return path.join(outDir, `scene${String(scene).padStart(3, '0')}.png`);
}

// alignedShots: [{scene, start, dur}] in seconds, already real (from align.js).
function assembleVideo(alignedShots, imagesDir, audioPath, outputPath, style) {
  const missing = alignedShots.filter(s => !fs.existsSync(imgPath(imagesDir, s.scene)));
  if (missing.length) {
    throw new Error(`${missing.length} scene image(s) missing from ${imagesDir} — image generation isn't done yet (e.g. scene ${missing[0].scene}).`);
  }

  const actualDur = ffprobeDuration(audioPath);
  const sorted = [...alignedShots].sort((a, b) => a.scene - b.scene);

  const workDir = path.dirname(outputPath);
  ensureDir(workDir);
  const concatList = path.join(workDir, '.images_concat.txt');
  let concatText = '';
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].start;
    const nextStart = i + 1 < sorted.length ? sorted[i + 1].start : actualDur;
    const duration = Math.max(0.15, nextStart - start);
    concatText += `file '${imgPath(imagesDir, sorted[i].scene).replace(/\\/g, '/')}'\n`;
    concatText += `duration ${duration.toFixed(3)}\n`;
  }
  concatText += `file '${imgPath(imagesDir, sorted[sorted.length - 1].scene).replace(/\\/g, '/')}'\n`;
  fs.writeFileSync(concatList, concatText, 'utf8');

  const crop = style.image.cropTo16x9;
  const outW = 1920, outH = 1080;
  const filter = crop
    ? `[0:v]crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${outW}:${outH},setsar=1,fps=30[v]`
    : `[0:v]scale=${outW}:${outH},setsar=1,fps=30[v]`;

  const args = [
    '-y',
    '-f', 'concat', '-safe', '0', '-i', concatList,
    '-i', audioPath,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest',
    outputPath,
  ];
  console.log('  [assemble] running ffmpeg...');
  try {
    execFileSync(ffmpegPath(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // stdio:'inherit' (the previous setting) streamed ffmpeg's real output straight to the
    // server's own console but never captured it, so a failure here surfaced to the client
    // as Node's bare "Command failed: ffmpeg ..." — the command itself, no actual reason.
    const stderr = (err.stderr || '').toString();
    console.error(stderr); // keep it visible in server logs, same as stdio:'inherit' did
    const status = err.signal ? `killed by signal ${err.signal}` : `exit code ${err.status}`;
    throw new Error(`ffmpeg assemble failed (${status}): ${stderr.slice(-2000) || err.message}`);
  }
  return outputPath;
}

module.exports = { assembleVideo };
