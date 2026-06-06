"""
Textile CAN Monitor — RELAY + WEBSITE  (runs on Render, in the cloud)
=====================================================================
  GET /            -> dashboard
  WS  /feed        -> laptop agent pushes live frames + answers file requests
  WS  /ws          -> browsers receive live frames
  GET /api/logs    -> JSON list of saved log files (from the agent's ./logs)
  GET /api/log?name=<file>  -> downloads that log file (fetched from the agent)

The relay holds no CAN data of its own — it forwards what the agent sends and,
for downloads, asks the agent for the file over the live /feed connection.
"""
import os
import json
import base64
import asyncio
import uuid
from aiohttp import web, WSMsgType

FEED_TOKEN = os.environ.get('FEED_TOKEN', 'change-me-please')
PORT       = int(os.environ.get('PORT', '8080'))
HTML_FILE  = 'CAN_Dashboard_5.html'

viewers = set()
last_by_key = {}          # latest frame per machine (snapshot for new viewers)
agent_ws = None           # the laptop agent connection
manifest = []             # latest log-file list from the agent
pending = {}              # req_id -> {'future':Future, 'chunks':[]}


async def index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{HTML_FILE} not found", status=404)
    return web.FileResponse(path)


async def health(request):
    return web.json_response({'status': 'ok', 'version': 'v3-autodeploy',
                              'viewers': len(viewers),
                              'agent_connected': agent_ws is not None,
                              'log_files': len(manifest)})


async def api_logs(request):
    return web.json_response({'agent': agent_ws is not None, 'files': manifest})


async def api_log(request):
    name = request.query.get('name', '')
    if not name:
        return web.Response(status=400, text='missing name')
    if agent_ws is None:
        return web.Response(status=503, text='agent offline — start START_AGENT.bat on the laptop')
    req_id = uuid.uuid4().hex
    fut = asyncio.get_event_loop().create_future()
    pending[req_id] = {'future': fut, 'chunks': []}
    try:
        await agent_ws.send_str(json.dumps({'type': 'get_file', 'req_id': req_id, 'name': name}))
        b64 = await asyncio.wait_for(fut, timeout=90)
    except asyncio.TimeoutError:
        return web.Response(status=504, text='timeout fetching file from laptop')
    except Exception as e:
        return web.Response(status=500, text=f'error: {e}')
    finally:
        pending.pop(req_id, None)
    data = base64.b64decode(b64) if b64 else b''
    return web.Response(body=data, headers={
        'Content-Disposition': f'attachment; filename="{os.path.basename(name)}"',
        'Content-Type': 'application/octet-stream'})


async def feed_handler(request):
    """Laptop agent: pushes live frames + manifest + file chunks."""
    global agent_ws
    if request.query.get('token') != FEED_TOKEN:
        return web.Response(status=403, text='bad token')
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=0)
    await ws.prepare(request)
    agent_ws = ws
    print("[+] Agent connected")
    # if viewers are already watching, tell the agent to start recording immediately
    if viewers:
        try: await ws.send_str(json.dumps({'type': 'record_start'}))
        except Exception: pass
    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                if msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
                    break
                continue
            data = msg.data
            # control messages have a 'type'; data frames don't
            try:
                j = json.loads(data)
            except Exception:
                continue
            t = j.get('type')
            if t == 'manifest':
                manifest[:] = j.get('files', [])
            elif t == 'file_chunk':
                p = pending.get(j.get('req_id'))
                if p:
                    p['chunks'].append(j.get('b64', ''))
            elif t == 'file_end':
                p = pending.get(j.get('req_id'))
                if p and not p['future'].done():
                    p['future'].set_result(''.join(p['chunks']))
            elif t == 'file_error':
                p = pending.get(j.get('req_id'))
                if p and not p['future'].done():
                    p['future'].set_exception(Exception(j.get('msg', 'error')))
            else:
                # live data frame -> remember + broadcast to viewers
                last_by_key[j.get('machine', 0)] = data
                dead = []
                for v in viewers:
                    try:
                        await v.send_str(data)
                    except Exception:
                        dead.append(v)
                for d in dead:
                    viewers.discard(d)
    finally:
        # only clear if this is still the active agent (avoids a reconnect race
        # where an old connection's cleanup wipes a newer connection)
        if agent_ws is ws:
            agent_ws = None
            manifest.clear()
            print("[-] Agent disconnected")
    return ws


async def view_handler(request):
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    was_empty = (len(viewers) == 0)
    viewers.add(ws)
    print(f"[+] Viewer connected ({len(viewers)} total)")
    # first viewer connecting -> start a recording session on the agent
    if was_empty and agent_ws is not None:
        try: await agent_ws.send_str(json.dumps({'type': 'record_start'}))
        except Exception: pass
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
        # last viewer left -> stop recording (session saved on the laptop)
        if len(viewers) == 0 and agent_ws is not None:
            try: await agent_ws.send_str(json.dumps({'type': 'record_stop'}))
            except Exception: pass
    return ws


def main():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/health', health)
    app.router.add_get('/api/logs', api_logs)
    app.router.add_get('/api/log', api_log)
    app.router.add_get('/feed', feed_handler)
    app.router.add_get('/ws', view_handler)
    print(f"Relay on :{PORT}  (token set: {FEED_TOKEN != 'change-me-please'})")
    web.run_app(app, host='0.0.0.0', port=PORT)


if __name__ == '__main__':
    main()
