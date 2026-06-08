# Cloud Deployment Handoff — Textile CAN Monitor (DigitalOcean)

**For:** the software / DevOps engineer who will host this on DigitalOcean
**Prepared by:** Gen4 (Jeeva)
**Repository:** https://github.com/Jeeva-Embedded/Machine_log_viewer
**Current live system (Phase 1):** https://machine-log-viewer-kcx3.onrender.com
**Date:** 2026-06-08

---

## 1. What this project is (in one minute)

We monitor textile machines (DrawFrame, BlowCard, FlyerFrame, RingFrame) live in a web
dashboard, and record every machine's data to log files (raw `.txt` + decoded `.csv`).

Each machine's STM32 motherboard talks to its motors over a **CAN FD bus**. A hardware
converter, the **UTEK UT-6504-FD (CAN FD → Ethernet, 4 channels)**, packs every CAN frame
into a fixed **69-byte TCP packet** and sends it out over the network. One TCP stream per
machine. Our software reads those raw TCP bytes, decodes each frame (CAN ID, function,
source/destination address, data bytes with scaling), shows it live in the browser, and
stores it.

**Important constraint:** the converter speaks **raw TCP only** — no HTTP, no MQTT, no
WebSocket. Anything reading it must open a raw TCP socket. Browsers can't do raw TCP, so a
server in the middle always does: **raw TCP in → decode → WebSocket out to browser.**

---

## 2. What is already built and working (Phase 1 — today)

```
  Browser (anywhere)
       |  HTTPS + secure WebSocket
       v
  [ CLOUD: Render, free ]   relay_server.py  — hosts website, fans out live data
       ^
       |  outbound secure WebSocket (laptop dials UP to cloud)
  [ FACTORY LAPTOP ]        agent.py — reads converter over TCP, decodes, logs, uploads
       |  raw TCP  (192.168.1.125 : 1001/2001/3001/4001)
  UT-6504-FD  (TCP Server mode)
       |  CAN FD
  Machine motors (STM32)
```

What works today:
- Live dashboard at the Render URL above (per-motor cards, charts, temperature gauges, frame log).
- The factory **laptop** runs `agent.py`, which reads all 4 machines in parallel.
- **Always-on logging** (just added): the agent writes per-machine, per-day files
  `M{id}_{Name}_{YYYY-MM-DD}_raw.txt` and `_decoded.csv` to the laptop, and uploads them to
  **Google Drive** via `rclone` (rolls at midnight IST; re-syncs the day's open files every
  ~10 min).
- Logs are listed/downloadable from the dashboard's **Log Files** tab.

**The limitation we want to remove:** a laptop must stay powered on at the machine running
`agent.py`. If it sleeps or is moved, data stops.

---

## 3. What we want you to do (Phase 2 — the ask)

**Remove the laptop.** Put the converter in **TCP Client** mode so it dials OUT directly to
a cloud server we host on **DigitalOcean**. The cloud server decodes the frames and serves
the dashboard — running 24×7, unattended.

```
  Browser (anywhere)
       |  HTTPS / WSS
       v
  [ DigitalOcean Droplet — PUBLIC IP ]   tcp_server.py  (decode + dashboard, one process)
       ^
       |  raw TCP, OUTBOUND from the factory (through the router/NAT — no port-forwarding)
  UT-6504-FD  (TCP Client)  ── factory router ── Internet ──
       |  CAN FD
  Machine motors (STM32)
```

Why DigitalOcean (not Render): Render only accepts HTTP/HTTPS, so the converter (raw TCP)
**cannot dial into Render**. We need a VM with a **real public IP and open raw-TCP ports**.
A DigitalOcean **Droplet** gives us that.

### The Phase-2 server already exists
On the **`phase2`** branch there is `tcp_server.py` — a single process that:
- Listens on raw TCP **9001→machine1, 9002→2, 9003→3, 9004→4** for the converter.
- Decodes the 69-byte frames (same logic as the laptop agent).
- Serves the dashboard at `GET /`, live data at `WS /ws`, status at `GET /health` on **:8080**.
- Tested end-to-end with a simulated converter.

So the core code is ready; we need it **hosted, secured, and made reliable** on DigitalOcean.

---

## 4. Concrete deployment tasks we need help with

1. **Provision a Droplet** (Ubuntu LTS, smallest size is fine — data volume is a few GB/month).
   Note its **public IP** (or attach a reserved IP so it never changes).
2. **Install & run** `tcp_server.py`:
   - `pip install -r requirements.txt` (just `aiohttp`).
   - Run it under a **process manager (systemd)** so it auto-starts on boot and restarts on crash.
   - Default ports: web `8080` (override via `PORT`), TCP in `9001-9004` (override via
     `TCP_PORTS`, e.g. `TCP_PORTS="9001:1,9002:2"`).
3. **Firewall (ufw / DO Cloud Firewall):**
   - Open inbound TCP **9001-9004** for the converter (ideally **restricted to the factory's
     public IP** once we know it).
   - Open **80/443** for the website. Keep everything else closed.
4. **HTTPS + domain:** point a domain/subdomain at the Droplet and terminate TLS
   (Caddy or Nginx reverse proxy → `localhost:8080`). The dashboard auto-uses same-origin
   `wss://` so HTTPS "just works" once it's behind TLS.
5. **Converter config (we'll do on-site, please advise):** set each CAN channel to
   **TCP Client**, Remote IP = Droplet public IP, Remote port = 9001/9002/9003/9004,
   packing = **Fixed 69-byte** format. Because it only dials OUT, the **factory router needs
   no port-forwarding** and this works behind ISP CGNAT.

---

## 5. Open items where we specifically need your guidance

These are not yet solved and we'd like your recommendation:

- **Logging on the cloud server.** The always-on per-day logging + Google Drive upload
  currently lives in `agent.py` (Phase 1, laptop). `tcp_server.py` (Phase 2) does **not** yet
  write/upload logs. We need that ported to the cloud server — **plus a decision on storage:**
  - keep writing CSV/raw to a DigitalOcean **Volume** (block storage) and/or **Spaces** (S3),
  - and/or keep the Google Drive upload via `rclone`.
  (Render's disk is ephemeral, which is *why* logs currently live on the laptop. On a Droplet
  we have persistent disk, so this becomes straightforward.)
- **Authentication.** The dashboard is currently open to anyone with the link. We want at
  least a **login/password** (or IP allow-list) before it's on a public domain.
- **Reliability / monitoring:** systemd auto-restart, uptime monitoring/alerts, and what
  happens to the converter's TCP connection on a server restart (does it auto-redial — yes,
  TCP-client converters retry).
- **Backups & retention:** how long to keep logs, automatic cleanup of old files.

---

## 6. Repository map (what's where)

| File / branch | Purpose |
|---|---|
| `relay_server.py` (main) | Phase-1 cloud relay on Render (HTTP/WS only). |
| `agent.py` (main) | Phase-1 laptop agent: reads converter TCP, decodes, **always-on logging + Drive upload**. |
| `tcp_server.py` (**phase2** branch) | **Phase-2 server to deploy on DigitalOcean** — converter dials in, decode + dashboard in one process. |
| `Textile_FDCAN_Monitor.html` | The dashboard UI (served by both servers). |
| `requirements.txt` | Python deps (`aiohttp`). |
| `PROJECT_OVERVIEW.md` | Non-technical overview for management. |
| `server.py` | Older single-laptop + Cloudflare-tunnel variant (reference only). |

### Key facts for deployment
- **Language/stack:** Python 3 + `aiohttp` (async). Single dependency.
- **Converter:** UTEK UT-6504-FD, frame = fixed **69 bytes** (1 info + 4 CAN ID + 64 data).
- **Machine → TCP port mapping (Phase 2):** 1=9001, 2=9002, 3=9003, 4=9004.
- **Timestamps:** IST (UTC+5:30).
- **Phase-1 auth:** a shared `FEED_TOKEN` secret authorizes the agent to the relay (env var,
  kept out of git).

---

## 7. Summary of the request

> Host `tcp_server.py` (from the `phase2` branch) on a DigitalOcean Droplet with a public IP:
> run it as a managed service, open TCP 9001-9004 (locked to the factory IP) and 443 behind
> TLS on a domain, add persistent log storage + login, and help us point the UT-6504-FD to it
> in TCP-Client mode. End result: the machines stream to the cloud 24×7 with **no laptop**.

Phase 1 (laptop → Render) stays running unchanged until Phase 2 is verified, so there is no
downtime during migration.
