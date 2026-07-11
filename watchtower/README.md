# Watchtower — security-camera analysis service

A second service in this repo (independent of the Tuya energy dashboard). It
turns your home security cameras into a live, playful **kitchen dashboard**:
when your cameras detect motion, Watchtower grabs a few seconds of video, has
Claude describe the scene, and shows animated meters — a **mess-o-meter**, a
**vibe** trend, leaderboards — plus an **arg-u-meter** that spins up when it
hears raised voices and transcribes the exchange in near-realtime with a
rolling escalation "worm".

```
 ┌──────────────────────────────────────────────────────────────┐
 │ ● THE KITCHEN WATCH            ● REC  🎙 listening   19:41  ⛶ │
 │  ┌── ARG-U-METER ──┐  argument ▲ escalating      noise 74     │
 │  │      68         │  ╭─╮      ╭──╮                            │
 │  │  ▲ escalating   │ ─╯ ╰──╮╭─╯  ╰── (escalation worm)         │
 │  └─────────────────┘       ╰╯   "voices raised in the kitchen"│
 │  ┌ MESS ┐  THE VIBE 41 tense   🔥 Shame  💪 Grafters  ⭐ Credit│
 │  │  7   │  ╱╲___╱╲__          1 Robin    1 Sam       1 Frankie │
 │  └──────┘                                                     │
 │  ┌ Kitchen · 3 here ┐ ┌ Living Room · 1 here ┐                │
 │  │ Sam  Robin  Frank│ │ Alex                 │                │
 │  │ kids: ok         │ │ hazard: hot hob      │                │
 │  └──────────────────┘ └──────────────────────┘                │
 └──────────────────────────────────────────────────────────────┘
```

## Everyone in the house should know it's on

This watches — and, during raised-voices events, **listens to and transcribes**
— people in your home. That's fine for your own household on your own cameras,
but two things keep it on the right side of the line:

- **Transparency.** It's designed to live on the kitchen wall for all to see,
  with a visible `● REC` indicator whenever it's listening. Keep it that way —
  everyone in the home should know it exists. Covert monitoring is a different
  thing entirely, and not what this is for.
- **Audio + the law.** Recording people's conversations is regulated in many
  places (one- vs two-party consent). Make sure the household is aware the mics
  are live. Transcription runs through whatever local command you configure —
  keep it on your LAN.

## How it works

```
 Camera motion ──"email"──▶ fake SMTP server ──▶ trigger
                                                   │
                                    ffmpeg grabs ~10s of frames
                                                   │
                                    Claude (vision) → scene JSON
                                                   │
             ┌─────────────── event bus ───────────┴─────────────┐
        WebSocket → kitchen dashboard          webhooks      leaderboards/state

 Kitchen display mic hears a loud noise ──▶ /api/audio/loud ──▶ audio session:
   ffmpeg pulls RTSP audio → local transcribe → Claude (escalation) → arg-u-meter
```

- **`smtp-trigger.js`** — a fake SMTP server. Your NVR thinks it's emailing a
  motion alert; we just use the connection as a trigger. Nothing is relayed.
- **`capture.js`** — `ffmpeg` pulls frames (and audio clips) over RTSP.
- **`analysis/vision.js`** — sends the frames to Claude with a strict JSON
  schema: people count, who (from your roster), what they're doing, notable
  observations, a mess score, child-wellbeing risk, environment hazards, a vibe
  score, and a per-person effort score.
- **`analysis/audio.js` + `escalation.js`** — during a raised-voices event,
  captures rolling audio clips, transcribes them locally, and scores the
  escalation with a fast model to drive the arg-u-meter and worm.
- **`events.js`** — one bus fans every event out to the dashboard (WebSocket),
  any webhooks, and the persisted leaderboards.

## Setup

### 1. Prerequisites

- **Node ≥ 18** and **ffmpeg** on the machine (a NAS, a mini-PC, a Pi 4+).
- An **Anthropic API key** (`ANTHROPIC_API_KEY`). Optional but needed for real
  analysis — without it everything runs with mock data so you can wire up
  cameras first.
- (Optional) a local **speech-to-text** binary for transcription, e.g.
  [`whisper.cpp`](https://github.com/ggerganov/whisper.cpp).

### 2. Configure

```bash
cp .env.example .env
cp watchtower/cameras.json.example watchtower/cameras.json
cp watchtower/roster.json.example watchtower/roster.json
# edit .env (API key, models, SMTP + ports) and the two JSON files
```

`cameras.json` — one entry per camera with its RTSP URL and a `trigger` keyword
(a word your NVR puts in the alert's recipient or subject, so we know which
camera fired). `roster.json` — household members and short visual descriptions
so Claude can name people instead of "someone".

### 3. Run

```bash
npm install
npm run watch
```

Open <http://localhost:4000> on the kitchen display. Click **🎙 enable mic**
once (browsers require a click before using the microphone) so it can trigger
audio analysis, then press **F** for fullscreen.

### 4. Point your cameras at it

In each camera/NVR's **email alarm** settings:

- **SMTP server / port:** the Watchtower host and `SMTP_PORT` (default `2525`).
- **Encryption:** none / off (we don't do TLS — it's a local trigger).
- **Username/password:** anything (accepted but ignored).
- **Recipient / subject:** include the camera's `trigger` keyword so the right
  camera is analysed (e.g. send kitchen alerts to `kitchen@watchtower.local`).

Test without a camera — either click the **trigger `<camera name>`** button
that appears on the dashboard for each configured camera, or:

```bash
curl -X POST "http://localhost:4000/api/trigger/test?camera=kitchen"
```

### 5. (Optional) Set up auto-trigger

Each camera on the dashboard also has an **auto every ⎵s** control next to its
trigger button — type an interval and click **set** to run a scene analysis on
that camera automatically, on a repeating timer, independent of motion/SMTP.
0 (or blank) disables it; a live "next in ⎵s" countdown shows when it'll next
fire. Changes take effect immediately, no restart needed, and are visible to
every connected dashboard.

To set a starting default without touching the UI: `WATCH_AUTO_TRIGGER_SECONDS`
in `.env` (applies to every camera), or `"autoTriggerSeconds": 300` on an
individual camera in `cameras.json` (overrides the env default for that
camera). Intervals below 15s are clamped up — a busy camera + Claude vision
call every few seconds adds up fast in API cost.

## HTTP / event API

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Current scenes, leaderboards, vibe, auto-trigger state, flags |
| `POST /api/trigger/test?camera=<id>` | Manually fire a motion trigger (also wired to the dashboard's per-camera trigger buttons) |
| `POST /api/trigger/auto?camera=<id>&seconds=<n>` | Set (`n>0`) or disable (`n=0`) a camera's periodic auto-trigger interval at runtime (also wired to the dashboard's per-camera auto control) |
| `POST /api/audio/loud` `{level}` | Start an audio-analysis session |
| `POST /api/audio/level` `{level}` | Report ongoing loudness (0-100) |
| `POST /api/audio/quiet` | End the audio session |
| `WS /ws` | Live event stream to the dashboard |

Event types (also delivered to `WATCH_WEBHOOKS`): `trigger` (payload includes
`source`: `smtp` / `manual` / `auto`), `scene.update`, `audio.start` /
`audio.update` / `audio.end`, `alert.child`, `alert.hazard`,
`incident.recorded`, `capture.error`, `audio.error`, `auto.updated`.

## Logging

Every module (`server`, `capture`, `vision`, `escalation`, `audio`, `smtp`,
`events`, `client`, `transcribe`) logs through a small leveled logger
(`watchtower/logger.js`) with timestamps, e.g.:

```
14:02:11.482 INFO  [server] trigger received: camera="Kitchen" source=manual subject="manual test"
14:02:11.483 INFO  [capture] capturing frames from rtsp://***@192.168.1.50:554/... (10s @ 0.8fps → target 8 frames)
14:02:14.910 INFO  [capture] captured 8 frame(s) from "Kitchen" in 3427ms
14:02:14.911 INFO  [vision] analysing 8 frame(s) from "Kitchen" with claude-opus-4-8
14:02:17.203 INFO  [server] scene analysed for "Kitchen" in 2292ms: people=2 mess=3/10 vibe=68 child_risk=none hazards=0
```

Default level is `info` — trigger lifecycle, capture/analysis results and
timings, audio session start/end, alerts, and connection events. Set
`LOG_LEVEL=debug` (or `WATCH_VERBOSE=1`) in `.env` for everything: raw SMTP
protocol lines, HTTP requests, WebSocket broadcasts, ffmpeg invocations, and
Claude usage/timing on every call — noisy, but useful when a camera is flaky
or an integration is misbehaving. RTSP URLs are credential-masked in all log
output (`rtsp://***@host/...`).

## Notes & tuning

- **Model choice.** Vision runs once per motion trigger (`VISION_MODEL`,
  default `claude-opus-4-8`). Escalation runs every few seconds during an
  argument, so it defaults to the faster `claude-haiku-4-5`. Both are env-configurable.
- **No transcriber?** The arg-u-meter still works — it tracks raw loudness from
  the display mic instead of transcript sentiment. Add `TRANSCRIBE_CMD` for the
  full transcription + escalation experience.
- **Cost.** Every motion event is a vision call. On a busy camera that adds up —
  raise `CLIP_SECONDS`/motion sensitivity or point Watchtower at fewer cameras.
- **Privacy.** Keep `.env`, `cameras.json`, and `roster.json` out of git (the
  repo's `.gitignore` already excludes the live files; only `.example`s are
  tracked).
