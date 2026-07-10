# home-display

Fullscreen realtime dashboard for Tuya energy monitors. Talks to each meter
**directly over your LAN** (no Tuya Cloud API, no subscription, no rate
limits) via [`tuyapi`](https://github.com/codetheweb/tuyapi), pushes updates
to the browser over WebSocket, and renders animated SVG arc gauges and
rolling number readouts.

## Setup

### 1. Get each device's local key

The local key is a per-device secret your meter uses to encrypt LAN traffic.
You only need to extract it once. A few options:

- **`tinytuya` wizard** — easiest if you can still log into a free Tuya IoT
  developer account (even an expired one often still permits the wizard
  endpoint). `pip install tinytuya && python -m tinytuya wizard`.
- **`tuya-cli wizard`** — same idea, Node-based. `npx @tuyapi/cli wizard`.
- **Smart Life Android app cache** — root the phone, pull
  `/data/data/com.tuya.smartlife/shared_prefs/` and grep for `localKey`.
- **Sniffing during pairing** — `tinytuya` also documents an
  on-pairing-network capture method that doesn't need the cloud.

Whichever route you take, save the `id`, `localKey`, and (optionally) the
device's LAN IP for each meter.

### 2. Configure

```bash
cp .env.example .env
# edit .env: paste each meter's id, local key, label, and (optionally) IP
```

`TUYA_DEVICES` format (comma-separated):

```
TUYA_DEVICES=bf1234…:abcdef0123…:Main Panel,bfabcd…:fedcba9876…:Solar:192.168.1.42
```

If you omit the IP, the server discovers each device via UDP broadcast on
startup — this only works if the server is on the same LAN subnet as the
meter, so for production deployments it's worth pinning the IP via your
router's DHCP reservations.

### 3. Run

```bash
npm install
npm start
```

Open <http://localhost:3000>. Press **F** or click ⛶ for fullscreen.

## How it works

- `src/tuya.js` wraps `tuyapi` so each device gets a persistent TCP
  connection. We listen for the `data` and `dp-refresh` events the meter
  pushes whenever a DP changes, and call `refresh()` on a slow timer
  (`REFRESH_INTERVAL_MS`, default 5 s) as a safety net.
- `src/metrics.js` normalises Tuya's per-model device-point (DP) codes
  into a canonical schema — power (W), voltage (V), current (A), energy
  (kWh), per-phase blobs, frequency, power-factor — with the right
  scaling factors applied.
- `server.js` keeps the latest snapshot per device in memory, emits a
  fresh snapshot to the browser every time a DP changes, and also
  broadcasts on a steady cadence (`BROADCAST_INTERVAL_MS`, default 1 s)
  so stale-data timers in the UI keep ticking.
- The dashboard tweens numbers and gauges between snapshots via
  `requestAnimationFrame`, so the display feels continuous instead of
  stepping with each event.

## Figuring out an unfamiliar meter

The Tuya local protocol identifies DPs by integer index, not by code name,
and the schema varies by model. We pre-map the common indexes used by most
single-phase and 3-phase Tuya energy monitors:

| DP index | Mapped code     | Metric    |
| -------- | --------------- | --------- |
| 17       | `add_ele`       | energy    |
| 18       | `cur_current`   | current   |
| 19       | `cur_power`     | power     |
| 20       | `cur_voltage`   | voltage   |
| 101–103  | `phase_a/b/c`   | per-phase |
| 131      | `frequency`     | frequency |
| 132      | `power_factor`  | pf        |

If your meter doesn't fit, expand the **raw DPs** panel on each card — it
shows the live integer-keyed payload as the device sends it. Map the
indexes you care about into `TUYA_DPS_OVERRIDES` in `.env`:

```
TUYA_DPS_OVERRIDES={"5":"cur_power","6":"cur_voltage","7":"cur_current","9":"add_ele"}
```

Any unmapped index is preserved on the snapshot as `dp_<index>` so nothing
is lost.

## Notes

- Most devices made after ~2020 speak protocol v3.3 or v3.4. If a device
  refuses to connect, flip `TUYA_PROTOCOL_VERSION` to the other one.
- After a firmware OTA or re-pairing the device, the local key changes;
  re-run your extraction step and update `.env`.
- Keep `.env` out of git (the included `.gitignore` already excludes it).
