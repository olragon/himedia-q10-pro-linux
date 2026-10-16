# histb-vdec: H.264 "decode failed state=00060001" and all-zero (green) frames

Date 2026-10-11. Kernel 6.18.55-k14 AArch32. Driver `drivers/media/platform/hisilicon/histb-vdec-core.c` in `$HIMEDIA_ROOT/vdec-port/linux-6.18.55`, patch `scripts/himedia/kernel/arm32/0008-media-hisilicon-histb-vdec-vpss-from-6.12.patch`.
Tags: **[read]** read in source or vendor asm, **[tested]** ran here on the Mac / in the kbuild container, **[inferred]** reasoning only, **[unknown]**. No ssh, no hardware run. **Nothing here is verified on the box yet.**

Hardware evidence given:
```
H.264 decode failed: state=00060001 expected=00020001 slices=1 units=3600 int=00000001 vctrl=00000001 up=94430000/00000000/00000b2e/00000000 h264=1/1/0/0
SMMU state s=0 ns=0 err=0/0 fault-r=0/0 fault-w=0/0
```

## 1. What the words say

**The extra bit 0x00040000 is not the failure.** The H.264 slice path accepts *either* `DEC_OVER | n` *or* `0x00060000 | n` (`histb_vdec_h264_slice_message_valid`, completion check) [read]; the community driver documents that CV200 raises DEC_ERR at the normal CABAC end marker [read, community comment]. The `expected=00020001` in the old message is only the CAVLC form and misleads. What made the picture fail is the **UP coverage check**: slice 0 reported MBs `0 .. 0xb2e = 2862`, but the picture has 3600, so `next_mb (2863) != units (3600)` -> `message_error` -> `decode_failed`.

| Field | Value | Meaning | Evidence |
|---|---|---|---|
| STATE[16:0] | 1 | number of UP slice reports written | [read] vendor `VDMHAL_V400R003_MakeDecReport`: `ubfx r2, r2, #0, #17` is the report count |
| STATE[17] | 1 | DEC_OVER, the VDH finished | [read] same function: picture is clean only when `(state >> 17) & 3 == 1` |
| STATE[18] | 1 | DEC_ERR. Vendor sets its H.264 error flag for anything but `01`; it then judges the picture by the MB ranges below | [read] same function (`cmp r8,#3; orrne r3,#1` = not-MPEG-2 -> error) |
| UP word 1 [15:0] | 0 | first MB decoded in the slice | [read] vendor copies exactly word1/word2 low halves into its decode report |
| UP word 2 [15:0] | 2862 | last MB decoded: **the VDH stopped at 79.5% of the picture** (row 35, column 62) | [read] |
| UP word 0 | 0x94430000 | **not read by the vendor at all.** Community: `0x14230000` (bit 31 masked) = clean CABAC end. Ours differs in bit 21 (clear) and bit 22 (set); bit 31 set | [read] that 0x14230000 is the community's accepted value; "bit 21 = clean end, bit 22 = abnormal end" is **[inferred]** from that one pairing only |
| UP word 3 | 0 | community requires 0 | [read] |
| SMMU | all 0 | SMMU is bypassed (`SMMU_CTRL=0`), so "no fault" says nothing about out-of-range DMA | [read] |

So the stage that failed is **slice-data parsing**: the VDH read the slice header position, initialised CABAC, decoded 2863 macroblocks and then ended the slice abnormally. Either it ran out of valid bits early or the arithmetic decoder had desynchronised somewhere earlier and only noticed at MB 2862 (CABAC garbage can run a long way before an impossible symbol appears) [inferred].

**Why the frames are solid green:** on `decode_failed` the IRQ handler resets the engine and calls `histb_vdec_finish_job(ctx, VB2_BUF_STATE_ERROR)`; the VPSS detile is never queued (`postprocess_work` only on success) [read]. The CAPTURE buffer is returned untouched, i.e. zero, and NV12 Y=U=V=0 renders green. Item 5 of the brief is a consequence, not a second bug; the VPSS path is not exercised at all until one picture passes.

## 2. Root-cause candidates, ranked

### 2.1 Emulation-prevention domain (RBSP vs EBSP) - the one live candidate, untestable here
- Vendor VFMW never removes EPBs in software: no EPB code anywhere in `vfmw` (grep for emulation/0x000003: none in the H.264 path); `bitstream.S` `BsGet` reads raw bytes; `H264HAL_SetSliceMsgStreamAddrInfo` passes raw NAL byte positions and `valid_bitlen` from `CalcStreamBits` [read]. A shipping decoder that works on EPB-bearing streams that way implies the **hardware** (VDH stream fetch, or the SCD the vendor cuts the stream with) removes `00 00 03` [inferred].
- The port (like the community driver) strips EPBs itself and feeds RBSP (`histb_vdec_ebsp_to_rbsp`) [read]. If the VDH also strips/scans, the RBSP we feed can contain `00 00 0x` patterns that the hardware treats specially.
- The test stream's first IDR (31,806 B) has exactly one EPB, at byte 1191 (3.7%): EBSP `00 00 03 01` -> RBSP `00 00 01`, i.e. **a start-code pattern inside the RBSP we hand the VDH** [tested: `scripts/himedia/video/h264-nal-scan.py`]. A desync there that is only detected at MB 2862 fits the observation [inferred].
- **Against it:** the community accepts 0x14230000 as a clean end, so RBSP worked for them on some stream [read]; and the next nine non-IDR pictures of this clip have **no** EPB at all [tested]. If those pictures also fail, this candidate is excluded and the problem is systematic (2.4).
- Header offsets are self-consistent today: GStreamer sends `header_bit_size = 8*header_bytes + header_size - 8*n_emulation_prevention_bytes` (`gstv4l2codech264dec.c:805`), an RBSP position counted from the NAL header byte; with START_CODE_NONE the buffer starts at that byte and the driver converts the whole NAL to RBSP before using it [read]. So the open question from the request-fix doc (header_bit_size with start code NONE) is **answered: consistent in RBSP mode**. Mixing would only happen if the hardware wants EBSP.

### 2.2 CABAC init table - ruled out [read]
`histb-h264-cabac.bin` (5,120 B) is byte-identical to vendor `g_CabacMN` (`common/syntax/h264.S`, `.size 5120`, little-endian `.word`s), and the vendor installs it with a plain 5,120-byte memcpy (`Write_V400R003_CabacTab` -> `vfmw_Osal_Func_Ptr_S[52]`), at the address it then puts in picture-message word 26 (`[hwmem+1088] & ~15`, `SetPicMsg`). The driver does the same memcpy into a coherent buffer and writes it to `pic[26]`. Decoding the words: row 1 halves read `(20,-15) (2,54) (3,74) (-28,127) (-23,104) (-6,53) (-1,54) (7,51)` = the standard H.264 (m,n) for ctxIdx 0-7, one context per 16-bit half, high half first. A wrong table also fails in the first few MBs, not at MB 2862 [inferred]. The community tree does not ship the file [read, earlier report]. HEVC table: not examined further (H.264 does not use it).

### 2.3 Message layout - verified word by word against the vendor [read]
Using the struct offsets in `decparam.h` (`H264_DEC_PIC_PARAM_S`, `H264_DEC_SLICE_PARAM_S`) to read `H264HAL_V400R003_SetPicMsg` / `SetSliceMsg` / `SetSliceMsgStreamAddrInfo` / `SetSliceMsgEndMbInSlice` / `CfgVdmReg`:
- pic word 0: width-1, height-1<<16, structure<<14, 4:2:0<<25, constrained<<26, entropy<<27, transform8x8<<28, nal_ref_idc<<31 - driver matches.
- slice word 0/1/2: (bytepos & ~15) - (stream_base & ~15); (bytepos*8 + bitoffset) & 127; valid bit length - driver matches (two segments, second zero).
- word 6: first_mb[19:0] | cabac_init_idc<<24 | SliceQPy<<26; word 7: hw type | listXsize<<2/<<8 | direct_8x8<<14 | direct_spatial<<15 | active-1<<16/<<21; word 10: second_chroma | chroma<<5 | weight<<16; word 11: deblock | beta<<8 | alpha<<16; word 44: end MB (next first_mb-1, or (total-1)/(MbaffFrameFlag+1)); word 63: next slice message - driver matches.
- BASIC_CFG0 `0x41000000 | total-1`, timeouts `0x00300c03`, CFG1 bits 14 (new pic), 15, 16 - driver matches; CFG1 bit 12 (`VdhMmuEn`) and bit 30 (`Compress_en`) are 0 here because the port runs without SMMU/compression [read].
Nothing mis-mapped was found.

### 2.4 Something systematic and not yet visible [unknown]
If every picture fails (IDR and EPB-free P pictures alike), 2.1 is out and the next suspects are inputs only the box shows: the actual `valid_bits`/`tail_bits` per slice versus the NAL size, the slice-data head bytes (is `header_bits` really at the first slice-data byte?), and per-picture references. Section 3's logging prints exactly these, so the next run decides it.

## 3. What changed (histb-vdec-core.c, 0008 regenerated)

1. **Named status decode on every H.264 failure** (`histb_vdec_h264_explain_failure`, called from the IRQ's `decode_failed` branch before the old line):
   - `H.264 VDH status: reports=N (slices queued M) DEC_OVER=x DEC_ERR=y unknown-state-bits=0x..; vendor verdict: clean|did not finish|error flag set`
   - per UP report (up to 8): `MB a..b of N (reached P%) word0=.. [b31 b21(clean-end?) b22(abnormal-end?) = community CABAC clean end] word3=.. <- STOPPED EARLY ...`
   - per slice (up to 4): `slice i of picture #K: type=I/P/B first_mb feed=RBSP|EBSP(raw) nal=.. B fed=.. B epb=.. rbsp-00000x=.. header_bit_size=.. -> header_bits=.. valid_bits=.. tail_bits=.. data=<8 bytes at header_bits/8>`
   - a hint line when the failing picture carried EPBs in RBSP mode.
   State is recorded per slice in `ctx->h264_diag[]` while building the messages; the EPB count is taken on the vb2 mapping, not the uncached stream copy.
2. **A/B switch `h264_raw_ebsp`** (module parameter, 0644, default **off** = unchanged RBSP behaviour). On: the NAL is copied without EPB removal, `valid_bits` is computed over the EBSP, and `header_bit_size` is moved from the RBSP to the EBSP position *after* the CABAC byte alignment (`histb_vdec_rbsp_to_ebsp_bits`). The mode is latched per picture (`ctx->h264_raw`), so flipping it mid-stream cannot mix modes inside one picture. The RBSP->EBSP mapping was checked on the real IDR on the host (every probe byte maps to the same byte value, bit-in-byte kept) [tested, Python mirror of the C loop].
3. No change to the CABAC files (verified correct, 2.2); nothing regenerated in `vdec-port/firmware/hisilicon/`.

Build [tested]: `make W=1 drivers/media/platform/hisilicon/` in `himedia-kbuild-arm32:trixie` (`ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-`, vdec-port tree): `histb-vdec-core.o`, `histb-vdec-mpeg4/vc1/mvc.o`, `histb-vdec.o`, `histb-vpss.o` built, **0 errors, 0 warnings** (one format warning in the first build fixed). Logs `vdec-port/logs/vdec-decodeerr-build{,2}.log`, `archive/20261011-2132*-vdec-decodeerr-build*.log`. `kernel-build-arm32/` untouched. 0008 regenerated with `scripts/himedia/vdec-regen-core-patch.py`; extracting the file back out of the patch is byte-identical to the tree [tested]. Backups: `vdec-port/histb-vdec-core.c.pre-decodeerr`, `vdec-port/0008.pre-decodeerr`. Not committed.

New tool: `scripts/himedia/video/h264-nal-scan.py <file.h264> [n]` lists NALs with size, EPB positions and RBSP `00 00 0x` hazards.

## 4. Hardware test

Install the rebuilt `histb-vdec.ko` the usual way, then on the box:

```
dmesg -C
# A: current behaviour (RBSP feed)
gst-launch-1.0 filesrc location=h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! pngenc ! multifilesink location=/tmp/fr%03d.png
dmesg > /tmp/vdec-rbsp.txt
grep -c "decode failed" /tmp/vdec-rbsp.txt          # how many pictures failed (clip has 300)
grep -m12 "H.264 " /tmp/vdec-rbsp.txt                # first two failures, fully named
grep "slice 0 of picture" /tmp/vdec-rbsp.txt | head -20   # which pictures fail: type=I only, or P too? epb=0 ones?

# B: raw EBSP feed
dmesg -C; rm -f /tmp/fr*.png
echo 1 > /sys/module/histb_vdec/parameters/h264_raw_ebsp
gst-launch-1.0 filesrc location=h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! pngenc ! multifilesink location=/tmp/fr%03d.png
dmesg > /tmp/vdec-ebsp.txt; grep -c "decode failed" /tmp/vdec-ebsp.txt
ls /tmp/fr*.png | wc -l      # then look at /tmp/fr000.png and /tmp/fr150.png
echo 0 > /sys/module/histb_vdec/parameters/h264_raw_ebsp
```

Reading the result:
- **B has 0 failures and A had failures** -> the VDH removes EPBs itself; make `h264_raw_ebsp` the default (and the same question then applies to the HEVC shadow path, `histb_vdec_copy_hevc_bitstream`, which also strips).
- **A fails only on pictures with `epb>0`** but B fails too -> EPB is involved but the EBSP offset/length convention differs; send both dmesg files.
- **Every picture fails in both modes, including `type=P epb=0`** -> not EPB. Compare in the slice lines: `fed` vs `valid_bits/8 + header_bits/8` (should differ only by the tail), `data=` (first slice-data bytes; for CABAC after alignment), and `reached P%` (constant vs varying). Send the first 30 `H.264 ` lines.
- **No failures in A** -> the earlier run was a different module build; check `modinfo histb-vdec | grep parm` shows `h264_raw_ebsp`.
- A frame that decodes but looks wrong (not green) moves the problem to VPSS/detile, which this error path never reached.

Whether `pngenc` receives frames for error-flagged CAPTURE buffers depends on GStreamer's handling of `V4L2_BUF_FLAG_ERROR` [unknown]; the `decode failed` count in dmesg is the authoritative number.

## 5. Capture loop
- `[ ]` Run section 4 on the box; decide the `h264_raw_ebsp` default from it (ref: this doc).
- `[ ]` If EBSP wins, revisit the HEVC path's software EPB stripping the same way.
- Lesson: the driver's "decode failed ... expected=" line printed the CAVLC expectation for a CABAC stream, which pointed at the status bit instead of the MB coverage that actually failed. A failure message must print the check that failed, not a related constant.
