# Machine Log Viewer — Textile CAN Monitor

Live monitoring of textile machinery (DrawFrame / BlowCard / FlyerFrame) over a
UT-6504-FD CAN-FD-to-Ethernet converter, viewable from anywhere.

## Architecture (Option A — cloud relay)
```
 Browser (anywhere) ──https──► [ Render: relay_server.py + dashboard ]
                                          ▲
                                          │ outbound wss (dials up)
                              [ Laptop: agent.py ] ──TCP──► UT-6504-FD (factory LAN)
```

- **relay_server.py** — runs on Render. Serves the dashboard, accepts the laptop
  agent on `/feed`, and broadcasts live frames to browsers on `/ws`.
- **agent.py** — runs on the factory laptop. Reads the converter (TCP 1001-4001),
  decodes each 69-byte CAN-FD frame, and pushes JSON up to the relay.
- **CAN_Dashboard_5.html** — the dashboard UI (Gen4 style, per-machine views).
- **server.py** — all-in-one local version (dashboard + data on one port) for
  running entirely on the laptop without the cloud.

## Deploy
1. Push this repo to GitHub (done).
2. On Render: New ▸ Web Service ▸ connect this repo.
   - Build: `pip install -r requirements.txt`
   - Start: `python relay_server.py`
   - Env var: `FEED_TOKEN` = a secret of your choice.
3. On the laptop: set `RELAY_URL` and `FEED_TOKEN` in `agent.py`, then
   `pip install aiohttp && python agent.py`.
4. Open the Render URL from anywhere → pick a machine → live data.

## Why this stack (Python + single-file HTML)
Chosen for **one converter, a few viewers, fast iteration, zero budget, and a
non-web-dev owner**:
- Python handles raw TCP + CAN byte decoding cleanly and runs with just
  `pip install aiohttp` (no compiler/toolchain).
- A single HTML file opens by double-click — no build step, no `npm`, no bundler.
- Render hosts it free; Chart.js comes from a CDN.

It is the right tool for *now*, not necessarily for scale.

## Upgrade path (when/if this grows)
Trigger points and the recommended upgrade for each:

| When you hit this | Upgrade to |
|---|---|
| Agent must run 24/7 and you don't want Python installed on the gateway PC | **Rewrite `agent.py` in Go** → a single `.exe` that auto-starts on boot, no runtime to install, very robust concurrency. The CAN frame format and the JSON it sends to the relay stay identical, so `relay_server.py` and the dashboard need **no changes**. |
| The dashboard (`CAN_Dashboard_5.html`, ~2000 lines) gets hard to maintain | Move the UI to a component framework (**Svelte** preferred for small bundle / no heavy tooling, or React). Keep the same relay `/ws` JSON contract. |
| Many machines / many customers / persistent history / alerting | Adopt a standard **IoT stack**: agent publishes to **MQTT**, visualize in **Grafana** (or use ThingsBoard / Node-RED). Replaces the custom relay + dashboard with battle-tested infra. |
| Need a permanent fixed URL / no laptop at all | Either a **named Cloudflare tunnel** (permanent URL, laptop still runs the agent) or **Option B**: put the converter in *TCP-client* mode dialing a small **VPS** with a public IP (no laptop needed — needs a ~$5/mo VPS + converter reconfig). |

**Order of priority if productizing:** Go agent first (reliability), then MQTT+Grafana
(scale), then a UI framework (maintainability).
