const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Manages a single live audio-analysis session. Triggered when the kitchen
// display detects a loud noise, it captures short rolling clips from the audio
// camera, transcribes them, and scores the escalation of the exchange to drive
// the on-screen "arg-u-meter" and the escalation worm. It stops when the room
// calms down, the display reports sustained quiet, or a safety cap is hit.
function createAudioAnalyzer({ config, captureAudio, transcribe, classifyEscalation, emit, getNoiseLevel }) {
  const camera = config.cameras.find((c) => c.id === config.audioCameraId) || null;

  let active = false;
  let stopRequested = false;
  let worm = [];          // [{ t, escalation }]
  let transcript = [];    // recent transcribed chunks

  async function tick() {
    let text = null;
    if (camera && camera.audio) {
      try {
        const clip = await captureAudio(camera.rtsp, { seconds: config.audioChunkSeconds, ffmpeg: config.ffmpeg });
        try { text = await transcribe(clip.path); } finally { clip.cleanup(); }
      } catch (e) {
        emit('audio.error', { message: e.message });
      }
    }
    if (text) {
      transcript.push(text);
      if (transcript.length > 40) transcript.shift();
    }

    const windowText = transcript.slice(-8).join('\n') || '(no transcript available)';
    const cls = await classifyEscalation(windowText, getNoiseLevel ? getNoiseLevel() : 0);

    worm.push({ t: Date.now(), escalation: cls.escalation });
    if (worm.length > 240) worm.shift();

    emit('audio.update', {
      escalation: cls.escalation,
      trend: cls.trend,
      tone: cls.tone,
      summary: cls.summary,
      noise: getNoiseLevel ? getNoiseLevel() : 0,
      transcriptTail: transcript.slice(-6),
      worm: worm.slice(-90),
    });
    return cls;
  }

  async function loop() {
    const started = Date.now();
    let quietStreak = 0;
    while (active && !stopRequested) {
      if (Date.now() - started > 5 * 60 * 1000) break;   // 5-minute safety cap
      let cls;
      try { cls = await tick(); } catch (e) { emit('audio.error', { message: e.message }); break; }
      if (cls.escalation < 25) quietStreak += 1; else quietStreak = 0;
      if (quietStreak >= 3) break;                        // room has calmed down
      await sleep(500);
    }
    finish();
  }

  function finish() {
    if (!active) return;
    active = false;
    const peak = worm.reduce((m, w) => Math.max(m, w.escalation), 0);
    emit('audio.end', {
      peak,
      ticks: worm.length,
      transcript: transcript.slice(),
      camera: camera && camera.name,
    });
    worm = [];
    transcript = [];
  }

  return {
    isActive: () => active,
    start(reason) {
      if (active) return false;
      active = true;
      stopRequested = false;
      worm = [];
      transcript = [];
      emit('audio.start', { reason, camera: camera && camera.name, hasTranscriber: Boolean(config.transcribeCmd) });
      loop();
      return true;
    },
    stop() { stopRequested = true; },
  };
}

module.exports = { createAudioAnalyzer };
