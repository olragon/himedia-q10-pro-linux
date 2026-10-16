#!/usr/bin/env python3
"""Disassemble a virtual-address range of the decompressed stock Q10 Pro kernel (3.18.24, ARM,
virtual base 0xc0008000) with llvm-objdump, relabel offsets as virtual addresses, and annotate
literal-pool words that point at C strings or at named symbols.

usage: stock-dis.py <vmlinux.bin> <start-vaddr-hex> <len-hex>
needs: llvm-objdump + llvm-objcopy (brew llvm), scripts/himedia/stock-kallsyms.py beside it.
Output addresses are VIRTUAL. Read-only; writes only a temp ELF wrapper in a mkdtemp dir.
"""
import bisect, os, re, subprocess, sys, tempfile

BASE = 0xc0008000
LLVM = os.environ.get('LLVM_BIN', '/opt/homebrew/opt/llvm/bin')
img, start, ln = sys.argv[1], int(sys.argv[2], 16), int(sys.argv[3], 16)
d = open(img, 'rb').read()
here = os.path.dirname(os.path.abspath(__file__))
out = subprocess.run([sys.executable, '-I', os.path.join(here, '..', 'stock-kallsyms.py'), img],
                     capture_output=True, text=True).stdout
syms = sorted((int(a, 16), n) for a, t, n in (l.split(' ', 2) for l in out.splitlines() if l and l[0] != '#') if t in 'tTW')
keys = [a for a, _ in syms]
def sym(a):
    i = bisect.bisect_right(keys, a) - 1
    return f'{syms[i][1]}+0x{a - syms[i][0]:x}' if i >= 0 and a - syms[i][0] < 0x4000 else None
def cstr(a):
    o = a - BASE
    if not (0 <= o < len(d) - 1): return None
    e = d.find(b'\0', o)
    s = d[o:e]
    if 3 <= len(s) < 120 and all(32 <= c < 127 or c in (1, 10) for c in s):
        return s.decode().replace('\x01', '<L>').replace('\n', '\\n')
    return None
with tempfile.TemporaryDirectory() as td:
    elf = os.path.join(td, 'k.elf')
    subprocess.run([f'{LLVM}/llvm-objcopy', '-I', 'binary', '-O', 'elf32-littlearm',
                    '--rename-section', '.data=.text,code,alloc,load,readonly,contents', img, elf], check=True)
    s = start - BASE
    dis = subprocess.run([f'{LLVM}/llvm-objdump', '-d', '--triple=armv7', f'--start-address={s}',
                          f'--stop-address={s + ln}', elf], capture_output=True, text=True).stdout
for l in dis.splitlines():
    m = re.match(r'\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.*)', l)
    if not m: continue
    off, word, rest = int(m.group(1), 16), int(m.group(2), 16), m.group(3)
    rest = re.sub(r'\s*<_binary[^>]*>', '', re.sub(r' @ imm = .*', '', rest))
    note = ''
    pm = re.search(r'ldr\s+\w+, \[pc, #(0x[0-9a-f]+)\]', rest)
    if pm:
        lit = int.from_bytes(d[off + 8 + int(pm.group(1), 16):off + 12 + int(pm.group(1), 16)], 'little')
        note = f'  ; ={lit:#x}'
        t = cstr(lit) or cstr(lit + 1) or sym(lit)
        if t: note += f' {t!r}' if cstr(lit) or cstr(lit + 1) else f' {t}'
    bm = re.match(r'bl?x?\s+0x([0-9a-f]+)', rest)
    if bm:
        t = sym(int(bm.group(1), 16) + BASE)
        if t: note = f'  ; {t}'
    print(f'{off + BASE:08x}: {word:08x} {rest}{note}')
