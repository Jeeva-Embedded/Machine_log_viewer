"""
DrawFrame / Textile CAN Monitor — Combined Web + Live Server
=============================================================
Serves the dashboard AND the live CAN data from ONE port (8080).
This makes it easy to expose remotely through a single tunnel
(Cloudflare Tunnel / ngrok) so a teammate anywhere can view it.

Run on the laptop that is connected to the UT-6504-FD converter:

    pip install aiohttp
    python server.py

Then open a public URL with Cloudflare Tunnel (no account needed):

    cloudflared tunnel --url http://localhost:8080

Cloudflared prints a https://<random>.trycloudflare.com link —
share that with your teammate. They open it and see live values.
"""
import asyncio
import socket
import json
import os
from datetime import datetime
from aiohttp import web, WSMsgType

# ── CONFIG ──
HOST       = os.environ.get('CAN_HOST', '192.168.1.125')  # UT-6504-FD converter IP
WEB_PORT   = int(os.environ.get('WEB_PORT', '8080'))      # single port for web + ws
HTML_FILE  = 'CAN_Dashboard_5.html'

MACHINES = {1: 1001, 2: 2001, 3: 3001, 4: 4001}   # machine -> TCP port

CANFD_DLC = {0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,
             9:12,10:16,11:20,12:24,13:32,14:48,15:64}

MACHINE_ADDR = {
    1: {0x01:'MB', 0x02:'FR',       0x03:'BR',        0x04:'CREEL',      0x0A:'AL'},
    2: {0x01:'MB', 0x02:'Cylinder', 0x03:'Beater',    0x04:'Cage',       0x05:'CardFeed',
        0x06:'BeaterFeed', 0x07:'Coiler', 0x08:'AFCylinder', 0x09:'AFFeed'},
    3: {0x01:'MB', 0x02:'Flyer',    0x03:'Bobbin',    0x04:'LeftLift',   0x05:'RightLift',
        0x06:'FrontRoller', 0x07:'BackRoller'},
    4: {0x01:'MB', 0x02:'FR',       0x03:'BR',        0x04:'CREEL'},
}
MACHINE_FN = {
    1: {0x01:'MotorState', 0x02:'Error',    0x07:'RunSetup',   0x09:'RuntimeData',
        0x0A:'Diagnostics', 0x0F:'ACK',     0x1E:'AL_Sensor',  0x1F:'AL_Setup',
        0x20:'ACK',         0x24:'AL_Settings'},
    2: {0x01:'MotorState', 0x02:'Error',    0x03:'DriveCheck', 0x04:'DriveCheckResp',
        0x06:'DataReq',    0x07:'RunSetup', 0x08:'AnalysisData',
        0x09:'RuntimeData', 0x0A:'Diagnostics', 0x0B:'CylExtData',
        0x0D:'ChangeTarget', 0x0F:'ACK',   0x14:'DiagDone', 0x18:'DriveCANChk'},
    3: {0x01:'MotorState', 0x02:'Error',    0x03:'DriveCheck', 0x04:'DriveCheckResp',
        0x05:'SetupCallback', 0x06:'TuningData', 0x07:'RunSetup', 0x08:'AnalysisData',
        0x09:'RuntimeData', 0x0A:'Diagnostics', 0x0C:'LiftRuntime', 0x0D:'ChangeTarget',
        0x0E:'LiftStrokeOver', 0x0F:'ACK',  0x10:'LiftRunSetup', 0x11:'LiftDiagnostics',
        0x13:'HomingDone',  0x14:'DiagDone', 0x15:'LiftNewStroke', 0x16:'LiftSendGB',
        0x17:'LiftGBData',  0x18:'DriveCANChk', 0x1B:'PIDUpdateResp'},
    4: {0x01:'MotorState', 0x02:'Error', 0x07:'RunSetup', 0x09:'RuntimeData'},
}


def decode_id(raw_id):
    b0 = raw_id & 0xFF
    b1 = (raw_id >> 8) & 0xFF
    b2 = (raw_id >> 16) & 0xFF
    b3 = (raw_id >> 24) & 0xFF
    can_id = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    return can_id, (can_id >> 16) & 0xFF, (can_id >> 8) & 0xFF, can_id & 0xFF


async def read_machine(mid, port, ws):
    """Connect to one CAN channel, decode 69-byte frames, push JSON to the websocket."""
    addr_map = MACHINE_ADDR.get(mid, MACHINE_ADDR[1])
    fn_map   = MACHINE_FN.get(mid, MACHINE_FN[1])

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((HOST, port))
        sock.setblocking(False)
        print(f"[M{mid}] connected {HOST}:{port}")
    except Exception as e:
        print(f"[M{mid}] offline ({HOST}:{port}) — {e}")
        try:
            await ws.send_str(json.dumps({'machine': mid, 'event': 'offline'}))
        except Exception:
            pass
        sock.close()
        return

    loop = asyncio.get_event_loop()
    buf = b''
    try:
        while not ws.closed:
            try:
                chunk = await asyncio.wait_for(loop.sock_recv(sock, 8192), timeout=0.05)
                if not chunk:
                    break
                buf += chunk
                while len(buf) >= 69:
                    frame = buf[:69]; buf = buf[69:]
                    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

                    dlc_code = frame[0] & 0x0F
                    nb       = CANFD_DLC.get(dlc_code, 0)
                    raw_id   = int.from_bytes(frame[1:5], 'little')
                    can_id, fn, dst, src = decode_id(raw_id)
                    data     = list(frame[5:5 + nb])
                    data_hex = ' '.join(f'{b:02X}' for b in data)

                    msg = {
                        'machine': mid,
                        'ts': ts,
                        'can_id': f'0x{can_id:08X}',
                        'fn': fn,
                        'fn_name': fn_map.get(fn, f'FN_0x{fn:02X}'),
                        'src': src, 'src_name': addr_map.get(src, f'0x{src:02X}'),
                        'dst': dst, 'dst_name': addr_map.get(dst, f'0x{dst:02X}'),
                        'dlc_code': dlc_code, 'num_bytes': nb,
                        'raw_hex': data_hex, 'data': data,
                    }
                    await ws.send_str(json.dumps(msg))
            except asyncio.TimeoutError:
                await asyncio.sleep(0.02)
            except (ConnectionResetError, OSError):
                break
    except asyncio.CancelledError:
        pass
    finally:
        sock.close()
        print(f"[M{mid}] reader stopped")


async def ws_handler(request):
    """One browser connection -> spawn 4 machine readers feeding it."""
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    peer = request.remote
    print(f"\n[+] Viewer connected from {peer}")

    tasks = [asyncio.create_task(read_machine(mid, port, ws))
             for mid, port in MACHINES.items()]

    try:
        # Keep the connection open; we mostly just wait for it to close.
        async for m in ws:
            if m.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                break
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        print(f"[-] Viewer {peer} disconnected")
    return ws


async def index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{HTML_FILE} not found next to server.py", status=404)
    return web.FileResponse(path)


async def health(request):
    return web.json_response({'status': 'ok', 'device': HOST, 'machines': MACHINES})


def main():
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/ws', ws_handler)
    app.router.add_get('/health', health)

    print("=" * 58)
    print("  Textile CAN Monitor — Web + Live Server")
    print("=" * 58)
    print(f"  Device   : {HOST}  (CAN1-4 on ports {list(MACHINES.values())})")
    print(f"  Local    : http://localhost:{WEB_PORT}")
    print(f"  LAN       : http://<this-laptop-ip>:{WEB_PORT}")
    print(f"  Remote   : run  ->  cloudflared tunnel --url http://localhost:{WEB_PORT}")
    print("=" * 58)
    web.run_app(app, host='0.0.0.0', port=WEB_PORT)


if __name__ == '__main__':
    main()
