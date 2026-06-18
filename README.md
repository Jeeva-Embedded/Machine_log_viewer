# Textile CAN Monitor â€” Gen4 Industrial IoT

Live monitoring of textile machinery (**DrawFrame Â· BlowCard Â· FlyerFrame Â· RingFrame**)
over a **UTEK UT-6504-FD** CAN-FD-to-Ethernet converter, viewable from anywhere, with
per-session logging to raw `.txt` + decoded `.csv` and Google-Drive backup.

- **Repository:** https://github.com/Jeeva-Embedded/Machine_log_viewer
- **Live (Phase 1):** https://textile-can-monitor.onrender.com

> This single file is the project's only documentation. Section 9 is the DigitalOcean /
> Phase-2 handoff for a DevOps engineer.

---

## 1. What it is

Each machine's STM32 motherboard talks to its motors over a **CAN FD** bus. The UT-6504-FD
converter packs every CAN frame into a fixed **69-byte TCP packet** (1 byte frame info +
4 byte CAN ID + 64 byte data) and streams it out â€” **one TCP port per machine**
(1001/2001/3001/4001). The converter speaks **raw TCP only** (no HTTP/MQTT/WebSocket), and
browsers can't open raw TCP â€” so a program in the middle always does
**raw TCP in â†’ decode â†’ WebSocket out to the browser**.

Per motor the data includes: Target/Present RPM, PWM, MOSFET & motor temperature,
current (A), voltage (V), power (W), run setup (ramp up/down, RPM), plus machine-specific
data (DrawFrame AutoLeveller; FlyerFrame lift motors).

---

## 2. Architecture (Phase 1 â€” live today)

```
  Browser (office / home / phone)
       â”‚  HTTPS + secure WebSocket
       â–¼
  [ CLOUD: Render, free ]   relay_server.py  â€” serves the site, fans out live data
       â–²
       â”‚  outbound wss (the laptop dials UP to the cloud)
  [ FACTORY LAPTOP ]        agent.py â€” reads converter over TCP, decodes, logs, uploads
       â”‚  raw TCP  (192.168.1.125 : 1001/2001/3001/4001)
  UT-6504-FD  (TCP Server mode)
       â”‚  CAN FD
  Machine motors (STM32)
```

- **`relay_server.py`** (Render) â€” serves the dashboard + admin page, accepts the laptop
  agent on `/feed`, broadcasts live frames to browsers on `/ws`, exposes log
  list/download (`/api/logs`, `/api/log`) and the admin API (`/api/admin/*`).
- **`agent.py`** (factory laptop) â€” reads all 4 machines in parallel, decodes each frame
  to JSON, pushes it up to the relay, and writes per-machine/per-day logs (uploaded to
  Google Drive via rclone). Holds nothing else; the relay is stateless w.r.t. CAN data.
- **`can_spec.py`** â€” parses the *CAN Communication Plan* Excel into a decode config
  (see Â§6).
- **`server.py`** â€” all-in-one local variant (dashboard + live data on one port) for
  running entirely on the laptop, optionally exposed via a Cloudflare tunnel (see Â§8).

---

## 3. Project structure

```
/                         repo root â€” Python stays here (Render & laptop run these)
â”œâ”€â”€ README.md             â† this file (single source of docs)
â”œâ”€â”€ render.yaml           Render blueprint (env: FEED_TOKEN, ADMIN_PASSWORD)
â”œâ”€â”€ requirements.txt      aiohttp, openpyxl
â”œâ”€â”€ relay_server.py       Phase-1 cloud relay + website + admin API
â”œâ”€â”€ agent.py              Phase-1 laptop agent (TCP read, decode, log, Drive upload)
â”œâ”€â”€ can_spec.py           CAN Communication Plan (.xlsx) â†’ decode config
â”œâ”€â”€ server.py             local all-in-one server (Cloudflare-tunnel variant)
â””â”€â”€ web/                  all static frontend, served by the relay
    â”œâ”€â”€ dashboard.html    page shell (markup only)
    â”œâ”€â”€ admin.html        admin page shell (markup only)
    â”œâ”€â”€ css/
    â”‚   â”œâ”€â”€ theme.css     shared design tokens (:root), reset, keyframes
    â”‚   â”œâ”€â”€ dashboard.css dashboard styles
    â”‚   â””â”€â”€ admin.css     admin styles
    â””â”€â”€ js/
        â”œâ”€â”€ dashboard.js  the dashboard engine (WebSocket, decode, charts, render)
        â”œâ”€â”€ admin.js      the admin page logic
        â””â”€â”€ machines/     ONE file per machine â€” debug a machine in isolation here
            â”œâ”€â”€ drawframe.js   blowcard.js   flyerframe.js   ringframe.js
```

**Per-machine files:** each `web/js/machines/*.js` registers that machine's spec
(`addrMap`, `motorMap`, `motorNames`, `fnMap`, `hasAL`, `hasLifts`, `errorBytes`, port,
labels) into `window.MACHINE_CONFIG` / `window.MACHINE_DEFS`. `dashboard.js` is a generic
engine that reads those â€” so a wrong address or motor for one machine is fixed in that one
file; shared rendering/decoding bugs live in `dashboard.js`. The machine files load
**before** `dashboard.js` (plain `<script>` tags, in that order).

---

## 4. Run locally

```bash
pip install -r requirements.txt
# Phase-1 relay (the cloud component, but runnable locally):
ADMIN_PASSWORD=test123 FEED_TOKEN=dev PORT=8080 python relay_server.py
# open http://localhost:8080  (dashboard)  and  http://localhost:8080/admin
```

On Windows PowerShell, set env vars first: `$env:ADMIN_PASSWORD="test123"` etc.

To drive it with live CAN, run the agent on the laptop wired to the converter (Â§5). The
all-in-one `server.py` (no cloud) is an alternative for laptop-only use (Â§8).

`GET /health` returns a JSON status incl. a `version` field â€” handy to confirm a deploy.

---

## 5. The laptop agent

Set these (in `START_AGENT.bat`, which is **gitignored** because it holds the secret):

```
RELAY_URL  = wss://textile-can-monitor.onrender.com/feed
FEED_TOKEN = <the same secret set in Render>
CAN_HOST   = 192.168.1.125            (the converter)
DRIVE_FOLDER_ID = <Google Drive folder>   (optional; also settable from the website)
```

Then `python agent.py`. The agent:
- reads TCP 1001-4001, decodes the 69-byte frames, streams JSON to the relay;
- logs **always-on** per machine per session: `M{id}_{Name}_{YYYY-MM-DDTHH-MM-SS}_raw.txt` / `_decoded.csv`
  (IST timestamps). Each agent start creates its own files — 3 runs = 3 file pairs per machine.
  Logging runs regardless of relay/browser state. Drive sync via **rclone** every ~10 min.
- answers the website's log list/download requests over the live feed.

---

## 6. Admin page â€” spec-driven decoding

`/admin` (password-gated by the `ADMIN_PASSWORD` env var; **disabled** if unset, never
silently open) lets an admin upload the **CAN Communication Plan** Excel and manage how
frames are decoded â€” instead of editing maps in code.

Flow: **upload `.xlsx` â†’ parse â†’ review machine-wise â†’ edit inline â†’ Save**.
`can_spec.py` parses the workbook into a config: global Function IDs (`All FunctionIDs`
sheet), per-machine **identifiers** (`Identifiers` sheet), and per-machine **frames** from
the master `Frame For All Machines` sheet â€” each frame carrying `fn`, `can_id`, src/dst +
derived addresses, `dlc`, `ack`, and the **DB0..DB11 data-byte layout**.

**Where it's stored / how it persists:** on Save the relay forwards the config to the
laptop agent, which persists `can_config.json` **on the laptop** (durable) and decodes
with it live (no restart â€” name maps are looked up per frame). On reconnect the agent
sends the config back up, so the relay recovers it automatically after a redeploy
(Render's disk is ephemeral; the laptop is the source of truth). `can_config.json` is
gitignored on both sides; the admin page also offers **Download JSON**.

**Scope today:** the config overrides the address/function **name** maps. The numeric
byte scaling in the decoders is still keyed by function ID in code (deriving full scaling
from the Excel is a future step).

---

## 7. Deploy (Render â€” Phase 1)

Auto-deploys on push to **`main`** (the GitHub App must have repo access).

- Build: `pip install -r requirements.txt`  Â·  Start: `python relay_server.py`
- Env (Dashboard â†’ Environment, both `sync:false`):
  - `FEED_TOKEN` â€” shared secret the agent uses to authorize to `/feed`.
  - `ADMIN_PASSWORD` â€” password for `/admin` (omit to disable the admin page).
- Free tier sleeps after 15 min idle â†’ an UptimeRobot HTTPS monitor pings `/health`
  every 5 min (the always-on agent also keeps it awake while connected).
- Verify a deploy via the `version` field in `/health`.

Secrets stay **out of git**: `agent.py` defaults are placeholders; the real token lives
only in the laptop's gitignored `START_AGENT.bat`.

---

## 8. Remote access without the cloud (laptop + Cloudflare tunnel)

`server.py` serves the dashboard **and** the live data on one port (8080) directly from the
laptop. Expose it with a quick tunnel:

```bash
python server.py
cloudflared tunnel --url http://localhost:8080      # prints a public https URL
```

The quick-tunnel URL is **temporary** (changes each restart) and **public** (no login).
Local viewing also works at `http://localhost:8080` or `http://<laptop-LAN-ip>:8080`.
For a permanent URL, use a free Cloudflare account + a named tunnel.

---

## 9. Phase 2 (no laptop) â€” DigitalOcean / Oracle handoff

**Goal:** remove the laptop. Put the converter in **TCP-Client** mode so it dials OUT
through the factory router to a cloud VM with a **public IP and open raw-TCP ports** (Render
only accepts HTTP, so it can't be the Phase-2 host). The VM decodes and serves the same
dashboard, 24Ã—7.

```
  Browser â”€â”€HTTPS/WSSâ”€â”€â–º [ VM, PUBLIC IP ] tcp_server.py (decode + dashboard, one process)
                                â–² raw TCP, OUTBOUND from the factory (NAT, no port-forwarding)
                         UT-6504-FD (TCP Client) â”€â”€ factory router â”€â”€ Internet
```

- **`tcp_server.py`** lives on the **`phase2` branch**: listens on raw TCP
  **9001â†’m1, 9002â†’m2, 9003â†’m3, 9004â†’m4**, decodes the 69-byte frames (same logic as the
  agent), serves `GET /` + `WS /ws` + `GET /health` on `:8080`. Tested with a mock converter.
- **Deploy tasks:** provision an Ubuntu Droplet (smallest size â€” data is a few GB/mo) with a
  reserved public IP; run `tcp_server.py` under **systemd** (auto-start/restart); open
  inbound TCP **9001-9004** (ideally locked to the factory's public IP) and **80/443**;
  terminate TLS with Caddy/Nginx â†’ `localhost:8080` (the dashboard auto-uses same-origin
  `wss://`). Converter: set each channel to TCP-Client, Remote IP = VM, Remote port =
  9001-9004, fixed 69-byte packing. Outbound-only â‡’ works behind ISP CGNAT, no port-forward.
- **Open items for the DevOps engineer:** port the always-on logging + Drive upload (today
  in `agent.py`) to the server with persistent storage (DO Volume/Spaces and/or rclone to
  Drive); add auth (login or IP allow-list) before exposing a public domain; uptime
  monitoring + backups/retention.
- **Free-VM alternative:** Oracle Cloud "Always Free" gives a forever-free VM with a public
  IP and open ports (card required for identity verification only â€” Always-Free isn't
  charged). Google Cloud Always Free `e2-micro` also works for one stream.

Phase 1 (laptop â†’ Render) keeps running unchanged until Phase 2 is verified â€” no downtime.

---

## 10. Upgrade path (when/if this grows)

| When you hit this | Upgrade to |
|---|---|
| Agent must run 24/7 without Python on the gateway PC | Rewrite `agent.py` in **Go** â†’ a single auto-starting `.exe`; the frame format + JSON contract stay identical, so the relay/dashboard don't change. |
| `dashboard.js` gets hard to maintain | Move the UI to a component framework (**Svelte** preferred for a small bundle, or React); keep the `/ws` JSON contract. |
| Many machines / customers / history / alerting | Standard IoT stack: agent â†’ **MQTT**, visualize in **Grafana** (or ThingsBoard / Node-RED). |
| Permanent fixed URL / no laptop | Named **Cloudflare tunnel** (Phase 1) or the Phase-2 VPS domain. |

**Priority if productizing:** Go agent (reliability) â†’ MQTT+Grafana (scale) â†’ UI framework.

---

## 11. Reference facts

- **Stack:** Python 3 + `aiohttp` (async) + `openpyxl` (Excel parsing). Frontend is plain
  HTML/CSS/JS with Chart.js from a CDN â€” no build step.
- **Converter:** UTEK UT-6504-FD, frame = fixed **69 bytes** (1 info + 4 CAN ID + 64 data).
- **Machine â†’ TCP port:** Phase 1 = 1001/2001/3001/4001; Phase 2 = 9001-9004.
- **CAN ID encoding:** extended 29-bit; FI = bits 23-16, DestAddr = 15-8, SrcAddr = 7-0.
- **Timestamps:** IST (UTC+5:30).
- **Scaling:** current = ADC Ã— 0.00672 A; voltage = ADC Ã— 0.017 V.
- **Branches:** `main` = live Phase 1; `phase2` = `tcp_server.py` for the no-laptop server.
```

