# Textile Machine CAN Monitor — Project Overview & Cloud Migration Plan

**Prepared for:** Management review
**Product:** Gen4 Industrial IoT — Live monitoring of textile machinery
**Repository:** https://github.com/Jeeva-Embedded/Machine_log_viewer
**Live system (Phase 1):** https://machine-log-viewer-kcx3.onrender.com

---

## 1. Executive summary

We have built a system that shows **live data from our textile machines** (DrawFrame,
BlowCard, FlyerFrame) in a **web dashboard that can be opened from anywhere** — office,
home, or phone. It also **records every session to downloadable raw + CSV log files**
for analysis.

- **Phase 1 (DONE, live today):** A laptop on the factory network reads the machines
  and streams the data to a free cloud website. Anyone with the link sees live values.
- **Phase 2 (PROPOSED):** Remove the laptop. The CAN-to-Ethernet converter connects
  through the **factory router** and sends data **directly to a cloud server**, so the
  system runs 24×7 with no PC kept switched on.

Both phases are **free of running cost**. Phase 2 needs a free Oracle Cloud account,
which asks for a card **for identity verification only — no charges are applied**.

---

## 2. Background — what we are monitoring

Each machine has an **STM32 motherboard** that talks to its motors over a **CAN FD bus**
(an industrial communication standard used inside machines). The data includes, per motor:

- Target RPM, Present RPM, PWM duty
- MOSFET temperature, Motor temperature
- Current (A), Voltage (V), Power (W)
- Run setup (ramp up / ramp down / set RPM)
- Machine-specific data (DrawFrame: AutoLeveller sensors & settings; FlyerFrame: lift motors)

This CAN data normally never leaves the machine. Our goal is to **capture it, decode it,
display it live, and archive it** — and make it viewable remotely.

---

## 3. The hardware bridge — UT-6504-FD, and why everything is "TCP"

The machine's CAN bus is not directly connected to any network. To get the data out we
use a **UTEK UT-6504-FD**, a **CAN FD → Ethernet converter** (4 CAN channels). It is the
single most important reason the software is built around **TCP**.

### How the UT-6504-FD works
- It listens on the CAN bus and packs **each CAN frame into a fixed 69-byte packet**
  (1 byte frame info + 4 byte CAN ID + 64 byte data) and pushes those bytes over the
  **Ethernet network using a raw TCP socket**.
- Each of its 4 CAN channels maps to its own TCP port (1001, 2001, 3001, 4001).
- It supports two modes:
  - **TCP Server** — the converter waits, and a program connects *to it*. (Phase 1)
  - **TCP Client** — the converter dials *out* to a server we specify. (Phase 2)

### Why TCP and not "a normal website protocol" (HTTP/MQTT)
- The UT-6504-FD **only speaks raw TCP**. It has **no HTTP, no MQTT, no WebSocket**.
  It simply opens a TCP connection and streams the raw CAN bytes. This is standard for
  industrial serial/CAN-to-Ethernet gateways — they are transparent "byte pipes."
- Therefore **any software that reads the converter must use raw TCP sockets** — there
  is no alternative. Our code opens a TCP socket, receives the 69-byte frames, and
  decodes them (reverses the CAN ID, splits the data bytes, applies the scaling factors).
- **Web browsers cannot open raw TCP sockets** (for security, browsers only do HTTP and
  WebSocket). So we always need a small program in the middle that:
  **reads raw TCP from the converter → decodes → forwards to the browser over WebSocket.**

That "middle program" is the core of both phases. The only thing that changes between
Phase 1 and Phase 2 is **where it runs** and **who dials whom**.

---

## 4. Phase 1 — current system (live today)

```
   Browser (office / home / phone)
        |  HTTPS + secure WebSocket
        v
   [ CLOUD: Render ]  ← free hosting
   relay server + dashboard website
        ^
        |  outbound secure WebSocket (the laptop dials UP to the cloud)
   [ FACTORY LAPTOP ]  agent program (Python)
        |  raw TCP  (reads the converter)
   UT-6504-FD  (TCP Server, 192.168.1.125 : 1001-4001)
        |  CAN FD
   Machine motors (STM32)
```

### Components
| Component | Where | Job |
|---|---|---|
| **UT-6504-FD** | Factory | CAN → Ethernet, TCP Server |
| **Agent** (`agent.py`) | Factory laptop | Reads converter over TCP, decodes frames, streams to cloud, saves log files |
| **Relay + Dashboard** (`relay_server.py`) | Render cloud | Hosts the website, broadcasts live data to all viewers |
| **Dashboard** (HTML) | Browser | Shows per-motor cards, charts, temperature gauges, frame log |

### How it works
1. The laptop's agent connects to the converter (raw TCP) and to the cloud (WebSocket).
2. Each CAN frame is decoded and pushed to the cloud, which fans it out to every browser.
3. While a viewer is connected ("Connect Live → Disconnect"), the agent **records the
   session** to `raw .txt` and decoded `.csv` files (with IST timestamps), downloadable
   from the dashboard's **Log Files** tab.

### Status: ✅ Working and deployed. Free of cost (Render free tier needs no card).

### Limitation of Phase 1
- A **laptop/PC must stay switched on** next to the machine and keep the agent running.
  If the laptop sleeps or is taken away, data stops. This is the reason for Phase 2.

---

## 5. Phase 2 — proposed system (no laptop)

We **remove the laptop entirely**. The converter is connected to the **factory router**
and set to **TCP Client** mode, so it **dials out to our cloud server by itself** and
streams the CAN data directly.

```
   Browser (anywhere)
        |  HTTP / WebSocket
        v
   [ CLOUD SERVER (public IP) ]  decodes + hosts dashboard
        ^
        |  raw TCP, OUTBOUND from the factory (through the router/NAT)
   UT-6504-FD  (TCP Client)  ──Ethernet──  ZTE F670L Router  ── Internet ──
        |  CAN FD
   Machine motors (STM32)
```

### What changes vs Phase 1
| | Phase 1 (now) | Phase 2 (proposed) |
|---|---|---|
| Reads the converter | Factory laptop | The converter sends by itself |
| PC kept running | **Yes** | **No** |
| Converter mode | TCP Server | TCP Client (dials out) |
| Cloud host | Render (HTTP only) | A VM with a public IP (raw TCP) |
| Runs 24×7 unattended | No | **Yes** |

### Why the router needs almost no setup
- The converter only makes an **outbound** connection. Outbound traffic passes through
  the router automatically (normal NAT) — **no port forwarding, no static public IP, and
  it even works behind ISP CGNAT.** The router just needs to provide internet, which it
  already does. (Optional: reserve the converter's IP in the router so it stays fixed.)

### Why a different cloud than Render is needed for Phase 2
- The converter speaks **raw TCP**. Render (and similar free no-card hosts) only accept
  **HTTP/HTTPS**, so the converter cannot dial Render directly.
- Phase 2 therefore needs a **cloud VM with a real public IP and an open TCP port** —
  this is what Oracle Cloud's free VM provides. Our Phase-2 server program
  (`tcp_server.py`, already written and tested) listens for the converter, decodes the
  frames, and serves the same dashboard.

---

## 6. Cloud hosting & the credit-card question (Oracle Cloud)

To run a small always-on server with a public IP at **zero cost**, the best option is
**Oracle Cloud "Always Free."**

### What Oracle offers
- **Always Free** resources that **never expire** — including a small virtual machine
  with a public IP, enough to run our server (our data volume is tiny — a few GB/month).
- Plus a **US$300 free credit valid for 30 days** for trying paid services.

### About the credit card
- Oracle (like Google, AWS, and Azure) asks for a **credit/debit card at sign-up for
  identity verification only — to prevent fraud/abuse.**
- **No charges are made for Always Free services.** A small temporary authorization
  (around ₹80 / US$1) may appear to validate the card and is **reversed automatically**.
- The account will **not be billed unless we manually choose to upgrade** to a paid plan.
  Staying on Always Free = **₹0**.

### Why this is safe to proceed
- We will only use **Always Free** resources (one micro VM). We will **not** upgrade to
  paid. The card is purely for verification, exactly as Oracle's own page states:
  *"Build, test, and deploy applications on Oracle Cloud—for free. Get Always Free
  services and a US$300 cloud credit for 30 days."*

---

## 7. Cost summary

| Item | Phase 1 (now) | Phase 2 (proposed) |
|---|---|---|
| Cloud hosting | Render free (no card) — ₹0 | Oracle Always Free — ₹0 |
| Hardware | UT-6504-FD (already owned) + laptop | UT-6504-FD + router (already owned) |
| Running PC | Laptop must stay on | **None** |
| Monthly cost | ₹0 | ₹0 |

Both phases have **no running cost.** Phase 2 additionally **saves a laptop** from being
dedicated to the task.

---

## 8. Security

- Phase 1 cloud link uses **HTTPS/secure WebSocket**. A shared secret token authorizes
  the factory agent to the cloud.
- Phase 2: the converter only **dials out** (no inbound ports opened on the factory side,
  so the factory network is **not exposed**). On the cloud VM, only the required TCP port
  is opened, and access can be restricted to the converter's source IP / a token.
- Currently the dashboard link is open to anyone who has it. A **login/password** can be
  added if required (small, planned enhancement).

---

## 9. Benefits

- **View any machine live from anywhere** (office, home, mobile).
- **Automatic session logging** (raw + decoded CSV) for analysis and record-keeping.
- **Per-motor charts, temperature gauges, settings, and frame log.**
- **Phase 2 = fully unattended 24×7** with no dedicated PC.
- **Zero running cost.**

---

## 10. Roadmap / next steps

1. **Approve Oracle Cloud Always Free account** (card for verification only, no charges).
2. Create one Always-Free VM, open the TCP port, run `tcp_server.py` (already built and
   tested on the `phase2` branch).
3. Reconfigure the UT-6504-FD to **TCP Client** pointing at the VM (via the existing
   router — no port forwarding needed).
4. Decommission the laptop agent; system runs 24×7.
5. (Optional) Add user login, automatic log cleanup, and a permanent custom URL.

---

*Document maintained alongside the project source. Phase-2 server code (`tcp_server.py`)
is committed on the `phase2` branch and has been tested end-to-end with a simulated
converter.*
