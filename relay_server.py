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
import hmac
import tempfile
from aiohttp import web, WSMsgType

import can_spec

FEED_TOKEN     = os.environ.get('FEED_TOKEN', 'change-me-please')
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', '')   # empty = admin page disabled
PORT           = int(os.environ.get('PORT', '8080'))
HTML_FILE      = 'Textile_FDCAN_Monitor.html'
ADMIN_FILE     = 'admin.html'
CONFIG_FILE    = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'can_config.json')
MAX_UPLOAD     = 10 * 1024 * 1024   # 10 MB cap on the uploaded .xlsx

viewers = set()
last_by_key = {}          # latest frame per machine (snapshot for new viewers)
agent_ws = None           # the laptop agent connection
manifest = []             # latest log-file list from the agent
pending = {}              # req_id -> {'future':Future, 'chunks':[]}

# Admin: the saved CAN-plan decode config (None until an admin saves one).
# Render's free disk is EPHEMERAL, so this relay copy is lost on redeploy — but it
# is NOT the source of truth. On Save we forward the config to the laptop agent,
# which persists it durably (can_config.json) and decodes with it. When the agent
# reconnects it sends the config back up, so the relay recovers it automatically
# after a redeploy (see feed_handler). Relay's own can_config.json is just a cache.
can_config = None
def _load_config():
    global can_config
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, encoding='utf-8') as f:
                can_config = json.load(f)
    except Exception as e:
        print(f"[admin] could not load {CONFIG_FILE}: {e}")

def _write_config_file(cfg):
    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        print(f"[admin] could not write {CONFIG_FILE}: {e}")
        return False


async def index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{HTML_FILE} not found", status=404)
    return web.FileResponse(path)


async def health(request):
    return web.json_response({'status': 'ok', 'version': 'v5-agent-config',
                              'viewers': len(viewers),
                              'agent_connected': agent_ws is not None,
                              'admin_enabled': bool(ADMIN_PASSWORD),
                              'has_config': can_config is not None,
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


# ── Admin: upload + parse + edit + save the CAN Communication Plan ─────────────
def _admin_ok(request):
    """True if the request carries the correct admin password.

    Admin is DISABLED unless ADMIN_PASSWORD is set, so the page is never silently
    open. The page sends the password in the X-Admin-Token header.
    """
    if not ADMIN_PASSWORD:
        return False
    tok = request.headers.get('X-Admin-Token', '')
    return hmac.compare_digest(tok, ADMIN_PASSWORD)


async def admin_index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ADMIN_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{ADMIN_FILE} not found", status=404)
    return web.FileResponse(path)


async def admin_login(request):
    if not ADMIN_PASSWORD:
        return web.json_response({'ok': False, 'error': 'admin not configured'}, status=503)
    try:
        body = await request.json()
    except Exception:
        body = {}
    pw = body.get('password', '')
    if hmac.compare_digest(pw, ADMIN_PASSWORD):
        return web.json_response({'ok': True})
    return web.json_response({'ok': False, 'error': 'wrong password'}, status=401)


async def admin_upload(request):
    """Receive an .xlsx, parse it, return {config, warnings}. Does NOT persist."""
    if not ADMIN_PASSWORD:
        return web.json_response({'error': 'admin not configured'}, status=503)
    if not _admin_ok(request):
        return web.json_response({'error': 'unauthorized'}, status=401)
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != 'file':
        return web.json_response({'error': 'no file field'}, status=400)
    filename = field.filename or 'upload.xlsx'
    if not filename.lower().endswith('.xlsx'):
        return web.json_response({'error': 'please upload an .xlsx file'}, status=400)
    size = 0
    tmp = tempfile.NamedTemporaryFile(suffix='.xlsx', delete=False)
    try:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            size += len(chunk)
            if size > MAX_UPLOAD:
                return web.json_response({'error': 'file too large (max 10 MB)'}, status=413)
            tmp.write(chunk)
        tmp.close()
        try:
            cfg = await asyncio.get_event_loop().run_in_executor(None, can_spec.parse_plan, tmp.name)
        except Exception as e:
            return web.json_response({'error': f'could not parse: {e}'}, status=400)
        # version is detected from the filename, but parse ran on a temp path —
        # re-derive both from the real uploaded name.
        cfg['source_file'] = os.path.basename(filename)
        cfg['version'] = can_spec._detect_version(filename)
        return web.json_response({'config': cfg, 'warnings': cfg.get('warnings', [])})
    finally:
        try: os.unlink(tmp.name)
        except OSError: pass


async def admin_get_config(request):
    if not _admin_ok(request):
        return web.json_response({'error': 'unauthorized'}, status=401)
    return web.json_response({'config': can_config})


async def admin_save_config(request):
    global can_config
    if not _admin_ok(request):
        return web.json_response({'error': 'unauthorized'}, status=401)
    try:
        body = await request.json()
    except Exception:
        return web.json_response({'error': 'invalid JSON'}, status=400)
    cfg = body.get('config')
    if not isinstance(cfg, dict) or 'machines' not in cfg or 'function_ids' not in cfg:
        return web.json_response({'error': 'config must have function_ids and machines'}, status=400)
    cfg['saved_at'] = can_spec.datetime.now(can_spec.IST).isoformat(timespec='seconds')
    if not _write_config_file(cfg):
        return web.json_response({'error': 'could not save config file'}, status=500)
    can_config = cfg
    # push to the laptop agent so it persists (durably) + decodes with the new maps
    forwarded = False
    if agent_ws is not None:
        try:
            await agent_ws.send_str(json.dumps({'type': 'set_can_config', 'config': cfg}))
            forwarded = True
        except Exception:
            pass
    print(f"[admin] config saved ({len(cfg.get('function_ids', []))} function ids), "
          f"forwarded to agent: {forwarded}")
    return web.json_response({'ok': True, 'saved_at': cfg['saved_at'], 'agent_updated': forwarded})


async def feed_handler(request):
    """Laptop agent: pushes live frames + manifest + file chunks."""
    global agent_ws, can_config
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
    # if the relay already holds a config (admin edited it), push it DOWN so the agent
    # adopts the authoritative copy; otherwise the agent will send ITS copy up (below).
    if can_config is not None:
        try: await ws.send_str(json.dumps({'type': 'set_can_config', 'config': can_config}))
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
            if t == 'can_config':
                # agent seeded us with its persisted config — adopt only if we have
                # none (e.g. just redeployed). If we already have one, ours wins and
                # was already pushed down on connect, so ignore this.
                if can_config is None and isinstance(j.get('config'), dict):
                    can_config = j['config']
                    _write_config_file(can_config)
                    print("[admin] adopted config from agent (post-redeploy recovery)")
            elif t == 'manifest':
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
            if msg.type == WSMsgType.TEXT:
                # browser -> relay control (e.g. set Google Drive folder) -> forward to agent
                try:
                    j = json.loads(msg.data)
                    if j.get('type') == 'set_drive_folder' and agent_ws is not None:
                        await agent_ws.send_str(msg.data)
                except Exception:
                    pass
            elif msg.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
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
    _load_config()
    app = web.Application(client_max_size=MAX_UPLOAD + 1024 * 1024)
    app.router.add_get('/', index)
    app.router.add_get('/health', health)
    app.router.add_get('/api/logs', api_logs)
    app.router.add_get('/api/log', api_log)
    app.router.add_get('/feed', feed_handler)
    app.router.add_get('/ws', view_handler)
    # admin page (CAN Communication Plan upload/parse/edit/save)
    app.router.add_get('/admin', admin_index)
    app.router.add_post('/api/admin/login', admin_login)
    app.router.add_post('/api/admin/upload', admin_upload)
    app.router.add_get('/api/admin/config', admin_get_config)
    app.router.add_post('/api/admin/config', admin_save_config)
    print(f"Relay on :{PORT}  (token set: {FEED_TOKEN != 'change-me-please'}, "
          f"admin: {'on' if ADMIN_PASSWORD else 'OFF'})")
    web.run_app(app, host='0.0.0.0', port=PORT)


if __name__ == '__main__':
    main()
