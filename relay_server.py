"""
Textile CAN Monitor — RELAY + WEBSITE  (runs on Render, in the cloud)
=====================================================================
This is the cloud half of "Option A". It does three things:

  GET /        -> serves the dashboard (CAN_Dashboard_5.html)
  WS  /feed    -> the laptop agent connects here and PUSHES live frames up
  WS  /ws      -> browsers connect here and RECEIVE the live frames

The relay never touches the CAN converter directly (it can't — the converter
is on the factory LAN). It only forwards whatever the laptop agent sends.

Render sets the PORT environment variable automatically.
Set FEED_TOKEN in Render -> Environment to a secret of your choice, and use the
same value in the laptop agent, so randoms can't push fake data.
"""
import os
import json
from aiohttp import web, WSMsgType

FEED_TOKEN = os.environ.get('FEED_TOKEN', 'change-me-please')
PORT       = int(os.environ.get('PORT', '8080'))
HTML_FILE  = 'CAN_Dashboard_5.html'

viewers = set()          # browser websockets currently watching
last_by_key = {}         # latest frame per machine, sent to new viewers as a snapshot


async def index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{HTML_FILE} not found", status=404)
    return web.FileResponse(path)


async def health(request):
    return web.json_response({'status': 'ok', 'viewers': len(viewers),
                              'agent_connected': bool(last_by_key)})


async def feed_handler(request):
    """Laptop agent pushes decoded JSON frames here."""
    if request.query.get('token') != FEED_TOKEN:
        return web.Response(status=403, text='bad token')
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=0)
    await ws.prepare(request)
    print("[+] Agent connected")
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                data = msg.data
                # remember latest per machine for snapshotting new viewers
                try:
                    j = json.loads(data)
                    last_by_key[j.get('machine', 0)] = data
                except Exception:
                    pass
                # broadcast to all browser viewers
                dead = []
                for v in viewers:
                    try:
                        await v.send_str(data)
                    except Exception:
                        dead.append(v)
                for d in dead:
                    viewers.discard(d)
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
    finally:
        print("[-] Agent disconnected")
    return ws


async def view_handler(request):
    """Browsers connect here to watch."""
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    viewers.add(ws)
    print(f"[+] Viewer connected ({len(viewers)} total)")
    # send a snapshot of the latest frame per machine so the new viewer isn't blank
    for data in list(last_by_key.values()):
        try:
            await ws.send_str(data)
        except Exception:
            pass
    try:
        async for msg in ws:
            if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                break
    finally:
        viewers.discard(ws)
        print(f"[-] Viewer left ({len(viewers)} total)")
    return ws


def main():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/health', health)
    app.router.add_get('/feed', feed_handler)
    app.router.add_get('/ws', view_handler)
    print(f"Relay listening on :{PORT}  (feed token set: {FEED_TOKEN != 'change-me-please'})")
    web.run_app(app, host='0.0.0.0', port=PORT)


if __name__ == '__main__':
    main()
