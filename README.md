# home-display

Fullscreen realtime dashboard for Tuya energy monitors. Polls the Tuya Cloud
API on the server, pushes updates to the browser over WebSocket, and renders
animated SVG gauges and rolling number readouts.

## Setup

### 1. Get Tuya Cloud credentials

1. Sign up at <https://iot.tuya.com/> (free).
2. **Cloud → Development → Create Cloud Project**. Pick the data center that
   matches your Smart Life account region (EU / US / CN / IN).
3. On the project page, copy the **Access ID / Client ID** and
   **Access Secret / Client Secret**.
4. **Cloud → Development → your project → Devices → Link Tuya App Account**
   and link the Smart Life / Tuya Smart account your meters are paired with.
5. In **Devices**, copy the **Device ID** of each energy monitor.
6. **Cloud → Development → your project → Service API** → make sure
   *IoT Core* and *Authorization* are subscribed (they usually are by default).

### 2. Configure

```bash
cp .env.example .env
# edit .env: paste client id, secret, region, and the device IDs
```

`TUYA_DEVICE_IDS` accepts a comma-separated list with optional friendly labels:

```
TUYA_DEVICE_IDS=bf1234…:Main Panel,bfabcd…:Solar
```

### 3. Run

```bash
npm install
npm start
```

Open <http://localhost:3000> on any device (a wall-mounted tablet, a Pi
running Chromium kiosk, a spare laptop). Press **F** or click the ⛶ button to
go fullscreen.

## How it works

- `server.js` boots Express + a WebSocket server on `/ws`.
- `src/tuya.js` signs requests with HMAC-SHA256 per the Tuya Cloud spec and
  caches the access token until it nears expiry.
- Every `POLL_INTERVAL_MS` (default 2 s) the server fetches each device's
  status, normalises the DPs through `src/metrics.js`, and broadcasts a
  snapshot to all WebSocket clients.
- The browser tweens numbers and gauges between snapshots so the display
  feels continuous.

## Supported Tuya DP codes

`src/metrics.js` maps these device-point codes to canonical metrics:

| Tuya code(s)                                              | Metric    | Unit |
| --------------------------------------------------------- | --------- | ---- |
| `cur_power`, `power`                                      | power     | W    |
| `cur_voltage`, `voltage`                                  | voltage   | V    |
| `cur_current`, `current`                                  | current   | A    |
| `add_ele`, `forward_energy_total`, `total_forward_energy` | energy    | kWh  |
| `cur_frequency`, `frequency`                              | frequency | Hz   |
| `power_factor`                                            | pf        | —    |
| `phase_a` / `phase_b` / `phase_c` (base64)                | per-phase | —    |

Unknown codes are preserved on the snapshot under `extra`, so you can extend
the mapping for an unfamiliar device by inspecting `GET /api/snapshot`.

## Notes

- Tuya rate-limits aggressive polling; 2 s is a safe default. Going below
  1 s on multiple devices may trigger throttling.
- If you see `1004 sign invalid`, double-check the region matches your
  project's data centre.
- Keep `.env` out of git (the included `.gitignore` already excludes it).
