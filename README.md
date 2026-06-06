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

---

## Phased plan

### Phase 1 — CURRENT (live)
Laptop runs `agent.py` (reads the converter on the factory LAN and dials **up** to
the Render relay). Browser opens the Render URL. A laptop must stay on next to the
machine. Free (Render free tier). This is what's deployed today.

```
 Browser ──https──► [ Render: relay + dashboard ] ◄──wss── [ Laptop agent ] ──TCP──► UT-6504-FD
```

### Phase 2 — PLANNED: converter → router → server (no laptop)
Remove the laptop entirely. The UT-6504-FD is plugged into the **factory router**
(internet access) and configured in **TCP-Client mode** so the converter itself
**dials out** to our cloud server and streams the raw CAN frames.

```
 Machine ─CAN─► UT-6504-FD ─Ethernet─► Router ─Internet(NAT, outbound)─► Cloud Server ──► Browsers
```

How it works / what's needed:
- **Converter config:** set Network mode = *TCP Client*, Remote Server = our server's
  public IP, Remote Port = e.g. `443`/`9001`, and set the converter's Gateway to the
  router so it can reach the internet. It dials **outbound**, so **no port-forwarding
  or static public IP** is needed at the factory.
- **Server side needs a real public TCP port.** Render web services only expose
  HTTP/HTTPS, so Phase 2 needs a small **VPS** (DigitalOcean / AWS Lightsail / Hetzner,
  ~$5/mo) with a public IP. A `tcp_server.py` *listens* for the converter, decodes the
  69-byte frames (reuse the exact decode logic already in `agent.py`/`server.py` —
  only the direction flips from "connect to converter" to "accept from converter"),
  then serves the dashboard + `/ws` to browsers (same `relay_server.py` UI).
- **Multiple converters / channels:** each CAN port (1001–4001) can be pointed at the
  server; tag each stream by source so the dashboard routes it to the right machine.
- **Security:** restrict the listener to the converter's source, or add a simple
  handshake/token, since a raw public TCP port is otherwise open.

Trade-off vs Phase 1: Phase 2 is hands-off (no laptop) and "always on", but costs a
small VPS fee and requires reconfiguring the converter. Phase 1 stays as the free
fallback.

### Phase 2+ (scale, from the upgrade table above)
Go agent/listener (single binary), MQTT + Grafana for many machines, optional UI
framework. Permanent fixed URL via a named Cloudflare tunnel (Phase 1) or the VPS
domain (Phase 2).
