const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Thin ffmpeg wrappers for pulling a short burst of frames (and optionally an
// audio clip) from an RTSP camera. Everything is written to a throwaway temp
// dir and cleaned up after reading.
function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT'
        ? new Error(`ffmpeg not found ("${ffmpeg}"). Install ffmpeg or set FFMPEG_PATH.`)
        : err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' ')}`));
    });
  });
}

// Grab `count` JPEG frames spread across `seconds` of RTSP video.
async function captureFrames(rtsp, { seconds = 10, count = 8, ffmpeg = 'ffmpeg' } = {}) {
  if (!rtsp) throw new Error('camera has no rtsp url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-frames-'));
  const fps = Math.max(0.1, Math.round((count / seconds) * 100) / 100);
  const pattern = path.join(dir, 'frame-%03d.jpg');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-y', '-i', rtsp,
    '-t', String(seconds),
    '-vf', `fps=${fps},scale='min(1280,iw)':-2`,
    '-q:v', '4', pattern,
  ];
  try {
    await runFfmpeg(ffmpeg, args, (seconds + 25) * 1000);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    return files.slice(0, count).map((f) => fs.readFileSync(path.join(dir, f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Grab a mono 16kHz WAV clip of the RTSP audio track. Returns the path plus a
// cleanup fn the caller must invoke once it's done reading the file.
async function captureAudio(rtsp, { seconds = 5, ffmpeg = 'ffmpeg' } = {}) {
  if (!rtsp) throw new Error('camera has no rtsp url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-audio-'));
  const out = path.join(dir, 'clip.wav');
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-rtsp_transport', 'tcp', '-y', '-i', rtsp,
    '-t', String(seconds), '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', out,
  ];
  await runFfmpeg(ffmpeg, args, (seconds + 25) * 1000);
  return { path: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { captureFrames, captureAudio };
