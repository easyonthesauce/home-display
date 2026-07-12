/*
 * Watchtower water dispenser — ESP32 + 4-relay board + 12V pump + flow meter
 * ---------------------------------------------------------------------------
 * Exposes a tiny HTTP API that the Watchtower server calls to run the pump,
 * and pushes measured flow back to Watchtower while pumping.
 *
 *   POST /pump/on    body: {"maxMl":1000,"maxSeconds":60}  -> {"ok":true}
 *   POST /pump/off                                          -> {"ok":true,"ml":<measured>}
 *   GET  /status                                            -> {"ok":true,"pumping":<bool>,"ml":<measured>}
 *
 * SAFETY: this firmware enforces its OWN max-volume and max-duration cutoffs in
 * loop(), independent of the network. If Watchtower crashes or the WiFi drops
 * mid-pour, the pump still shuts off. Never rely on a remote "stop" command to
 * turn off a pump that can flood a room.
 *
 * Wiring (adjust pins to your board):
 *   Relay IN1  -> GPIO 26   (switches the 12V pump; most 4-relay boards are
 *                            ACTIVE-LOW — see RELAY_ACTIVE_LOW below)
 *   Flow meter signal -> GPIO 27  (YF-S201 yellow wire; red=5V, black=GND)
 *   Pump: 12V supply -> relay COM/NO -> pump -> 12V GND. The ESP32 and the 12V
 *   pump share a common ground. Power the ESP32 separately (USB or a 5V buck),
 *   NOT from the pump rail.
 *
 * Libraries: WiFi.h, WebServer.h, HTTPClient.h (all bundled with the ESP32
 * Arduino core). Board: any ESP32 dev module.
 */

#include <WiFi.h>
#include <WebServer.h>
#include <HTTPClient.h>

// ── Configuration ───────────────────────────────────────────────────────────
const char* WIFI_SSID = "YOUR_WIFI";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// Where Watchtower is reachable on your LAN (host:port). Flow reports POST here.
const char* WATCHTOWER_URL = "http://192.168.1.10:4000";

const int RELAY_PIN = 26;            // pump relay
const int FLOW_PIN  = 27;            // flow meter pulse input
const bool RELAY_ACTIVE_LOW = true;  // most 4-relay boards energise on LOW

// Flow calibration: pulses the meter emits per litre. YF-S201 ≈ 450.
// Measure a known volume and adjust for accuracy.
const float PULSES_PER_LITRE = 450.0;

// Absolute hardware safety ceilings, applied on top of whatever limits the
// server sends. The pump can never run longer/further than these.
const unsigned long HARD_MAX_MS = 90UL * 1000UL;  // 90 s
const float         HARD_MAX_ML = 1500.0;         // 1.5 L

// ── State ───────────────────────────────────────────────────────────────────
WebServer server(80);
volatile unsigned long pulseCount = 0;
bool pumping = false;
unsigned long pumpStartMs = 0;
float sessionMaxMl = HARD_MAX_ML;
unsigned long sessionMaxMs = HARD_MAX_MS;
unsigned long lastReportMs = 0;

void IRAM_ATTR onPulse() { pulseCount++; }

float measuredMl() {
  return (pulseCount / PULSES_PER_LITRE) * 1000.0;
}

void relayWrite(bool on) {
  digitalWrite(RELAY_PIN, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void startPump(float maxMl, unsigned long maxSeconds) {
  pulseCount = 0;
  sessionMaxMl = min(maxMl > 0 ? maxMl : HARD_MAX_ML, HARD_MAX_ML);
  sessionMaxMs = min((maxSeconds > 0 ? maxSeconds : 0) * 1000UL, HARD_MAX_MS);
  if (sessionMaxMs == 0) sessionMaxMs = HARD_MAX_MS;
  pumpStartMs = millis();
  lastReportMs = 0;
  pumping = true;
  relayWrite(true);
  Serial.printf("[pump] ON (max %.0fml / %lums)\n", sessionMaxMl, sessionMaxMs);
}

void stopPump(const char* reason) {
  relayWrite(false);
  pumping = false;
  Serial.printf("[pump] OFF (%s) — %.0fml\n", reason, measuredMl());
}

// Push cumulative flow to Watchtower so the dashboard shows a live count.
void reportFlow() {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  http.begin(String(WATCHTOWER_URL) + "/api/water/flow");
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(2000);
  String body = String("{\"ml\":") + String(measuredMl(), 0) + "}";
  http.POST(body);
  http.end();
}

// ── HTTP handlers ───────────────────────────────────────────────────────────
void handlePumpOn() {
  float maxMl = HARD_MAX_ML;
  unsigned long maxSeconds = HARD_MAX_MS / 1000UL;
  if (server.hasArg("plain")) {
    String b = server.arg("plain");
    int mi = b.indexOf("maxMl");
    int si = b.indexOf("maxSeconds");
    if (mi >= 0) maxMl = b.substring(b.indexOf(':', mi) + 1).toFloat();
    if (si >= 0) maxSeconds = b.substring(b.indexOf(':', si) + 1).toInt();
  }
  startPump(maxMl, maxSeconds);
  server.send(200, "application/json", "{\"ok\":true}");
}

void handlePumpOff() {
  stopPump("command");
  server.send(200, "application/json", String("{\"ok\":true,\"ml\":") + String(measuredMl(), 0) + "}");
}

void handleStatus() {
  String json = String("{\"ok\":true,\"pumping\":") + (pumping ? "true" : "false") +
                ",\"ml\":" + String(measuredMl(), 0) + "}";
  server.send(200, "application/json", json);
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  relayWrite(false);                 // pump OFF at boot, before anything else
  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onPulse, FALLING);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[wifi] connecting");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }
  Serial.printf("\n[wifi] %s\n", WiFi.localIP().toString().c_str());

  server.on("/pump/on", HTTP_POST, handlePumpOn);
  server.on("/pump/off", HTTP_POST, handlePumpOff);
  server.on("/status", HTTP_GET, handleStatus);
  server.begin();
  Serial.println("[http] listening on :80");
}

void loop() {
  server.handleClient();

  if (pumping) {
    // Independent hardware dead-man cutoffs.
    if (measuredMl() >= sessionMaxMl) stopPump("max-volume");
    else if (millis() - pumpStartMs >= sessionMaxMs) stopPump("max-duration");

    // Report flow ~4x/second while running.
    if (millis() - lastReportMs > 250) { lastReportMs = millis(); reportFlow(); }
  }
}
