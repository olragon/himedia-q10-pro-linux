#!/usr/bin/env python3
"""cec-reg-probe.py - ON THE BOX: drive the CEC CPI registers directly through /dev/mem and print a
microsecond timeline of every change of INT_STATUS_0/1, RX_COUNT and the bus level.  For bring-up of
patch 0019 only (the driver's poll worker keeps running and clears the statuses; the timeline still shows
the transitions because this loop samples every ~100 us).

  cec-reg-probe.py tx <initiator> <dest> [opcode [operand ...]]   (hex; no opcode = poll)
  cec-reg-probe.py watch [seconds]                                 only observe (press a TV remote key)
  cec-reg-probe.py dump                                            all of page 0xf 0x80..0xff
"""
import mmap, os, struct, sys, time

BASE = 0xF8CE3000          # page-aligned; page 0xf register r is at +0xC00 + 4*r
fd = os.open("/dev/mem", os.O_RDWR | os.O_SYNC)
m = mmap.mmap(fd, 0x1000, mmap.MAP_SHARED, mmap.PROT_READ | mmap.PROT_WRITE, offset=BASE)
def r(reg): return struct.unpack_from("<I", m, 0xC00 + 4 * reg)[0] & 0xFF
def w(reg, v): struct.pack_into("<I", m, 0xC00 + 4 * reg, v & 0xFF)

def timeline(seconds):
    t0 = time.perf_counter(); last = None
    while time.perf_counter() - t0 < seconds:
        cur = (r(0xA6), r(0xA7), r(0xAD))
        if cur != last:
            print("%9.3f ms  st0=%02x st1=%02x rx_count=%02x" % ((time.perf_counter() - t0) * 1e3, *cur), flush=True)
            last = cur

cmd = sys.argv[1] if len(sys.argv) > 1 else "dump"
if cmd == "dump":
    for i in range(0x80, 0x100):
        print("%02x=%02x" % (i, r(i)), end="  " if (i + 1) % 8 else "\n")
elif cmd == "watch":
    timeline(float(sys.argv[2]) if len(sys.argv) > 2 else 20)
elif cmd == "tx":
    a = [int(x, 16) for x in sys.argv[2:]]
    init, dest, rest = a[0], a[1], a[2:]
    w(0x88, init)
    t0 = time.perf_counter()
    if not rest:
        w(0x89, 0x80 | dest)
    else:
        w(0x89, dest); w(0x8F, rest[0])
        for i, b in enumerate(rest[1:]): w(0x90 + i, b)
        w(0x9F, 0x10 | (len(rest) - 1))
    print("sent in %.3f ms" % ((time.perf_counter() - t0) * 1e3))
    timeline(0.4)
