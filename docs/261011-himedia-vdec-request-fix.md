# histb-vdec: MEDIA_REQUEST_IOC_QUEUE returns ENOENT for GStreamer v4l2slh264dec

Date 2026-10-11. Kernel 6.18.55 AArch32. Patch `scripts/himedia/kernel/arm32/0008-media-hisilicon-histb-vdec-vpss-from-6.12.patch`.
Tags: **[read]** read in source, **[tested]** compiled/applied here, **[inferred]** reasoning only, **[unknown]**. No hardware touched (no ssh); the fix is NOT yet verified on the box.

## 1. Root cause [read]

`histb_vdec_request_validate()` (driver, pre-fix lines ~12540-12610) demanded that every request contain **all five** H.264 controls, SPS, PPS, SCALING_MATRIX, SLICE_PARAMS and DECODE_PARAMS, using `v4l2_ctrl_request_hdl_ctrl_find()`. That helper returns a control only if `ref->p_req_valid` is set, i.e. only if the client set it **in this request** (`v4l2-ctrls-request.c:146`). Failure was `return -ENOENT` (the `required[i]` loop). `MEDIA_REQUEST_IOC_QUEUE` passes that errno straight back, hence "No such file or directory" with no kernel message (no `dev_err` on that path).

GStreamer 1.26 never sends all five (`gstv4l2codech264dec.c`, `gst_v4l2_codec_h264_dec_submit_bitstream`, ~1205-1340):

| Control | When GStreamer sets it | Line |
|---|---|---|
| SPS | only when `need_sequence` (first request of a sequence) | 1263 |
| PPS, DECODE_PARAMS | only on `first_slice` of a picture | 1271 |
| SCALING_MATRIX | only if `scaling_matrix_present` (x264 medium: never) | 1277 |
| SLICE_PARAMS, PRED_WEIGHTS | slice-based mode, every request | 1293 |

Declared optional in the size probe: SCALING_MATRIX, SLICE_PARAMS, PRED_WEIGHTS (`:174-185`). So the very first frame of the test stream fails on the missing SCALING_MATRIX, and even with one, frame 2 would fail on the missing SPS and slice N>0 sub-requests (which carry only SLICE_PARAMS + PRED_WEIGHTS) would fail too.

Request shape on the GStreamer side [read]: `gst_v4l2_request_queue` (`gstv4l2decoder.c:1440-1470`) queues the bitstream into the request (`queue_sink_mem`, with the request fd), queues the CAPTURE buffer **without** a request (`queue_src_buffer`, skipped for sub-requests), then calls `MEDIA_REQUEST_IOC_QUEUE` (:1469). So the request holds exactly one vb2 buffer. The driver's buffer-count check (`!count -> ENOENT`, `count>1 -> EINVAL`) and `supports_requests`/`requires_requests` on the OUTPUT queue (`histb_vdec_queue_init`) were fine [read]. Not the cause.

The decode path itself does not need the controls in the request: `device_run` reads them from the main handler (`histb_vdec_ctrl_data()` -> `p_cur`), and `v4l2_ctrl_request_setup()` applies only what the request carries, so omitted controls keep their previous value. Only SLICE_PARAMS is truly per-request in slice-based mode [read].

Other findings from the log:
- `V4L2_FRMSIZE type not supported` (`gstv4l2decoder.c:429`): the driver returns STEPWISE and GStreamer only accepts DISCRETE. Harmless, same as hantro/rkvdec [read]. Not changed.
- P010 offered for an 8-bit H.264 stream: `histb_vdec_enum_fmt` returned P010 at CAPTURE index 1 unconditionally [read]. `try_capture_format` already refused P010 unless the OUTPUT format is HEVC, so S_FMT would have been coerced, but ENUM_FMT lied.
- Menu definitions: H.264 DECODE_MODE / START_CODE were registered with the full range and a comment claiming the core "clamps" a pinned control. It does not: `-ERANGE`. The comment on START_CODE said "annex-B", while default and the old validate check were NONE. The driver feeds the buffer straight to `histb_vdec_ebsp_to_rbsp()` and never skips a start code, so NONE is what it really takes [read; whether `header_bit_size` from GStreamer matches with NONE is [unknown] until hardware].

## 2. The fix (histb-vdec-core.c, patch 0008 regenerated)

1. `histb_vdec_request_validate()`: required-in-request lists reduced to the controls that change on every request:
   - H.264: SLICE_PARAMS only. SPS, PPS, DECODE_PARAMS, SCALING_MATRIX, PRED_WEIGHTS are optional (keep last value).
   - HEVC: SLICE_PARAMS + DECODE_PARAMS (GStreamer sends SPS once, PPS per picture; frame-based-with-slices because the driver exposes SLICE_PARAMS, `gstv4l2codech265dec.c:142-160`). [inferred for HEVC: not run]
   - MPEG-2: PICTURE only (SEQUENCE is sent once, `gstv4l2codecmpeg2dec.c:896`). VP8, VP9 unchanged.
   - Missing required control now `-EINVAL` (was `-ENOENT`, which the core also uses for "no buffer in the request"), with a `dev_dbg` naming the control id. A client that never sent SPS/PPS/DECODE_PARAMS is rejected later by `histb_vdec_validate_h264()` on a zeroed control (buffer error, `request setup failed: -22` in dmesg).
   - The ad-hoc "fixed value" check was removed; ranges are pinned instead.
2. Controls pinned (min == max == def): H.264 DECODE_MODE = SLICE_BASED, START_CODE = NONE; HEVC DECODE_MODE = FRAME_BASED, START_CODE = NONE. A client asking for anything else gets `-ERANGE` from the core, and QUERYMENU lists only what exists. Comments corrected.
3. `histb_vdec_enum_fmt()` CAPTURE: index 1 (P010) only when the OUTPUT format is `HEVC_SLICE`; for H.264/MPEG-2/VP8/VP9/... it is NV12 only (`-EINVAL` at index 1). Per-SPS (Main vs Main10) selection is left to the client via TRY_FMT, as `try_capture_format` already did. [HEVC 8-bit streams still see P010 listed second.]

Unchanged on purpose: slice-based + start-code NONE (that is what the hardware path does), STEPWISE frame sizes, HOLD_CAPTURE_BUF support (needed for multi-slice).

## 3. Build [tested]

- `histb-vdec-core.c` -> `CC [M]` + `LD [M] histb-vdec.o`, **0 errors, 0 warnings**. Image `himedia-kbuild-arm32:trixie`, `make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- drivers/media/platform/hisilicon/`, exit 0. Log: (run log). `histb-vpss` was already up to date (source unchanged), so it was not recompiled. No `.ko` link in this partial tree (same as the previous fix); the box needs the usual full module build.
- 0008 regenerated with `scripts/himedia/vdec-regen-core-patch.py`. Applied to a clean `git archive HEAD` of the tree: 0002-0007 pass `patch -p1 -N --dry-run`, 0008 applies, and the resulting `histb-vdec-core.c` is byte-identical to the working tree. (0001 is not in this directory.)
- Backups of the pre-fix state: `$HIMEDIA_ROOT/vdec-port/histb-vdec-core.c.pre-reqfix`, `.../0008.pre-reqfix`. GStreamer sources used: `$HIMEDIA_ROOT/gst-src/` (branch 1.26).
- Not committed.

## 4. Verify on hardware (not yet run)

Rebuild/deploy the module the usual way, then on the box:

```
# 1. menus are pinned
v4l2-ctl -d /dev/video0 --list-ctrls-menus | grep -iA3 "decode_mode\|start_code"
#    expect H.264 decode mode: only "Slice-Based", start code: only "No Start Code"
v4l2-ctl -d /dev/video0 --set-ctrl=h264_decode_mode=1   # expect ERANGE (Numerical result out of range)

# 2. CAPTURE formats follow the OUTPUT format
v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=1280,height=720,pixelformat=S264
v4l2-ctl -d /dev/video0 --list-formats       # CAPTURE: NV12 only (no P010)
v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=1280,height=720,pixelformat=S265
v4l2-ctl -d /dev/video0 --list-formats       # CAPTURE: NV12 and P010

# 3. decode, with and without the caps filter (no NV12 filter now negotiates NV12 by itself)
GST_DEBUG=v4l2codecs-decoder:4,v4l2slh264dec:4 gst-launch-1.0 filesrc location=h264-720p.h264 ! h264parse ! v4l2slh264dec ! video/x-raw,format=NV12 ! fakesink sync=false
gst-launch-1.0 filesrc location=h264-720p.h264 ! h264parse ! v4l2slh264dec ! fakesink sync=false -v 2>&1 | grep -i "format=\|MEDIA_REQUEST\|did not accept"

# 4. kernel side: any rejection is now logged / attributable
dmesg | tail -30        # no "request setup failed", no oops
echo 'file histb-vdec-core.c +p' > /sys/kernel/debug/dynamic_debug/control   # then rerun, dmesg shows "request lacks control 0x..." if a client omits SLICE_PARAMS
```

Pass criteria: no `MEDIA_REQUEST_IOC_QUEUE failed`, `fakesink` reaches EOS, GStreamer reports `format=NV12`. If it then fails inside `histb_vdec_validate_h264` (`request setup failed: -22`), the next suspects are `header_bit_size` with START_CODE NONE and the first-slice DECODE_PARAMS flags; those are [unknown] until the box answers. FFmpeg / Kodi v4l2-request send the full control set every request, which the relaxed check also accepts [inferred; ffmpeg's start-code/decode-mode reading untested].

## 5. Capture loop

- Lesson: `v4l2_ctrl_request_hdl_ctrl_find()` means "set in THIS request", not "exists"; a validate that uses it for non-per-request controls rejects every standard client. `-ENOENT` is also the vb2 "no buffer in request" code, so use `-EINVAL` for a missing control.
