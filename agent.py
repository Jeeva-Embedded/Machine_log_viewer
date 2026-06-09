"""
Textile CAN Monitor — LAPTOP AGENT  (runs on the laptop wired to the converter)
================================================================================
1. reads the UT-6504-FD CAN channels (TCP 1001-4001 on the factory LAN)
2. decodes each 69-byte frame to JSON and pushes it UP to the Render relay
3. SAVES per-machine, per-date raw .txt + decoded .csv files into ./logs
4. answers file-list / file-download requests from the relay, so the website
   sidebar can list and download any past log from anywhere.

SET in START_AGENT.bat (or env):
    RELAY_URL  = wss://machine-log-viewer.onrender.com/feed
    FEED_TOKEN = the same secret you set in Render -> Environment

Run:
    pip install aiohttp
    python agent.py
"""
import asyncio
import socket
import json
import os
import base64
from datetime import datetime, timezone, timedelta
import aiohttp

# Always log in IST (UTC+5:30), regardless of where the agent/VPS runs
IST = timezone(timedelta(hours=5, minutes=30))
def now_ist():
    return datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]   # full date+time+ms, IST

RELAY_URL  = os.environ.get('RELAY_URL',  'wss://machine-log-viewer-kcx3.onrender.com/feed')
FEED_TOKEN = os.environ.get('FEED_TOKEN', 'change-me-please')
HOST       = os.environ.get('CAN_HOST',   '192.168.1.125')
LOG_DIR    = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs')
# Google Drive auto-upload (via rclone). Empty DRIVE_FOLDER_ID = disabled.
RCLONE          = os.environ.get('RCLONE', 'rclone')
DRIVE_FOLDER_ID = os.environ.get('DRIVE_FOLDER_ID', '')
UPLOAD_EVERY    = int(os.environ.get('UPLOAD_EVERY', '600'))   # secs between Drive syncs of the day's open files
# a folder set from the website is persisted here and overrides the env value
_DRIVE_CFG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'drive_folder.txt')
try:
    if os.path.exists(_DRIVE_CFG):
        _saved = open(_DRIVE_CFG, encoding='utf-8').read().strip()
        if _saved:
            DRIVE_FOLDER_ID = _saved
except Exception:
    pass

def set_drive_folder(fid):
    """Update + persist the Google Drive target folder (called from the website)."""
    global DRIVE_FOLDER_ID
    DRIVE_FOLDER_ID = (fid or '').strip()
    try:
        open(_DRIVE_CFG, 'w', encoding='utf-8').write(DRIVE_FOLDER_ID)
    except Exception:
        pass
    print(f"[DRIVE] target folder set to: {DRIVE_FOLDER_ID or '(none)'}")

MACHINES = {1: 1001, 2: 2001, 3: 3001, 4: 4001}
MACHINE_NAME = {1: 'DrawFrame', 2: 'BlowCard', 3: 'FlyerFrame', 4: 'RingFrame'}

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
CURR_GAIN = 0.00672
VOLT_GAIN = 0.017

# ── Spec-driven decode config (from the website admin / CAN Communication Plan) ──
# When a config is present it OVERRIDES the hardcoded MACHINE_ADDR / MACHINE_FN name
# maps, so the uploaded Excel becomes the single source of truth for addresses and
# function names. The numeric byte decoding in csv_row() is unchanged (it keys off
# stable function IDs). The config is persisted here on the laptop (durable) and
# re-sent to the relay on connect, so it survives Render redeploys (Render's disk is
# ephemeral). Flow: website Save -> relay -> agent (persist + apply); agent connect
# -> sends config up so the relay can serve it again after a redeploy.
_CAN_CFG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'can_config.json')
CAN_CONFIG = None      # raw dict as saved by the admin (None = use hardcoded maps)
_cfg_addr = {}         # {mid:int -> {addr:int -> name}}
_cfg_fn = {}           # {fn:int -> name}  (global, from "All FunctionIDs")

def _to_int(h):
    try:
        return int(str(h).strip().lower().replace('0x', ''), 16)
    except (ValueError, AttributeError):
        return None

def apply_can_config(cfg):
    """Rebuild the addr/fn override maps from a parsed config dict."""
    global CAN_CONFIG, _cfg_addr, _cfg_fn
    if not isinstance(cfg, dict):
        return
    fn = {}
    for f in cfg.get('function_ids', []):
        i = _to_int(f.get('id'))
        if i is not None and f.get('name'):
            fn[i] = f['name']
    addr = {}
    for mid_s, mc in (cfg.get('machines') or {}).items():
        try:
            mid = int(mid_s)
        except (ValueError, TypeError):
            continue
        m = {}
        # frames first (gives Motherboard 0x01 etc.), identifiers override (authoritative)
        for fr in mc.get('frames', []):
            for a_key, n_key in (('src_addr', 'src'), ('dst_addr', 'dst')):
                a = _to_int(fr.get(a_key))
                if a is not None and fr.get(n_key):
                    m.setdefault(a, fr[n_key])
        for it in mc.get('identifiers', []):
            a = _to_int(it.get('addr'))
            if a is not None and it.get('name'):
                m[a] = it['name']
        addr[mid] = m
    CAN_CONFIG, _cfg_addr, _cfg_fn = cfg, addr, fn
    print(f"[CFG] decode config applied: {len(fn)} function ids, machines {sorted(addr)}")

def save_can_config(cfg):
    """Apply + persist a config received from the website (via the relay)."""
    apply_can_config(cfg)
    try:
        with open(_CAN_CFG_FILE, 'w', encoding='utf-8') as f:
            json.dump(cfg, f, ensure_ascii=False)
        print(f"[CFG] saved to {_CAN_CFG_FILE}")
    except Exception as e:
        print(f"[CFG] save failed: {e}")

def load_can_config():
    if os.path.exists(_CAN_CFG_FILE):
        try:
            with open(_CAN_CFG_FILE, encoding='utf-8') as f:
                apply_can_config(json.load(f))
        except Exception as e:
            print(f"[CFG] load failed: {e}")

def addr_name(mid, addr):
    m = _cfg_addr.get(mid)
    if m and addr in m:
        return m[addr]
    return MACHINE_ADDR.get(mid, MACHINE_ADDR[1]).get(addr, f'0x{addr:02X}')

def fn_name(mid, fn):
    if _cfg_fn and fn in _cfg_fn:
        return _cfg_fn[fn]
    return MACHINE_FN.get(mid, MACHINE_FN[1]).get(fn, f'FN_0x{fn:02X}')

CSV_HEADER = ("Timestamp,Millis,Machine,CAN_ID,FunctionID,FunctionName,Source_Addr,Source_Board,"
    "Dest_Addr,Dest_Board,DLC_Code,Bytes,Raw_Data,"
    "TargetRPM,PresentRPM,PWM,MosfetTemp_C,MotorTemp_C,CurrentADC,CurrentA,VoltageADC,VoltageV,Power_W,"
    "Command,ACK,RUT_RampUpTime_s,RDT_RampDownTime_s,Motor_RPM,Draft,Delivery_mMin,"
    "AL_Kp,AL_Sliver_N1,AL_Sliver_N,AL_Sliver_Nm1,AL_Target_gm,AL_Counter,AL_ScanningSensor,"
    "AL_CoilerSensor,ErrorCode\n")

CMD_MAP = {1:'EmergencyStop',2:'Start',3:'RampDownStop',4:'ChangeRPM',
           5:'Homing',6:'Resume',7:'Reset',8:'AckPresence'}


def decode_id(raw_id):
    b0 = raw_id & 0xFF; b1 = (raw_id >> 8) & 0xFF
    b2 = (raw_id >> 16) & 0xFF; b3 = (raw_id >> 24) & 0xFF
    can_id = (b0 << 24) | (b1 << 16) | (b2 << 8) | b3
    return can_id, (can_id >> 16) & 0xFF, (can_id >> 8) & 0xFF, can_id & 0xFF


def csv_row(mid, ts, can_id, fn, fn_n, src, src_n, dst, dst_n, dlc, nb, data_hex, data):
    # 39 columns — Timestamp (no ms, Excel-friendly) + Millis column + all decoded fields
    ms = ts.split('.')[1] if '.' in ts else ''
    ts = ts.split('.')[0]
    c = [ts, ms, f'M{mid}', f'0x{can_id:08X}', f'0x{fn:02X}', fn_n,
         f'0x{src:02X}', src_n, f'0x{dst:02X}', dst_n, str(dlc), str(nb), data_hex] + [''] * 26
    if fn == 0x09 and len(data) >= 12:                 # Runtime Data
        curr = (data[8] << 8) | data[9]; volt = (data[10] << 8) | data[11]
        ca = curr * CURR_GAIN; vv = volt * VOLT_GAIN
        c[13] = str((data[0] << 8) | data[1]); c[14] = str((data[2] << 8) | data[3])
        c[15] = str((data[4] << 8) | data[5]); c[16] = str(data[6]); c[17] = str(data[7])
        c[18] = str(curr); c[19] = f'{ca:.4f}'; c[20] = str(volt); c[21] = f'{vv:.3f}'; c[22] = f'{ca*vv:.3f}'
    elif fn == 0x01 and len(data) >= 1:                 # Motor State (command)
        c[23] = CMD_MAP.get(data[0], f'0x{data[0]:02X}')
    elif fn in (0x0F, 0x20) and len(data) >= 1:         # ACK
        c[24] = 'OK' if data[0] == 1 else f'0x{data[0]:02X}'
    elif fn == 0x07 and len(data) >= 4:                 # Run Setup
        c[25] = str(data[0]); c[26] = str(data[1]); c[27] = str((data[2] << 8) | data[3])
    elif fn == 0x1F and len(data) >= 4:                 # AL Setup (draft/delivery)
        c[28] = f'{((data[0] << 8) | data[1]) / 100:.2f}'; c[29] = str((data[2] << 8) | data[3])
    elif fn == 0x24 and len(data) >= 10:                # AL Settings
        c[30] = f'{((data[0] << 8) | data[1]) / 1000:.4f}'
        c[31] = str((data[2] << 8) | data[3]); c[32] = str((data[4] << 8) | data[5])
        c[33] = str((data[6] << 8) | data[7]); c[34] = f'{((data[8] << 8) | data[9]) / 100:.2f}'
    elif fn == 0x1E and len(data) >= 5:                 # AL Sensor
        c[35] = str(data[0]); c[36] = str((data[1] << 8) | data[2]); c[37] = str((data[3] << 8) | data[4])
    elif fn == 0x02 and len(data) >= 2:                 # Error
        c[38] = f'0x{((data[0] << 8) | data[1]):04X}'
    return ','.join(c)


# ── ALWAYS-ON logging: per-machine, per-DAY raw+csv files ──────────────────────
# Logging runs whenever the agent is connected to the converter — no browser needed.
# Each machine appends to a daily file; at midnight (IST) the file rolls over and the
# finished day is pushed to Drive. Connect/Disconnect on the website now only controls
# the LIVE VIEW, not logging. The day's open files are also synced to Drive every
# UPLOAD_EVERY seconds (see drive_sync_loop) so the cloud copy stays fresh.
_logfiles = {}      # (mid, kind) -> {'day':'YYYY-MM-DD', 'fh':file, 'path':str}

def _today_ist():
    return datetime.now(IST).strftime('%Y-%m-%d')

def _log_write(mid, kind, line, header=None):
    today = _today_ist()
    key = (mid, kind)
    cur = _logfiles.get(key)
    if cur is None or cur['day'] != today:
        if cur:                       # day rolled over -> close + upload the finished file
            try: cur['fh'].close()
            except Exception: pass
            asyncio.create_task(upload_to_drive([cur['path']]))
        ext = 'txt' if kind == 'raw' else 'csv'
        path = os.path.join(LOG_DIR, f"M{mid}_{MACHINE_NAME.get(mid,mid)}_{today}_{kind}.{ext}")
        new = not os.path.exists(path)
        fh = open(path, 'a', encoding='utf-8')
        if new and header:
            fh.write(header)
        _logfiles[key] = {'day': today, 'fh': fh, 'path': path}
        cur = _logfiles[key]
    cur['fh'].write(line)
    cur['fh'].flush()

def open_log_paths():
    return list({e['path'] for e in _logfiles.values()})

async def upload_to_drive(paths):
    """Upload (overwrite) the given log files to the Google Drive folder via rclone."""
    if not DRIVE_FOLDER_ID or not paths:
        return
    dest = f"gdrive,root_folder_id={DRIVE_FOLDER_ID}:"
    for p in paths:
        try:
            proc = await asyncio.create_subprocess_exec(
                RCLONE, 'copyto', p, dest + os.path.basename(p),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
            _, err = await proc.communicate()
            if proc.returncode == 0:
                print(f"[DRIVE] uploaded {os.path.basename(p)}")
            else:
                print(f"[DRIVE] upload failed {os.path.basename(p)}: {(err or b'').decode(errors='ignore')[:150]}")
        except FileNotFoundError:
            print(f"[DRIVE] rclone not found at '{RCLONE}' — set RCLONE path"); return
        except Exception as e:
            print(f"[DRIVE] error: {e}")


async def drive_sync_loop():
    """Every UPLOAD_EVERY seconds, push the day's open log files (changed ones) to Drive."""
    last = {}     # path -> last-uploaded mtime
    while True:
        await asyncio.sleep(UPLOAD_EVERY)
        changed = []
        for p in open_log_paths():
            try:
                m = os.path.getmtime(p)
            except OSError:
                continue
            if last.get(p) != m:
                changed.append(p)
                last[p] = m
        if changed:
            await upload_to_drive(changed)


async def read_machine(mid, port, relay):
    # name maps are looked up per-frame via addr_name()/fn_name() so a config
    # pushed from the website takes effect live, without restarting the agent.
    loop = asyncio.get_event_loop()
    # Keep trying to (re)connect to the converter for as long as the relay is up,
    # so a temporary converter hiccup (or stale socket) doesn't stop a machine forever.
    while not relay.closed:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setblocking(False)   # non-blocking connect so an offline converter can't freeze the loop
        try:
            await asyncio.wait_for(loop.sock_connect(sock, (HOST, port)), timeout=5)
            print(f"[M{mid}] reading {HOST}:{port}")
        except Exception as e:
            print(f"[M{mid}] offline ({HOST}:{port}) — {e}; retry in 5s")
            try: await relay.send_str(json.dumps({'machine': mid, 'event': 'offline'}))
            except Exception: pass
            sock.close()
            await asyncio.sleep(5)
            continue
        buf = b''
        try:
            while not relay.closed:
                try:
                    chunk = await asyncio.wait_for(loop.sock_recv(sock, 8192), timeout=0.05)
                    if not chunk: break
                    buf += chunk
                    while len(buf) >= 69:
                        frame = buf[:69]; buf = buf[69:]
                        ts = now_ist()
                        dlc_code = frame[0] & 0x0F
                        nb = CANFD_DLC.get(dlc_code, 0)
                        raw_id = int.from_bytes(frame[1:5], 'little')
                        can_id, fn, dst, src = decode_id(raw_id)
                        data = list(frame[5:5 + nb])
                        data_hex = ' '.join(f'{b:02X}' for b in data)
                        fn_n  = fn_name(mid, fn)
                        src_n = addr_name(mid, src)
                        dst_n = addr_name(mid, dst)
                        # 1) push live to relay
                        msg = {'machine': mid, 'ts': ts, 'can_id': f'0x{can_id:08X}',
                               'fn': fn, 'fn_name': fn_n, 'src': src, 'src_name': src_n,
                               'dst': dst, 'dst_name': dst_n, 'dlc_code': dlc_code,
                               'num_bytes': nb, 'raw_hex': data_hex, 'data': data}
                        try: await relay.send_str(json.dumps(msg))
                        except Exception: pass
                        # 2) save to disk
                        _log_write(mid, 'raw',
                                   f"{ts} | 0x{can_id:08X} | FN:0x{fn:02X} SRC:0x{src:02X} DST:0x{dst:02X} | "
                                   f"DLC_code:{dlc_code} Bytes:{nb} | {data_hex}\n")
                        _log_write(mid, 'decoded',
                                   csv_row(mid, ts, can_id, fn, fn_n, src, src_n, dst, dst_n,
                                           dlc_code, nb, data_hex, data) + '\n',
                                   header=CSV_HEADER)
                except asyncio.TimeoutError:
                    await asyncio.sleep(0.02)
                except (ConnectionResetError, OSError):
                    break
        except asyncio.CancelledError:
            sock.close(); return
        finally:
            sock.close()
        # converter dropped the connection — reconnect (recording is viewer-driven, not link-driven)
        if not relay.closed:
            print(f"[M{mid}] converter link dropped — reconnecting in 3s")
            await asyncio.sleep(3)


def build_manifest():
    files = []
    if os.path.isdir(LOG_DIR):
        for fn in sorted(os.listdir(LOG_DIR)):
            full = os.path.join(LOG_DIR, fn)
            if not os.path.isfile(full):
                continue
            # M{mid}_{Name}_{date}_{kind}.{ext}
            try:
                parts = fn.rsplit('_', 2)        # [M1_DrawFrame, 2026-06-05, raw.txt]
                date = parts[1]
                kind = parts[2].split('.')[0]
                mid  = int(parts[0].split('_')[0][1:])
            except Exception:
                continue
            files.append({'name': fn, 'machine': mid,
                          'machine_name': MACHINE_NAME.get(mid, f'M{mid}'),
                          'date': date, 'kind': kind,
                          'size': os.path.getsize(full)})
    return files


async def manifest_loop(relay):
    while not relay.closed:
        try:
            await relay.send_str(json.dumps({'type': 'manifest', 'files': build_manifest()}))
        except Exception:
            break
        await asyncio.sleep(8)


async def send_file(relay, req_id, name):
    # security: only files inside LOG_DIR, no path traversal
    safe = os.path.basename(name)
    path = os.path.join(LOG_DIR, safe)
    if not os.path.isfile(path):
        await relay.send_str(json.dumps({'type': 'file_error', 'req_id': req_id, 'msg': 'not found'}))
        return
    try:
        with open(path, 'rb') as f:
            seq = 0
            while True:
                chunk = f.read(196608)  # 192 KB
                if not chunk:
                    break
                await relay.send_str(json.dumps({'type': 'file_chunk', 'req_id': req_id,
                                                 'seq': seq, 'b64': base64.b64encode(chunk).decode()}))
                seq += 1
        await relay.send_str(json.dumps({'type': 'file_end', 'req_id': req_id, 'name': safe}))
    except Exception as e:
        await relay.send_str(json.dumps({'type': 'file_error', 'req_id': req_id, 'msg': str(e)}))


async def recv_control(relay):
    async for m in relay:
        if m.type == aiohttp.WSMsgType.TEXT:
            try:
                j = json.loads(m.data)
            except Exception:
                continue
            t = j.get('type')
            if t == 'get_file':
                await send_file(relay, j.get('req_id'), j.get('name', ''))
            elif t == 'set_drive_folder':
                set_drive_folder(j.get('folder_id', ''))
            elif t == 'set_can_config':
                save_can_config(j.get('config'))
            # record_start / record_stop from the relay are ignored — logging is always-on now
        elif m.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
            break


async def run():
    os.makedirs(LOG_DIR, exist_ok=True)
    load_can_config()
    url = f"{RELAY_URL}?token={FEED_TOKEN}"
    print("=" * 58)
    print("  Textile CAN Monitor — Laptop Agent")
    print("=" * 58)
    print(f"  Converter : {HOST}  (ports {list(MACHINES.values())})")
    print(f"  Relay     : {RELAY_URL}")
    print(f"  Logs      : {LOG_DIR}")
    print("=" * 58)
    asyncio.create_task(drive_sync_loop())   # always-on Drive backup, independent of the relay
    while True:
        try:
            async with aiohttp.ClientSession() as s:
                async with s.ws_connect(url, heartbeat=20, max_msg_size=0) as relay:
                    print("[+] Connected to relay — streaming + logging...")
                    # seed the relay with our config so it survives Render redeploys
                    if CAN_CONFIG is not None:
                        try:
                            await relay.send_str(json.dumps({'type': 'can_config', 'config': CAN_CONFIG}))
                        except Exception:
                            pass
                    tasks = [asyncio.create_task(read_machine(mid, port, relay))
                             for mid, port in MACHINES.items()]
                    tasks.append(asyncio.create_task(recv_control(relay)))
                    tasks.append(asyncio.create_task(manifest_loop(relay)))
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
