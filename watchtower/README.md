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
                                    LLM provider (vision) → scene JSON
                                                   │
             ┌─────────────── event bus ───────────┴─────────────┐
        WebSocket → kitchen dashboard          webhooks      leaderboards/state

 Kitchen display mic hears a loud noise ──▶ /api/audio/loud ──▶ audio session:
   ffmpeg pulls RTSP audio → local transcribe → LLM provider (escalation) → arg-u-meter
```

- **`smtp-trigger.js`** — a fake SMTP server. Your NVR thinks it's emailing a
  motion alert; we just use the connection as a trigger. Nothing is relayed.
- **`capture.js`** — `ffmpeg` pulls frames (and audio clips) over RTSP.
- **`analysis/providers/`** — the LLM backend is swappable (`LLM_PROVIDER`):
  `anthropic` (Claude) or `openai` (OpenAI, or any OpenAI-compatible endpoint —
  Azure OpenAI, Ollama, LM Studio, vLLM, Groq, OpenRouter, ...). Both
  `vision.js` and `escalation.js` call `getProvider(config)` instead of any
  SDK directly, so changing providers is a config change, not a code change.
  See **Choosing an LLM provider** below.
- **`analysis/vision.js`** — sends the frames to the active provider with a
  strict JSON schema: people count, who (from your roster), what they're
  doing, notable observations, a mess score, child-wellbeing risk, environment
  hazards, a vibe score, and a per-person effort score.
- **`analysis/audio.js` + `escalation.js`** — during a raised-voices event,
  captures rolling audio clips, transcribes them locally, and scores the
  escalation with a fast model to drive the arg-u-meter and worm.
- **`events.js`** — one bus fans every event out to the dashboard (WebSocket),
  any webhooks, and the persisted leaderboards.

## Setup

### 1. Prerequisites

- **Node ≥ 18** and **ffmpeg** on the machine (a NAS, a mini-PC, a Pi 4+).
- An **LLM provider** — an Anthropic API key (default), an OpenAI API key, or
  a local/self-hosted OpenAI-compatible server (Ollama, LM Studio, ...). See
  **Choosing an LLM provider** below. Optional but needed for real analysis —
  without one, everything runs with mock data so you can wire up cameras first.
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

### 8. (Optional) Water Challenge

A hydration game to get the family drinking more water. Enable with
`WATER_ENABLED=1` and the dashboard gains a second **page** — the display
auto-rotates between pages when idle, and you can tap the dots at the bottom to
switch. (A raised-voices event always jumps back to the watch page.)

On the Water Challenge page each opted-in person gets a **droplet swimlane**
that fills toward their daily goal (`WATER_DAILY_GOAL_ML`) over the selected
period (24h / week / month / 6mo / 12mo), a **leaderboard**, and per-lane trend
arrows. Tap **＋ join** to add someone. To drink: **tap your lane**, then press
the big central **Drink** button — that runs the pump; press it again (or let a
safety limit trigger) to stop, and the measured millilitres are recorded and
ranked.

**The dispenser** is an **ESP32 + 4-relay board + 12V pump + flow meter**.
Watchtower switches the pump relay over HTTP and the ESP32 reports measured flow
back. The firmware + wiring are in [`watchtower/esp32/`](./esp32/). Point
Watchtower at it:

```
# .env
WATER_ENABLED=1
WATER_ESP32_URL=http://<esp32-ip>
```

> **No hardware yet? It still works.** Leave `WATER_ESP32_URL` blank and
> Watchtower runs the whole game in **mock mode** — pours are simulated at
> `WATER_MOCK_FLOW_ML_PER_SEC`, so you can play, test, and demo the page before
> wiring anything up.

> ⚠️ **Pump safety.** This switches a real 12V pump from a web button — a
> dropped "stop" could overflow. Watchtower enforces `WATER_MAX_POUR_ML` /
> `WATER_MAX_POUR_SECONDS` cutoffs, **and** the ESP32 firmware enforces its own
> independent hardware cutoffs so the pump stops even if the network dies. Keep
> both conservative and don't dispense unattended.

### 9. (Optional) Dear Diary

A wake-word-activated video diary, so the kids can record a quick entry
whenever they feel like it. Off by default — enable with `DIARY_ENABLED=1`.

**How it works:** say **"Dear Diary"** (`DIARY_WAKE_WORD`) anywhere near the
display. It asks **"are you ready?"** (out loud, and on screen) — say **"yes"**
or tap the button. A big colored dot counts down from `DIARY_COUNTDOWN_SECONDS`
(default 5), then the webcam starts recording. A timer and a list of prompt
ideas ("What did you do today?", "Tell a joke", ...) stay on screen for up to
`DIARY_MAX_SECONDS` (default 60) — tap **Finish recording** to stop early. The
clip is then timestamped and uploaded.

- Wake-word listening and "yes" confirmation both run **in the browser** via
  the Web Speech API (`webkitSpeechRecognition`) — no audio is sent to the
  server until a person actually finishes (or times out) an entry.
- Video recording uses `MediaRecorder` on the display's own webcam.
- The server uploads the finished clip to a **Google Drive** folder and keeps
  a `dear-diary-index.json` manifest in that same folder up to date, so anyone
  can browse the folder directly. A local copy of the index
  (`watchtower/diary.json`, `.gitignore`d) backs the dashboard's own "recent
  entries" list.

**Enable it:**

```
# .env
DIARY_ENABLED=1
```

**Set up Google Drive** (optional but recommended — without it, entries are
recorded but only ever kept on the display itself):

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project (or reuse one), enable the **Google Drive API**, then create a
   **service account** and generate a JSON key for it.
2. Create (or pick) a Drive folder for entries, and **share it** with the
   service account's `client_email` (from the JSON key) as an **Editor**.
3. Put the folder's ID (from its URL) and the whole JSON key (as one line)
   into `.env`:

```
# .env
GOOGLE_DRIVE_FOLDER_ID=<folder id>
GOOGLE_SERVICE_ACCOUNT_JSON={"type":"service_account", ...}
```

Then open the dashboard, click **enable dear diary** once (a browser
gesture is required for microphone access), and try saying "Dear Diary". You
can also skip the wake word entirely and tap **record an entry now** on the
Dear Diary page.

> Voice activation needs a Chromium-based browser (Web Speech API support
> varies). If it isn't supported, the button falls back to a message and the
> manual "record an entry now" button on the Dear Diary page still works.
> Webcam/mic access has the same HTTPS-or-`localhost` requirement as face
> recognition, above.

### 10. (Optional) Google Tasks

A **"due soon"** quick-view widget on the watch page, plus a dedicated
**Tasks** page with drag-and-drop, Trello-style columns — one per Google task
list. Off by default — enable with `TASKS_ENABLED=1`.

Unlike Dear Diary's Drive upload, tasks are per-user data, so this needs an
interactive **OAuth** consent flow rather than a service account:

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or
   reuse) a project, enable the **Google Tasks API**, then create an
   **OAuth 2.0 Client ID** of type "Web application". Add this server's own
   callback URL as an authorized redirect URI (adjust host/port to match how
   it's actually reached — defaults to `http://localhost:4000/api/tasks/oauth/callback`).
2. Put the client ID + secret in `.env`:

```
# .env
TASKS_ENABLED=1
GOOGLE_OAUTH_CLIENT_ID=<client id>
GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
GOOGLE_OAUTH_REDIRECT_URI=http://localhost:4000/api/tasks/oauth/callback
```

3. Start the server, then open the **Tasks** page (or the quick-view widget)
   and click **connect Google Tasks** — sign in once and grant access. The
   refresh token is then stored in `watchtower/tasks-tokens.json`
   (`.gitignore`d — never commit it) and reused across restarts.

**How it works:**

- Each Google task list becomes a board column; each task a draggable card.
  Drag a card within a column to reorder it, or into another column to move
  it there — dropped position is preserved either way.
- Tick a card's checkbox to mark it complete/incomplete; the × removes it;
  typing in a column's "+ add a card" box creates a new task there.
- The watch page's quick-view widget lists overdue and soon-due tasks (within
  `TASKS_DUE_SOON_HOURS`, default 48h) across every list, soonest first —
  handy for a glance without switching pages.
- The server polls Google Tasks every `TASKS_POLL_SECONDS` (default 60) so
  edits made elsewhere (phone, Gmail, Calendar) show up here too; edits made
  on this dashboard apply immediately and push to every connected display via
  the `tasks.changed` WebSocket event.

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
| `GET /api/water?period=<24h\|week\|month\|6mo\|12mo>` | Water-challenge view: per-participant totals, droplet fill, ranks, trend, active pour — 404 if disabled |
| `POST /api/water/participants` `{name}` | Join the challenge / re-opt-in |
| `POST /api/water/participants/:id/opt` `{optedIn}` | Opt a participant in/out |
| `DELETE /api/water/participants/:id` | Remove a participant |
| `POST /api/water/pour/start` `{userId}` | Press Drink — start a pour (runs the pump) |
| `POST /api/water/pour/stop` | Press Drink again — stop the pour and record the ml |
| `POST /api/water/flow` `{ml, sessionId?}` | The ESP32 reports cumulative flow for the active pour |
| `GET /api/diary` | Wake word, countdown/max length, suggestions, Drive status, and recent entries — 404 if disabled |
| `POST /api/diary/upload` `multipart: video, durationSec, recordedAt` | Upload a finished entry; saved to Drive (if configured) and to the local index |
| `GET /api/tasks/auth/status` | Whether Google Tasks is authorized, and the consent URL if not — 404 if disabled |
| `GET /api/tasks/oauth/callback` | Google's OAuth redirect target; exchanges the code and stores the refresh token |
| `POST /api/tasks/auth/signout` | Forget the stored refresh token |
| `GET /api/tasks` | Board columns (task lists + tasks) and the due-soon quick view |
| `POST /api/tasks/:listId` `{title, notes?, due?}` | Create a task in a list |
| `POST /api/tasks/:listId/:taskId/toggle` `{completed}` | Mark a task complete/incomplete |
| `PATCH /api/tasks/:listId/:taskId` `{title?, notes?, due?}` | Edit a task |
| `DELETE /api/tasks/:listId/:taskId` | Delete a task |
| `POST /api/tasks/:listId/:taskId/move` `{toListId?, previousTaskId?}` | Reorder within a list and/or move it to another list |
| `WS /ws` | Live event stream to the dashboard |

Event types (also delivered to `WATCH_WEBHOOKS`, and to `alerts.json` rules):
`trigger` (payload includes `source`: `smtp` / `manual` / `auto`),
`scene.update`, `audio.start` / `audio.update` / `audio.end`, `alert.child`,
`alert.hazard`, `incident.recorded`, `capture.error`, `audio.error`,
`auto.updated`, `alexa.status`, `alexa.announced`, `alexa.error`,
`face.recognized`, `face.enrolled`, `face.forgotten`,
`water.pour.start`, `water.pour.progress`, `water.dispensed`, `water.changed`,
`diary.recorded`, `tasks.changed`.

## Logging

Every module (`server`, `capture`, `vision`, `escalation`, `audio`, `smtp`,
`events`, `llm`, `transcribe`) logs through a small leveled logger
(`watchtower/logger.js`) with timestamps, e.g.:

```
14:02:11.482 INFO  [server] trigger received: camera="Kitchen" source=manual subject="manual test"
14:02:11.483 INFO  [capture] capturing frames from rtsp://***@192.168.1.50:554/... (10s @ 0.8fps → target 8 frames)
14:02:14.910 INFO  [capture] captured 8 frame(s) from "Kitchen" in 3427ms
14:02:14.911 INFO  [vision] analysing 8 frame(s) from "Kitchen" with anthropic:claude-opus-4-8
14:02:17.203 INFO  [server] scene analysed for "Kitchen" in 2292ms: people=2 mess=3/10 vibe=68 child_risk=none hazards=0
```

Default level is `info` — trigger lifecycle, capture/analysis results and
timings, audio session start/end, alerts, and connection events. Set
`LOG_LEVEL=debug` (or `WATCH_VERBOSE=1`) in `.env` for everything: raw SMTP
protocol lines, HTTP requests, WebSocket broadcasts, ffmpeg invocations, and
Claude usage/timing on every call — noisy, but useful when a camera is flaky
or an integration is misbehaving. RTSP URLs are credential-masked in all log
output (`rtsp://***@host/...`).

## Choosing an LLM provider

Set `LLM_PROVIDER` in `.env`:

| `LLM_PROVIDER` | Uses | Auth |
| --- | --- | --- |
| `anthropic` (default) | Claude | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI, or **any** OpenAI-compatible `/chat/completions` endpoint | `OPENAI_API_KEY` + optional `OPENAI_BASE_URL` |

`openai` isn't just OpenAI's own API — pointing `OPENAI_BASE_URL` at a
different host covers Azure OpenAI, and self-hosted/local servers that speak
the same wire protocol: [Ollama](https://ollama.com) (`http://localhost:11434/v1`),
[LM Studio](https://lmstudio.ai) (`http://localhost:1234/v1`), vLLM, Groq,
OpenRouter, together.ai, and more. Local servers usually need no API key at
all — leave `OPENAI_API_KEY` blank.

Both `vision.js` (needs a vision-capable model) and `escalation.js` (wants a
fast/cheap model) go through the same provider, so pick model IDs that suit
each role for whichever backend you choose:

```
# .env — self-hosted example
LLM_PROVIDER=openai
OPENAI_BASE_URL=http://localhost:11434/v1
VISION_MODEL=llama3.2-vision
ESCALATION_MODEL=llama3.2:1b
```

Leave `VISION_MODEL` / `ESCALATION_MODEL` unset to get sensible per-provider
defaults (`claude-opus-4-8` / `claude-haiku-4-5` for Anthropic, `gpt-4o` /
`gpt-4o-mini` for OpenAI). The active provider and models are logged at
startup and shown in `GET /api/state` under `llm`.

To add another provider, drop a new file in `watchtower/analysis/providers/`
implementing `{ name, available(), complete({model, maxTokens, system, prompt,
images?, schema?}) }` and wire it into `providers/index.js`'s `getProvider()`.

## Notes & tuning

- **No transcriber?** The arg-u-meter still works — it tracks raw loudness from
  the display mic instead of transcript sentiment. Add `TRANSCRIBE_CMD` for the
  full transcription + escalation experience.
- **Cost.** Every motion event is a vision call. On a busy camera that adds up —
  raise `CLIP_SECONDS`/motion sensitivity or point Watchtower at fewer cameras.
- **Privacy.** Keep `.env`, `cameras.json`, and `roster.json` out of git (the
  repo's `.gitignore` already excludes the live files; only `.example`s are
  tracked).
