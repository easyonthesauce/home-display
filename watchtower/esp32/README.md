# Watchtower water dispenser — ESP32 firmware

Reference firmware for the hardware side of the Water Challenge: an ESP32 that
switches a 12V pump through a relay and measures how much water is dispensed
with an inline flow meter.

`water_pump/water_pump.ino` is a complete Arduino sketch. Watchtower calls it
over HTTP to run the pump; it pushes measured flow back while pumping.

## Parts

- ESP32 dev board
- 4-channel relay board (only one channel is used here — for the pump)
- 12V diaphragm water pump
- Inline flow meter (e.g. YF-S201 — Hall-effect, ~450 pulses/litre)
- 12V power supply for the pump; separate 5V/USB power for the ESP32

## Wiring

```
ESP32 GPIO 26 ──▶ Relay IN1
ESP32 GPIO 27 ──▶ Flow meter signal (YF-S201 yellow)   [red→5V, black→GND]
ESP32 GND ──────── common ground with the 12V supply

12V (+) ──▶ Relay COM
Relay NO ──▶ Pump (+)
Pump (−) ──▶ 12V (−)
```

Power the ESP32 from USB or a 5V buck converter — **not** from the 12V pump
rail. The ESP32 ground and the 12V ground must be tied together so the flow
meter signal has a reference.

> Most 4-relay boards are **active-LOW** (the channel energises when the ESP32
> drives the pin LOW). The sketch defaults to that (`RELAY_ACTIVE_LOW = true`);
> flip it if your board is active-HIGH. The relay is driven OFF in `setup()`
> before anything else, so the pump can't latch on at boot.

## Configure & flash

Edit the constants at the top of `water_pump.ino`:

- `WIFI_SSID` / `WIFI_PASS`
- `WATCHTOWER_URL` — e.g. `http://192.168.1.10:4000` (where Watchtower runs)
- pins, `RELAY_ACTIVE_LOW`, and `PULSES_PER_LITRE` for your meter

Flash with the Arduino IDE (Board: "ESP32 Dev Module") or `arduino-cli`. Open
the serial monitor at 115200 to see the assigned IP, then point Watchtower at
it:

```
# Watchtower .env
WATER_ENABLED=1
WATER_ESP32_URL=http://<the-esp32-ip>
```

## Calibration

`PULSES_PER_LITRE` decides how pulses convert to millilitres. Dispense into a
measuring jug, compare the reported ml to the actual volume, and scale:

```
new_value = PULSES_PER_LITRE × (reported_ml / actual_ml)
```

## Safety

The firmware enforces its **own** cutoffs in `loop()` — `HARD_MAX_ML` (1.5 L)
and `HARD_MAX_MS` (90 s) — on top of the per-pour limits Watchtower sends. If
Watchtower crashes, the WiFi drops, or a "stop" command never arrives, the pump
still shuts off. Keep these ceilings conservative for your reservoir and
plumbing, and don't dispense unattended.
