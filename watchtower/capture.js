const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLogger } = require('./logger');

const log = createLogger('capture');

// RTSP URLs commonly embed a plaintext username:password — never log them as-is.
function maskRtsp(url) {
  try {
    return String(url).replace(/(rtsp:\/\/)([^@/]+)@/i, '$1***@');
  } catch {
    return '(unparseable rtsp url)';
  }
}

// Thin ffmpeg wrappers for pulling a short burst of frames (and optionally an
// audio clip) from an RTSP camera. Everything is written to a throwaway temp
// dir and cleaned up after reading.
function runFfmpeg(ffmpeg, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    log.debug(`spawn: ${ffmpeg} ${args.map(maskRtsp).join(' ')}`);
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      log.warn(`ffmpeg exceeded ${timeoutMs}ms timeout — killing process`);
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timed out'));
    }, timeoutMs);
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
      log.debug(`ffmpeg stderr tail: ${stderr.split('\n').filter(Boolean).slice(-6).join(' | ')}`);
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
  const start = Date.now();
  log.info(`capturing frames from ${maskRtsp(rtsp)} (${seconds}s @ ${fps}fps → target ${count} frames)`);
  try {
    await runFfmpeg(ffmpeg, args, (seconds + 25) * 1000);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    const frames = files.slice(0, count).map((f) => fs.readFileSync(path.join(dir, f)));
    const totalBytes = frames.reduce((n, b) => n + b.length, 0);
    log.debug(`frame capture done in ${Date.now() - start}ms: ${frames.length}/${count} frames, ${totalBytes} bytes total`);
    if (frames.length < count) {
      log.warn(`only captured ${frames.length}/${count} requested frames from ${maskRtsp(rtsp)}`);
    }
    return frames;
  } catch (e) {
    log.error(`frame capture failed for ${maskRtsp(rtsp)} after ${Date.now() - start}ms: ${e.message}`);
    throw e;
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
  const start = Date.now();
  log.debug(`capturing ${seconds}s audio clip from ${maskRtsp(rtsp)}`);
  try {
    await runFfmpeg(ffmpeg, args, (seconds + 25) * 1000);
    const size = fs.statSync(out).size;
    log.debug(`audio capture done in ${Date.now() - start}ms: ${size} bytes`);
    return { path: out, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    log.error(`audio capture failed for ${maskRtsp(rtsp)} after ${Date.now() - start}ms: ${e.message}`);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

module.exports = { captureFrames, captureAudio, maskRtsp };
