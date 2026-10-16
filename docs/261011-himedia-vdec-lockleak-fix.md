# histb-vdec: every ioctl blocks after a GStreamer v4l2codecs probe

Date 2026-10-11. Kernel 6.18.55 AArch32. Patch `scripts/himedia/kernel/arm32/0008-media-hisilicon-histb-vdec-vpss-from-6.12.patch`.
Tags: **[read]** read in source, **[tested]** compiled/applied here, **[inferred]** reasoning only, **[unknown]**. No hardware was touched (no ssh).

## 1. Verdict first

**I did not find a `mutex_unlock` that is skipped on an early return. The root cause is NOT proven.** [read] Every lock in the probe path was audited (section 2) and all are balanced. What I found instead:

1. The hung lock is the **device-wide `vdec->lock`**, which is `vdec->vfd.lock` (`histb-vdec-core.c` `histb_vdec_register_video`, `vdec->vfd.lock = &vdec->lock`) and also `src_vq->lock` / `dst_vq->lock` (`histb_vdec_queue_init`). `__video_do_ioctl` takes it with `mutex_lock_interruptible` for every ioctl including QUERYCAP (`v4l2-ioctl.c` ~3098). One holder that never returns blocks every file, every process. [read]
2. Nothing in our code takes `vdec->lock` explicitly (`grep` finds only the three assignments + `mutex_init`). So the holder is **a task inside some ioctl (or vb2 wait_prepare/finish) that died or sleeps forever**. [read]
3. The symptom "first scanner died as a zombie, lock never released" matches **a task that oopsed inside an ioctl**: `do_exit` after an oops never runs `mutex_unlock`. A task that is merely killed cannot leak a mutex, because `mutex_lock_interruptible` returns and the ioctl unwinds. **[inferred]** This is the strongest hypothesis, and it needs `dmesg`/pstore from the box to confirm (section 4, step 0). If there is an oops line, its `PC is at` names the exact function; this doc cannot.
4. The other candidate class is a task **sleeping uninterruptibly in our code with `vdec->lock` held** (a second thread of the scanner, while the leader shows as zombie). The only unbounded sleeps reachable under that lock were two `wait_for_completion()` calls; both are now bounded (section 3). Neither is on the probe path as far as I can read it, so I rate this **[inferred] less likely** than the oops.

Do not treat section 3 as "the fix for the reported hang". It removes two real hazards of the same class and makes release safe, and section 4 gives the test that tells us which of the two classes happened.

## 2. What the GStreamer probe does and where it lands in our driver

From `gst-plugins-bad/sys/v4l2codecs` branch 1.26 (`gstv4l2codecdevice.c`, `gstv4l2decoder.c`, `gstv4l2codech264dec.c`) [read, fetched today]:

| # | Call (fd) | Driver code reached | Lock / wait |
|---|---|---|---|
| 1 | scanner opens every `/dev/media*`, `MEDIA_IOC_G_TOPOLOGY` | media core only | media graph mutex |
| 2 | `open(media)`, `open(video, O_NONBLOCK)` | `histb_vdec_open` (ctrl init, `v4l2_m2m_ctx_init`) | none |
| 3 | `VIDIOC_QUERYCAP` | `histb_vdec_querycap` (strscpy only) | vfd->lock |
| 4 | `VIDIOC_CREATE_BUFS` count=0, MMAP, OUTPUT | core `vb2_create_bufs` returns before `queue_setup` | vfd->lock |
| 5 | `VIDIOC_ENUM_FMT` OUTPUT, index 0..n | `histb_vdec_enum_fmt` (switch) | vfd->lock |
| 6 | per codec: `S_FMT` OUTPUT (S264/S265/VP8F/MG2S/VP9F, 320x240) | `histb_vdec_s_fmt` -> `histb_vdec_free_buffers` -> `reset_mpeg4_state`, `reset_vc1_state` (takes `ctx->vc1_lock`), `reset_vp9_state` | vfd->lock, ctx->vc1_lock (uncontended) |
| 7 | `G_FMT` CAPTURE, `ENUM_FMT` CAPTURE with `V4L2_FMTDESC_FLAG_ENUM_ALL` (index bit 31), `ENUM_FRAMESIZES` | `g_fmt`, `enum_fmt` (index >= 2 -> -EINVAL), `enum_framesizes` | vfd->lock |
| 8 | `VIDIOC_QUERY_EXT_CTRL` per codec control | ctrl core only | ctrl handler lock |
| 9 | `close()` both fds | `v4l2_release` takes `req_queue_mutex`, then `histb_vdec_release` -> `v4l2_m2m_ctx_release`, `histb_vdec_free_buffers`, `kfree` | req_queue_mutex |

The probe never streams, never allocates a request, never queues a buffer. [read] So `device_run`, `histb_vdec_abort` and the VC-1/MPEG-4 job locks are not reached from it unless a stream is started.

Lock audit result [read]:
- `launch_lock`: 9 lock sites, every one has a matching unlock on all paths (7842-7859, 7890, 9014-9031, 9538-9580, 9607, 9720, 9842, 10421-10433, 10452, 10502-10505, 10528-10540, 10547-10558, 11131-11161).
- `ctx->vc1_lock`, `ctx->mpeg4_lock`: all lock sites balanced, including the `goto unlock_vc1` / `unlock` ladders in `histb_vdec_decoder_cmd`. Both are per-open-file, so they cannot block another process's QUERYCAP.
- `vpss->lock` (`histb-vpss.c` 1237/1739, 1788/1844): balanced via `goto unlock`; waits use `wait_for_completion_timeout`. Separate mutex from vfd->lock.
- Hardware polls: the only poll is `regmap_read_poll_timeout` (bounded). No `while (readl...)` loop exists.

## 3. Changes (all in `drivers/media/platform/hisilicon/histb-vdec-core.c`)

1. New `HISTB_VDEC_IDLE_WAIT_MS` (5000). Reason: any wait that runs while the device-wide `vfd->lock` is held must be bounded.
2. `histb_vdec_abort()` (called from `stop_streaming`, `job_abort`, and release): `wait_for_completion(&ctx->vc1_setup_idle)` -> `wait_for_completion_timeout`; on timeout `dev_warn` and carry on. An unbounded wait here froze the whole device if a VC-1 setup ever failed to signal.
3. `histb_vdec_device_run()`: `wait_for_completion(&vdec->postprocess_idle)` -> bounded; on timeout `dev_err`, finish the job with `VB2_BUF_STATE_ERROR` via `histb_vdec_finish_job_no_pm()` and return. `device_run` is invoked synchronously from `v4l2_m2m_try_schedule()` inside QBUF/STREAMON/request-queue, i.e. with `vfd->lock` or the media `req_queue_mutex` held [read: `v4l2-mem2mem.c`, `v4l2-ioctl.c`], so an unbounded wait there is the same freeze.
4. `histb_vdec_release()`: if the closing file still owns the running job (`curr_ctx`) or the pipelined post-process (`post_ctx`), call `histb_vdec_abort()` **before** `v4l2_m2m_ctx_release()` and `kfree(ctx)`. Without it a file closed (or killed) while a pipelined HEVC post-process was pending left `vdec->post_ctx` and the queued `postprocess_work` pointing at freed memory, which is a use-after-free in a dying process. [inferred from reading `post_ctx` users; not reproduced]
5. `scripts/himedia/vdec-regen-core-patch.py` (new, named tool): swaps the `histb-vdec-core.c` new-file section of 0008 for a tree file. Re-run after any edit of the tree copy.

Not changed: nothing else. I did not invent a lock fix for a leak I could not find.

### Build and patch results
- `make drivers/media/platform/hisilicon/` in `himedia-kbuild-arm32:trixie` (ARCH=arm, CROSS_COMPILE=arm-linux-gnueabihf-): histb-vdec-core/mpeg4/vc1/mvc/vpss all `CC [M]`, `LD [M] histb-vdec.o`, **0 errors, 0 warnings** [tested]. Log: (run log). A `W=1` compile of the same file also compiled; the later `modpost` failure there is the known missing `vmlinux.o` of a partial tree, not this change. No `.ko` link was done in this tree (same as the earlier verify build); the box needs the usual full module build.
- 0008 regenerated: hunk header `@@ -0,0 +1,12998 @@` (was 12962), 46 changed lines. `patch -p1` reverse of the old 0008 then forward of the new one on the `verify/` tree (0001-0007 base) succeeded, and the resulting file is **byte-identical** to the working tree copy (`cmp`) [tested].
- Modules to reinstall on the box: `histb-vdec.ko` only (no change to `histb-vpss.ko`, `v4l2-mem2mem.ko`).

## 4. Hardware test sequence that would have caught it

Run on the box, **one command per line, each under `timeout 5`**, in GStreamer's order. Stop at the first timeout (rc 124): the line before it left the lock held.

```
# step 0: if the device is ALREADY wedged, collect evidence BEFORE rebooting
dmesg | grep -iE "Oops|Unable to handle|BUG:|WARNING:|histb|hung task|blocked for more"
ls /sys/fs/pstore/; cat /sys/fs/pstore/* 2>/dev/null | tail -80
echo w > /proc/sysrq-trigger; dmesg | tail -80           # lists every task in D state with its stack
for p in $(pgrep -f 'gst-plugin-scanner|gst-inspect'); do echo "== $p"; cat /proc/$p/stack /proc/$p/wchan; done
```
The `sysrq-w` stack shows who sleeps holding the mutex; an oops line shows the faulting function. Either one replaces the guess in section 1.

```
timeout 5 v4l2-ctl -d /dev/video0 --info                              # QUERYCAP (gst step 3)
timeout 5 v4l2-ctl -d /dev/video0 --list-formats-out                  # ENUM_FMT OUTPUT (step 5)
timeout 5 v4l2-ctl -d /dev/video0 --set-fmt-video-out=width=320,height=240,pixelformat=S264   # step 6, repeat for S265 VP8F MG2S VP9F
timeout 5 v4l2-ctl -d /dev/video0 --get-fmt-video                     # G_FMT CAPTURE (step 7)
timeout 5 v4l2-ctl -d /dev/video0 --list-formats                      # ENUM_FMT CAPTURE
timeout 5 v4l2-ctl -d /dev/video0 --list-framesizes=NV12              # ENUM_FRAMESIZES
timeout 5 v4l2-ctl -d /dev/video0 --list-ctrls-menus                  # QUERY_EXT_CTRL / QUERYCTRL
timeout 5 v4l2-ctl -d /dev/video0 --info                              # lock still free? (re-run after every step above)
timeout 5 media-ctl -d /dev/media0 -p                                 # MEDIA_IOC_G_TOPOLOGY
```
Then the close path, the part a one-shot `v4l2-ctl` always exercises but a probe exercises with 6 formats in a row:
```
timeout 5 v4l2-ctl -d /dev/video0 --info   # run 20 times in a loop; any 124 = leaked lock after a close
timeout 20 gst-inspect-1.0 v4l2codecs      # the real probe; then immediately:
timeout 5 v4l2-ctl -d /dev/video0 --info   # MUST still answer
```
Pass criteria: every command returns rc 0 (or the documented -EINVAL for MG2S/VP8F lines the driver does not take), and the final `--info` returns after the GStreamer probe. Also run the probe once with `kill -9` sent to `gst-plugin-scanner` mid-way (`timeout -s KILL 1 gst-inspect-1.0 v4l2codecs`) and then `timeout 5 v4l2-ctl --info`: this is the dying-file case that change 4 targets.

## 5. If the hang still reproduces after this build

It is then not a bounded-wait problem. Take step 0 evidence first. Likely next places, in order: the oops function named by the trace; `histb_vdec_free_buffers()` reached from `S_FMT` (it frees DMA buffers and resets MPEG-4/VC-1/VP9 state on every OUTPUT format change, i.e. 5 times per probe); `histb_vdec_release()` ordering. Ask for the `sysrq-w` output before changing code again.

## 6. Capture loop
- `[ ]` Hardware: run section 4 on the box with the rebuilt `histb-vdec.ko` and attach step-0 output (ref: this doc).
- Candidate hardening not done (no evidence it matters): `histb_vdec_free_buffers()` calls `reset_mpeg4_state()` without `ctx->mpeg4_lock`.
