"""Phase 2 test: mock UT-6504-FD in TCP-CLIENT mode — dials the server and streams frames."""
import socket, time, math, sys

HOST = '127.0.0.1'
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9001

def build_frame(fn, dst, src, data):
    can_id = (0x0E << 24) | (fn << 16) | (dst << 8) | src
    b0=can_id&0xFF; b1=(can_id>>8)&0xFF; b2=(can_id>>16)&0xFF; b3=(can_id>>24)&0xFF
    raw_id = (b0<<24)|(b1<<16)|(b2<<8)|b3
    frame = bytes([9]) + raw_id.to_bytes(4,'little')   # DLC code 9 = 12 bytes
    return frame + bytes(data) + bytes(64-len(data))

s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.connect((HOST, PORT))   # dial IN, like a TCP client
print(f"Mock converter dialed server {HOST}:{PORT}")
t = 0
try:
    while True:
        prpm = int(480 + 40*math.sin(t/5.0)); curr = int(1500 + 200*math.sin(t/3.0))
        d = [500>>8,500&0xFF, prpm>>8,prpm&0xFF, 0x01,0x2C, 42,38, curr>>8,curr&0xFF, 0x05,0x78]
        s.sendall(build_frame(0x09,0x01,0x02,d))   # FR runtime
        s.sendall(build_frame(0x09,0x01,0x03,d))   # BR runtime
        t += 1; time.sleep(0.25)
except (BrokenPipeError, ConnectionResetError, KeyboardInterrupt):
    pass
finally:
    s.close()
