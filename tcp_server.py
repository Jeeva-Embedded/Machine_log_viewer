"""
Textile CAN Monitor — PHASE 2 SERVER  (converter dials IN, no laptop)
=====================================================================
Runs on a cloud VM with a PUBLIC IP (e.g. Oracle Cloud Always Free).
The UT-6504-FD is set to *TCP Client* mode and dials OUT to this server,
streaming raw 69-byte CAN-FD frames. This server decodes them and serves
the dashboard + live WebSocket to browsers — all in one process, no laptop.

  Raw TCP IN  : one listen port per CAN channel (9001-9004 -> machine 1-4)
  GET /       : dashboard (CAN_Dashboard_5.html)
  WS  /ws     : browsers receive decoded live frames
  GET /health : status

Phase 1 (main branch: agent.py + relay_server.py) is unaffected — this is a
separate entry point on the `phase2` branch for the converter-dials-in model.

Converter config (per CAN channel):
  Network mode = TCP Client
  Remote server address = <this VM public IP>
  Remote port = 9001 (CAN1) / 9002 (CAN2) / 9003 (CAN3) / 9004 (CAN4)
  Gateway = your router IP   Packing = Fixed format (69 bytes)

Run:
  pip install aiohttp
  python tcp_server.py
"""
import asyncio
import json
import os
from datetime import datetime
from aiohttp import web, WSMsgType

WEB_PORT  = int(os.environ.get('PORT', '8080'))
HTML_FILE = 'CAN_Dashboard_5.html'
# listen TCP port -> machine id  (override with env, e.g. TCP_PORTS="9001:1,9002:2")
TCP_PORTS = {9001: 1, 9002: 2, 9003: 3, 9004: 4}

CANFD_DLC = {0:0,1:1,2:2,3:3,4:4,5:5,6:6,7:7,8:8,
             9:12,10:16,11:20,12:24,13:32,14:48,15:64}

MACHINE_ADDR = {
    1: {0x01:'MB', 0x02:'FR',       0x03:'BR',        0x04:'CREEL',      0x0A:'AL'},
    2: {0x01:'MB', 0x02:'Cylinder', 0x03:'Beater',    0x04:'Cage',       0x05:'CardFeed',
        0x06:'BeaterFeed', 0x07:'Coiler', 0x08:'PickerCyl', 0x09:'AFFeed'},
    3: {0x01:'MB', 0x02:'Flyer',    0x03:'Bobbin',    0x04:'LeftLift',   0x05:'RightLift',
        0x06:'FrontRoller', 0x07:'BackRoller'},
    4: {0x01:'MB', 0x02:'FR',       0x03:'BR',        0x04:'CREEL'},
}
MACHINE_FN = {
    1: {0x01:'MotorState',0x02:'Error',0x07:'RunSetup',0x09:'RuntimeData',0x0A:'Diagnostics',
        0x0F:'ACK',0x1E:'AL_Sensor',0x1F:'AL_Setup',0x20:'ACK',0x24:'AL_Settings'},
    2: {0x01:'MotorState',0x02:'Error',0x03:'DriveCheck',0x04:'DriveCheckResp',0x06:'DataReq',
        0x07:'RunSetup',0x08:'AnalysisData',0x09:'RuntimeData',0x0A:'Diagnostics',0x0B:'CylExtData',
        0x0D:'ChangeTarget',0x0F:'ACK',0x14:'DiagDone',0x18:'DriveCANChk'},
    3: {0x01:'MotorState',0x02:'Error',0x03:'DriveCheck',0x04:'DriveCheckResp',0x05:'SetupCallback',
        0x06:'TuningData',0x07:'RunSetup',0x08:'AnalysisData',0x09:'RuntimeData',0x0A:'Diagnostics',
        0x0C:'LiftRuntime',0x0D:'ChangeTarget',0x0E:'LiftStrokeOver',0x0F:'ACK',0x10:'LiftRunSetup',
        0x11:'LiftDiagnostics',0x13:'HomingDone',0x14:'DiagDone',0x15:'LiftNewStroke',0x16:'LiftSendGB',
        0x17:'LiftGBData',0x18:'DriveCANChk',0x1B:'PIDUpdateResp'},
    4: {0x01:'MotorState',0x02:'Error',0x07:'RunSetup',0x09:'RuntimeData'},
}

viewers = set()
last_by_key = {}   # machine -> last JSON frame (snapshot for new viewers)


def decode_id(raw_id):
    b0 = raw_id & 0xFF; b1 = (raw_id >> 8) & 0xFF
    b2 = (raw_id >> 16) & 0xFF; b3 = (raw_id >> 24) & 0xFF
    can_id = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    return can_id, (can_id >> 16) & 0xFF, (can_id >> 8) & 0xFF, can_id & 0xFF


def decode_frame(mid, frame):
    addr_map = MACHINE_ADDR.get(mid, MACHINE_ADDR[1])
    fn_map   = MACHINE_FN.get(mid, MACHINE_FN[1])
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    dlc_code = frame[0] & 0x0F
    nb = CANFD_DLC.get(dlc_code, 0)
    raw_id = int.from_bytes(frame[1:5], 'little')
    can_id, fn, dst, src = decode_id(raw_id)
    data = list(frame[5:5 + nb])
    return {
        'machine': mid, 'ts': ts, 'can_id': f'0x{can_id:08X}',
        'fn': fn, 'fn_name': fn_map.get(fn, f'FN_0x{fn:02X}'),
        'src': src, 'src_name': addr_map.get(src, f'0x{src:02X}'),
        'dst': dst, 'dst_name': addr_map.get(dst, f'0x{dst:02X}'),
        'dlc_code': dlc_code, 'num_bytes': nb,
        'raw_hex': ' '.join(f'{b:02X}' for b in data), 'data': data,
    }


async def broadcast(data):
    dead = []
    for v in viewers:
        try:
            await v.send_str(data)
        except Exception:
            dead.append(v)
    for d in dead:
        viewers.discard(d)


async def handle_converter(reader, writer, mid):
    peer = writer.get_extra_info('peername')
    print(f"[M{mid}] converter connected from {peer}")
    buf = b''
    try:
        while True:
            chunk = await reader.read(8192)
            if not chunk:
                break
            buf += chunk
            while len(buf) >= 69:
                frame = buf[:69]; buf = buf[69:]
                data = json.dumps(decode_frame(mid, frame))
                last_by_key[mid] = data
                await broadcast(data)
    except Exception as e:
        print(f"[M{mid}] error: {e}")
    finally:
        writer.close()
        print(f"[M{mid}] converter disconnected")


async def index(request):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), HTML_FILE)
    if not os.path.exists(path):
        return web.Response(text=f"{HTML_FILE} not found", status=404)
    return web.FileResponse(path)


async def health(request):
    return web.json_response({'status': 'ok', 'viewers': len(viewers),
                              'machines_streaming': sorted(last_by_key.keys())})


async def view_handler(request):
    ws = web.WebSocketResponse(heartbeat=30, max_msg_size=0)
    await ws.prepare(request)
    viewers.add(ws)
    print(f"[+] Viewer connected ({len(viewers)})")
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
        print(f"[-] Viewer left ({len(viewers)})")
    return ws


async def main():
    # raw TCP listeners (converter dials in)
    for port, mid in TCP_PORTS.items():
        srv = await asyncio.start_server(
            lambda r, w, m=mid: handle_converter(r, w, m), '0.0.0.0', port)
        print(f"  TCP listen :{port}  -> Machine {mid}")
    # web + websocket
    app = web.Application()
    app.router.add_get('/', index)
    app.router.add_get('/health', health)
    app.router.add_get('/ws', view_handler)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', WEB_PORT)
    await site.start()
    print(f"  Web/WS     :{WEB_PORT}  -> http://<this-vm-public-ip>:{WEB_PORT}")
    print("Ready. Point the converter (TCP Client) at this VM's public IP + ports above.")
    await asyncio.Future()  # run forever


if __name__ == '__main__':
    print("=" * 58)
    print("  Textile CAN Monitor — PHASE 2 (converter dials in)")
    print("=" * 58)
    asyncio.run(main())
