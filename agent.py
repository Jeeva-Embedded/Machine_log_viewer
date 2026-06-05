"""
Textile CAN Monitor — LAPTOP AGENT  (runs on the laptop wired to the converter)
================================================================================
The laptop half of "Option A". It:
  1. reads the UT-6504-FD CAN channels (TCP 1001-4001 on the factory LAN)
  2. decodes each 69-byte frame to JSON
  3. dials OUT to the Render relay (wss://.../feed) and pushes the frames up

No browser and no inbound ports needed on the laptop — it only uploads.

SET THESE TWO before running (edit below or use environment variables):
    RELAY_URL  = wss://YOUR-APP.onrender.com/feed
    FEED_TOKEN = the same secret you set in Render -> Environment

Run:
    pip install aiohttp
    python agent.py
"""
import asyncio
import socket
import json
import os
from datetime import datetime
import aiohttp

# ── EDIT THESE (or set as environment variables) ──
RELAY_URL  = os.environ.get('RELAY_URL',  'wss://YOUR-APP.onrender.com/feed')
FEED_TOKEN = os.environ.get('FEED_TOKEN', 'change-me-please')
HOST       = os.environ.get('CAN_HOST',   '192.168.1.125')   # converter IP on LAN

MACHINES = {1: 1001, 2: 2001, 3: 3001, 4: 4001}

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


async def read_machine(mid, port, relay):
    """Connect to one CAN channel, decode, push JSON up to the relay."""
    addr_map = MACHINE_ADDR.get(mid, MACHINE_ADDR[1])
    fn_map   = MACHINE_FN.get(mid, MACHINE_FN[1])

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.connect((HOST, port))
        sock.setblocking(False)
        print(f"[M{mid}] reading {HOST}:{port}")
    except Exception as e:
        print(f"[M{mid}] offline ({HOST}:{port}) — {e}")
        try:
            await relay.send_str(json.dumps({'machine': mid, 'event': 'offline'}))
        except Exception:
            pass
        sock.close()
        return

    loop = asyncio.get_event_loop()
    buf = b''
    try:
        while not relay.closed:
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
                        'machine': mid, 'ts': ts, 'can_id': f'0x{can_id:08X}',
                        'fn': fn, 'fn_name': fn_map.get(fn, f'FN_0x{fn:02X}'),
                        'src': src, 'src_name': addr_map.get(src, f'0x{src:02X}'),
                        'dst': dst, 'dst_name': addr_map.get(dst, f'0x{dst:02X}'),
                        'dlc_code': dlc_code, 'num_bytes': nb,
                        'raw_hex': data_hex, 'data': data,
                    }
                    await relay.send_str(json.dumps(msg))
            except asyncio.TimeoutError:
                await asyncio.sleep(0.02)
            except (ConnectionResetError, OSError):
                break
    except asyncio.CancelledError:
        pass
    finally:
        sock.close()
        print(f"[M{mid}] stopped")


async def run():
    url = f"{RELAY_URL}?token={FEED_TOKEN}"
    print("=" * 58)
    print("  Textile CAN Monitor — Laptop Agent")
    print("=" * 58)
    print(f"  Converter : {HOST}  (ports {list(MACHINES.values())})")
    print(f"  Relay     : {RELAY_URL}")
    print("=" * 58)
    while True:  # reconnect forever
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(url, heartbeat=20, max_msg_size=0) as relay:
                    print("[+] Connected to relay — streaming...")
                    tasks = [asyncio.create_task(read_machine(mid, port, relay))
                             for mid, port in MACHINES.items()]
                    await asyncio.gather(*tasks, return_exceptions=True)
            print("[-] Relay closed — reconnecting in 5s")
        except Exception as e:
            print(f"[!] Relay connection failed: {e} — retry in 5s")
        await asyncio.sleep(5)


if __name__ == '__main__':
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nAgent stopped.")
