#!/usr/bin/env python3
"""Cross-check the vendor HEVC CABAC init table (s_InitValue in vdm_hal_hevc.S, which is what
histb-hevc-cabac.bin is built from) against FFmpeg's init_values[3][] (the H.265 spec numbers).
usage: verify-hevc-cabac-table.py <vdm_hal_hevc.S> <ffmpeg hevc/cabac.c>
Prints, per init type, how well the vendor list lines up with FFmpeg's list under a few hypotheses.
"""
import re, sys
S = open(sys.argv[1]).read().split('\n')
i = next(k for k, l in enumerate(S) if l.strip() == 's_InitValue:')
iv = []
for l in S[i + 1:]:
    t = l.strip()
    if t.startswith('.word'):
        v = int(t.split()[1], 0); iv.append(v - (1 << 32) if v >= 1 << 31 else v)
    elif t.startswith('.'):
        if t.startswith(('.type', '.size', '.global')): break
    elif t: break
print('vendor entries', len(iv))
C = open(sys.argv[2]).read()
body = C[C.index('init_values[3][HEVC_CONTEXTS] = {'):]
body = body[:body.index('\n};')]
body = re.sub(r'//[^\n]*', '', body).replace('CNU', '154')
sets = []
for blk in re.split(r'\n\s*\},\s*\{', body):
    nums = [int(x) for x in re.findall(r'\b\d+\b', blk)]
    sets.append(nums)
print('ffmpeg sets', [len(s) for s in sets])
for t in range(3):
    v = iv[t * 160:(t + 1) * 160]
    f = sets[t]
    print(f'type {t}: vendor head', v[:24])
    print(f'type {t}: ffmpeg head', f[:24])
    # multiset overlap
    from collections import Counter
    cv, cf = Counter(x for x in v if x >= 0), Counter(f)
    print('   multiset overlap', sum((cv & cf).values()), 'of', sum(cv.values()), 'vendor /', sum(cf.values()), 'ffmpeg')
