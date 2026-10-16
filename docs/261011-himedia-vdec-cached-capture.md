# HiMedia Q10 Pro vdec: cacheable CAPTURE buffers (2026-10-11)

Tags: **[read]** seen in source this session, **[inferred]** reasoned from source, **[tested]** run on a machine. Nothing in this doc is [tested] on the board: no ssh was allowed. The only [tested] items are the build and the patch re-apply.

## Finding: the cached backend already existed, but its USERSPACE mapping was uncached
- [read] `histb_vdec_cached_memops` (alloc via `dma_alloc_pages` + vmap for highmem, prepare/finish syncs, custom dma_buf exporter) was already in the tree and in 0008. The kernel-side vaddr was cacheable.
- [read] Its `mmap` called `dma_mmap_attrs(..., attrs=0)`. For a non-coherent device `dma_pgprot()` (kernel/dma/mapping.c) forces `pgprot_dmacoherent()` whatever the attrs, so userspace got an UNCACHED mapping of cacheable-allocated memory. The dma_buf `mmap` used `pgprot_writecombine()`, also non-cacheable on ARMv7. GStreamer v4l2codecs reads CAPTURE through one of these two paths. [inferred] This is why CPU readers stayed at 7 fps / 60 ms per 3 MB frame.
- [read] The exporter had no `begin_cpu_access/end_cpu_access`, so `DMA_BUF_IOCTL_SYNC` from a client did nothing; the sg table had `page=NULL`.
- [read] No refcount on mappings: a mapped buffer could be freed under userspace.

## What vb2-dma-contig does (6.18) and what we copy
- [read] `V4L2_MEMORY_FLAG_NON_COHERENT` is honoured only if `vb2_queue.allow_cache_hints`; then `q->non_coherent_mem` makes vb2_dc use `dma_alloc_noncontiguous` (NOT physically contiguous in general; VPSS needs contiguous, so unusable). GStreamer does not pass the flag anyway.
- [read] vb2 core calls `mem_ops->prepare` at QBUF and `finish` at DQBUF; with `allow_cache_hints` unset these cannot be skipped by `V4L2_BUF_FLAG_NO_CACHE_*`. Decision: leave `allow_cache_hints` OFF, so the driver forces cacheable memory without client cooperation and no client can skip the maintenance.
- [read] vb2_dc non-coherent mmap = `dma_mmap_noncontiguous` -> `dma_mmap_pages` (keeps `vm_page_prot`, cacheable) + `vb2_common_vm_ops`. dmabuf side: `dma_map_sgtable(..., DMA_ATTR_SKIP_CPU_SYNC)` plus begin/end_cpu_access syncing. We now do the same around our own contiguous `dma_alloc_pages` block (kept because VPSS output is base+offset, SMMU is identity).

## Change (histb-vdec-core.c only; histb-vpss.c, histb-dma.h unchanged)
1. Module param `capture_cached` (bool, 0644, default 1). Read in `histb_vdec_capture_backend()` at buffer allocation: 1 = cached backend, 0 = `vb2_dma_contig_memops` (old coherent/uncached). Set before REQBUFS; per-buffer, so a flip mid-stream mixes backends harmlessly.
2. mmap -> `dma_mmap_pages()` (cacheable) + `vb2_common_vm_ops`; buffer `refs` is a `refcount_t`, each mapping, the dma_buf export and vb2 hold one. dma_buf mmap shares the same function.
3. dma_buf: real page in the sg table, `dma_map_sgtable/unmap` with SKIP_CPU_SYNC, `begin_cpu_access` = `dma_sync_single_for_cpu(dir)`, `end_cpu_access` = `dma_sync_single_for_device(dir)`.
4. `prepare` (QBUF) now `DMA_BIDIRECTIONAL` = clean+invalidate (was clean only). Removed the silent fall-back to `dma_alloc_coherent` (it would have mapped uncached while claiming cached; allocation now fails with -ENOMEM, same CMA anyway).

## Cache maintenance points (why correct) [inferred from source]
| point | action | purpose |
| --- | --- | --- |
| QBUF -> vb2 `prepare` | clean+inv whole buffer | no dirty line can be evicted over VPSS data; no stale speculative line survives into the DMA |
| VPSS DMA write (`histb_vpss_detile`, direct output) | none (device) | CPU does not touch the buffer meanwhile |
| after VPSS ok -> `histb_vdec_capture_begin_cpu_access` | `dma_sync_single_for_cpu(FROM_DEVICE)` = invalidate; sets `cpu_synced` so DQBUF skips a second one | CPU (driver fallbacks, VC-1 range map) sees DMA data |
| DQBUF -> vb2 `finish` | invalidate (unless already done above) | userspace mmap / dmabuf-mmap reader sees DMA data. Happens before the client can read: the buffer is only handed over by DQBUF |
| dma_buf CPU user | `DMA_BUF_IOCTL_SYNC` -> begin/end_cpu_access | exporter-side, for clients that mmap the dmabuf or re-read later |
| dma_buf importer (GPU) | `dma_map_sgtable` with SKIP_CPU_SYNC | relies on QBUF/DQBUF ownership: cache is clean after DQBUF as long as the CPU did not write |
Highmem: CMA at 0x76800000+ is highmem; kernel access is the vmap from `histb_dma_alloc_noncoherent`, `dma_sync_*` works on physical pages (arm `dma_cache_maint_page` kmaps), userspace uses `remap_pfn_range` on the pfn, so no vaddr needed. [read]

## Risks
- Not run on hardware. [inferred] correctness rests on ARM `arch_sync_dma_*` semantics; the A/B test below is the proof.
- CPU-written frames (VPSS-failure CPU fallback, VC-1 range map) leave DIRTY lines in a cacheable buffer, and DQBUF only invalidates (a dirty line then is dropped, losing the CPU's write if userspace uses a separate uncached alias; with the cacheable mapping userspace sees the line, but a GPU importer would not). Those paths are rare; if they matter, use `dma_sync_single_for_device(TO_DEVICE)` after the fallback write.
- `finish` invalidates the whole buffer (3 MB 1080p) per frame: [inferred] about 1-3 ms, versus the old 60 ms uncached read.
- Importers on other devices must honour the SKIP_CPU_SYNC contract; a client that mmaps the dmabuf must use DMA_BUF_IOCTL_SYNC (GStreamer >= 1.24 does; [inferred]). Plain `mmap` of the V4L2 buffer needs nothing extra (DQBUF syncs).
- A client holding a mapping while the queue is released keeps the memory alive (refcount) instead of use-after-free. Unmapping late is therefore safe.

## Build / patch [tested]
- `make W=1 KBUILD_MODPOST_WARN=1 M=drivers/media/platform/hisilicon modules` in `himedia-kbuild-arm32:trixie` (tools/kbuild.sh, vdec-port tree): 0 errors, 0 compiler warnings, make_exit=0. Log `vdec-port/logs/cachedcap-modules.log`. modpost "unresolved" lines are the known missing-Module.symvers non-finding. `kernel-build-arm32/` untouched.
- `histb-vdec.ko` sha256 `ff24df89984450722df5e455af6e513558c31f82edad19cd648b09dbcdcdc0ec` (766,132 B), `histb-vpss.ko` unchanged `2d8bf8d2...c38b`.
- 0008 regenerated (`vdec-regen-core-patch.py` with core, vpss, dma.h); `scripts/himedia/vpss-fix-verify.sh`: APPLY-OK on pristine 6.18.55 + 0001-0007(+0009), VPSS-IDENTICAL, VDEC-IDENTICAL. Backups: `vdec-port/0008.pre-cachedcap`, `vdec-port/histb-vdec-core.c.pre-cachedcap`.

## Hardware test (to run on the board, module vermagic must match k14)
```
rmmod histb_vdec; insmod histb-vdec.ko capture_cached=0   # baseline (old coherent)
time gst-launch-1.0 -q filesrc location=/root/h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! fakevideosink sync=false
rmmod histb_vdec; insmod histb-vdec.ko capture_cached=1   # (or just default)
time gst-launch-1.0 -q filesrc location=/root/h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! fakevideosink sync=false
```
(histb-vpss stays loaded; the param is also at /sys/module/histb_vdec/parameters/capture_cached, applied at next REQBUFS.) Expect: before 7 fps (39.5 s user for 300 frames), after memory-speed videoconvert (target well under 5 s user; [inferred] the SW-decode figure of ~3 s/300 frames is the ceiling).
Frame check, for each setting:
```
gst-launch-1.0 -q filesrc location=/root/h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! pngenc snapshot=false ! multifilesink location=/tmp/f%03d.png   # or: ... ! videoconvert ! video/x-raw,format=RGB ! ... num-buffers=151
```
Then copy frame index 150 (frame 150, `00:00:05.000 / 150`) and compare with `archive/20261011-q10-hwdec-h264-720p-frame150-vpssfix.png`: `magick compare -metric AE a.png b.png null:` expect 0 (identical; H.264 decode is deterministic and videoconvert is the same). Also run with 1080p `fakesink` (crop copy path, was 15 fps / 60 ms per frame) and confirm it recovers.
Failure signature to watch: stale/old-frame tearing or green stripes with capture_cached=1 but not 0 = missing invalidate.
