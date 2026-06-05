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
