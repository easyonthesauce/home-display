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

### 6. (Optional) Set up Alexa announcements

Watchtower can announce alerts through Alexa devices — "things sound heated
in the kitchen", "a hazard was spotted", whatever you configure — by talking
to a small **sidecar service** called Alexa Bridge. Watchtower doesn't log
into Amazon itself; the bridge owns that (via `alexa-remote2`) and exposes a
local HTTP API (`POST /announce`), and Watchtower is just a client of it. Run
the bridge as its own process (see its own setup — it needs your Amazon
account cookie in its `.env`, never Watchtower's), then:

```bash
cp watchtower/alerts.json.example watchtower/alerts.json
# edit alerts.json: which events announce, on which device, how often
```

```
# .env
ALEXA_BRIDGE_URL=http://localhost:3000   # wherever the bridge is running
ALEXA_ALERTS_ENABLED=1
```

Each rule in `alerts.json` maps a Watchtower **event** to a spoken
**message**, with optional conditions and a per-rule cooldown so a busy
kitchen doesn't turn into a nagging speaker:

```json
{
  "id": "argument",
  "event": "incident.recorded",
  "when": { "peak": { "gte": 70 } },
  "message": "Things sound heated in the kitchen. Everything okay?",
  "device": "Kitchen Echo",
  "cooldownSeconds": 300
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `id` | ✅ | Unique — used to track this rule's own cooldown |
| `event` | ✅ | Which Watchtower event fires this rule — see the event list below |
| `when` | ❌ | Conditions on the event payload, all must match. A field maps to: an array (value must be one of these), `{gte:N}` / `{lte:N}` / `{eq:v}` / `{neq:v}`, or an exact value. Dot paths work (`child_wellbeing.risk_level`). Omit for "always match". |
| `message` | ✅ | Spoken text. `{{field}}` / `{{nested.field}}` pull values from the event payload; arrays are joined into a readable list. |
| `device` | ❌ | Device name, serial, or `"all"` to broadcast. Falls back to the top-level `device` in `alerts.json`, then `ALEXA_DEFAULT_DEVICE`. |
| `cooldownSeconds` | ❌ | Minimum gap between firings of *this rule*. Falls back to the top-level `cooldownSeconds`, then `ALEXA_DEFAULT_COOLDOWN_SECONDS`. |
| `enabled` | ❌ | Set `false` to keep a rule in the file but turn it off. |

See `alerts.json.example` for more worked examples (child-safety, hazards, a
messy kitchen, disabled motion-detected, and a "welcome home" rule that
fires on face recognition). Click the **Alexa** badge in the top-right of the
dashboard (appears once alerts are enabled) to fire a test announcement and
confirm the bridge is reachable — the dot is green when connected, red when not.

### 7. (Optional) Face enrolment + recognition

The display can recognise enrolled household members from its **own webcam**
and greet an unrecognised person with a **"Have we met?"** prompt that offers
a consent-based enrolment. It's off by default (it's biometric) — enable with
`FACES_ENABLED=1`.

**How it's built to stay private:**

- All face detection and embedding runs **in the browser** on the display,
  using a local copy of `@vladmandic/face-api` (library + model weights served
  from `node_modules`, so it works offline — no CDN, no cloud).
- Only **128-number face signatures** are ever produced — never photos. A
  signature is **only stored after the person explicitly consents** on the
  "Have we met?" screen; the live unknown-face detection that decides whether
  to prompt is ephemeral and never uploaded or saved.
- Signatures live in `watchtower/faces.json` on the server, on your LAN, and
  are `.gitignore`d. Enrolled people can be reviewed and **forgotten** any time
  from the **Faces** button on the dashboard.
- A guest who taps **No thanks** isn't prompted again for the rest of that
  session, and unknown faces must linger for `FACES_UNKNOWN_DWELL_MS` (default
  4s) before the prompt appears — so passers-by aren't nagged.

**Enable it:**

```
# .env
FACES_ENABLED=1
```

Then open the dashboard, click **👤 enable camera** once (a browser gesture is
required for webcam access), and stand in view. Known faces get a "👋 Hi Name"
greeting; a new face triggers the enrolment flow.

> ⚠️ **Browsers only allow webcam access over HTTPS or on `localhost`.** For a
> wall display, run the display's browser on the same machine as the server and
> point it at `http://localhost:4000`, or serve Watchtower over HTTPS. (The
> microphone feature has the same requirement.)

Recognising a known face emits a `face.recognized` event, so you can pair it
with the Alexa alerts — see the `welcome-home` rule in `alerts.json.example`.

## HTTP / event API

| Route | Purpose |
| --- | --- |
| `GET /api/state` | Current scenes, leaderboards, vibe, auto-trigger state, Alexa + faces status, flags |
| `POST /api/trigger/test?camera=<id>` | Manually fire a motion trigger (also wired to the dashboard's per-camera trigger buttons) |
| `POST /api/trigger/auto?camera=<id>&seconds=<n>` | Set (`n>0`) or disable (`n=0`) a camera's periodic auto-trigger interval at runtime (also wired to the dashboard's per-camera auto control) |
| `POST /api/audio/loud` `{level}` | Start an audio-analysis session |
| `POST /api/audio/level` `{level}` | Report ongoing loudness (0-100) |
| `POST /api/audio/quiet` | End the audio session |
| `POST /api/alexa/test` `{message?, device?}` | Fire a one-off test announcement, bypassing the alert rules (also wired to the dashboard's Alexa badge) |
| `GET /api/faces` | List enrolled people (with signatures, for local matching) — 404 if faces are disabled |
| `POST /api/faces/enroll` `{name, descriptors, consent}` | Enrol a person (requires `consent: true`) |
| `POST /api/faces/:id/samples` `{descriptors}` | Add more samples to an enrolled person |
| `DELETE /api/faces/:id` | Forget (delete) an enrolled person's signature |
| `POST /api/faces/recognized` `{id, name}` | Dashboard reports a recognised face; relayed (de-duped) as a `face.recognized` event |
| `WS /ws` | Live event stream to the dashboard |

Event types (also delivered to `WATCH_WEBHOOKS`, and to `alerts.json` rules):
`trigger` (payload includes `source`: `smtp` / `manual` / `auto`),
`scene.update`, `audio.start` / `audio.update` / `audio.end`, `alert.child`,
`alert.hazard`, `incident.recorded`, `capture.error`, `audio.error`,
`auto.updated`, `alexa.status`, `alexa.announced`, `alexa.error`,
`face.recognized`, `face.enrolled`, `face.forgotten`.

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
