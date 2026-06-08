# Remote Access — View the CAN Monitor from Anywhere

Your CAN converter (UT-6504-FD) sits on the factory LAN, so the **laptop
connected to it** must stay on and run two things: the server and the tunnel.
A teammate anywhere then opens a public link in their browser.

```
 Teammate's browser (anywhere)
        |  https / wss
        v
 Cloudflare edge  <-- secure tunnel --
        |
 [ THIS LAPTOP ]  server.py  (port 8080)  +  cloudflared
        |  TCP 1001-4001
   UT-6504-FD  ->  CAN machines
```

## First-time setup (already done on this laptop)
- `pip install aiohttp`
- `winget install Cloudflare.cloudflared`

## Daily use — the easy way
1. Make sure the laptop is connected to the converter (192.168.1.125).
2. Double-click **`START_REMOTE.bat`**.
3. In the window that opens, find the line:
   `https://<random-words>.trycloudflare.com`
4. Send that link to your teammate. They open it → pick the machine → live values.
5. **Keep that window open** while they're viewing. Closing it ends the link.

## Manual way (two terminals)
```
python server.py
cloudflared tunnel --url http://localhost:8080
```

## Things to know
- **The free link is temporary** — it changes every time you restart the tunnel.
  Fine for quick sharing. For a *permanent fixed address* you need a free
  Cloudflare account + a named tunnel (can wire this up on request).
- **Laptop must stay awake.** If it sleeps or the window closes, the link dies.
  (Set Windows power plan to "never sleep" while monitoring.)
- **The link is public** — anyone who has it can view the data. No login yet.
  Ask if you want a password gate added.
- **Local viewing** still works without the tunnel:
  open `http://localhost:8080` on the laptop, or
  `http://<laptop-LAN-ip>:8080` from another PC on the same factory network.

## Files
- `server.py` — serves the dashboard **and** the live data on one port (8080)
- `Textile_FDCAN_Monitor.html` — the dashboard (served by server.py)
- `START_REMOTE.bat` — one-click: server + public tunnel
- `ws_proxy.py` — older 2-process version (no longer needed; server.py replaces it)
