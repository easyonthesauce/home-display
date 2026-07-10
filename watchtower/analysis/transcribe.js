const { exec } = require('child_process');
const config = require('../config');

// Pluggable speech-to-text. Runs whatever command TRANSCRIBE_CMD names, passing
// it a WAV path, and reads the transcript from stdout. Kept local by design —
// household audio should not leave the LAN unless the user explicitly wires up a
// cloud transcriber here.
//
// Examples:
//   TRANSCRIBE_CMD="whisper-cpp -m models/base.en.bin -nt -f {file}"
//   TRANSCRIBE_CMD="whisper {file} --model base --output_format txt --output_dir /tmp && cat ..."
// If {file} is absent, the path is appended as the final argument.
function transcribe(wavPath) {
  return new Promise((resolve) => {
    if (!config.transcribeCmd) return resolve(null);   // no transcriber configured
    const cmd = config.transcribeCmd.includes('{file}')
      ? config.transcribeCmd.replace(/\{file\}/g, JSON.stringify(wavPath))
      : `${config.transcribeCmd} ${JSON.stringify(wavPath)}`;
    exec(cmd, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { console.warn(`[transcribe] ${err.message}`); return resolve(null); }
      const text = String(stdout || '').trim();
      resolve(text || null);
    });
  });
}

module.exports = { transcribe };
