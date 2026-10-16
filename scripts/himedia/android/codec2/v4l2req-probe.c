/* v4l2req-probe: decode an Annex-B H.264/HEVC elementary stream through FFmpeg's v4l2request
 * hwaccel from INSIDE Android's bionic + the Waydroid container, so step 1 of the plan
 * (can the container reach /dev/media0 + /dev/video0 and does the udev-free probe find them?)
 * is answered before any codec2 code exists.   docs/261012-himedia-android-hw-video.md
 *
 *   build : scripts/himedia/android/codec2/build-probe.sh
 *   run   : (in the container, as root)  v4l2req-probe <h264|hevc> clip.h264 [--crc] [--copy]
 *   exit  : 0 = hw decode produced frames, 2 = no hw device / hw not used, 3 = decode error
 *
 * Prints one line per run:  frames=N hw=1 fmt=drm_prime|nv12 ms=T fps=F [crc=XXXXXXXX]
 * Reporting rule (CLAUDE.md): exit 0 is not proof — hw=1 requires frame->format == DRM_PRIME.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <libavcodec/avcodec.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libavutil/adler32.h>

static double now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s h264|hevc file [--crc] [--copy]\n", argv[0]); return 1; }
    enum AVCodecID id = !strcmp(argv[1], "hevc") ? AV_CODEC_ID_HEVC : AV_CODEC_ID_H264;
    int want_crc = 0, copy = 0;
    for (int i = 3; i < argc; i++) { if (!strcmp(argv[i], "--crc")) want_crc = 1; if (!strcmp(argv[i], "--copy")) copy = 1; }

    FILE *f = fopen(argv[2], "rb");
    if (!f) { perror("open clip"); return 1; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *buf = malloc(sz + AV_INPUT_BUFFER_PADDING_SIZE);
    if (fread(buf, 1, sz, f) != (size_t)sz) { perror("read"); return 1; }
    memset(buf + sz, 0, AV_INPUT_BUFFER_PADDING_SIZE);
    fclose(f);

    const AVCodec *codec = avcodec_find_decoder(id);
    AVCodecContext *ctx = avcodec_alloc_context3(codec);
    AVCodecParserContext *parser = av_parser_init(id);
    AVBufferRef *hw = NULL;
    int err = av_hwdevice_ctx_create(&hw, AV_HWDEVICE_TYPE_V4L2REQUEST, NULL, NULL, 0);
    if (err < 0) { fprintf(stderr, "no v4l2request hw device: %s\n", av_err2str(err)); return 2; }
    ctx->hw_device_ctx = av_buffer_ref(hw);
    ctx->thread_count = 1;
    if (avcodec_open2(ctx, codec, NULL) < 0) { fprintf(stderr, "avcodec_open2 failed\n"); return 3; }

    AVPacket *pkt = av_packet_alloc();
    AVFrame *frame = av_frame_alloc(), *dst = av_frame_alloc();
    long frames = 0, hwframes = 0; uint32_t crc = 0; const char *fmtname = "?";
    double t0 = now_ms();
    uint8_t *p = buf; long left = sz; int flush = 0;
    while (!flush) {
        if (left > 0) {
            int n = av_parser_parse2(parser, ctx, &pkt->data, &pkt->size, p, left, AV_NOPTS_VALUE, AV_NOPTS_VALUE, 0);
            p += n; left -= n;
        } else { pkt->data = NULL; pkt->size = 0; flush = 1; }
        if (pkt->size > 0 || flush) {
            if (avcodec_send_packet(ctx, flush ? NULL : pkt) < 0 && !flush) { fprintf(stderr, "send_packet failed\n"); return 3; }
            for (;;) {
                int r = avcodec_receive_frame(ctx, frame);
                if (r == AVERROR(EAGAIN) || r == AVERROR_EOF) break;
                if (r < 0) { fprintf(stderr, "receive_frame: %s\n", av_err2str(r)); return 3; }
                frames++;
                fmtname = av_get_pix_fmt_name(frame->format);
                if (frame->format == AV_PIX_FMT_DRM_PRIME) hwframes++;
                if ((want_crc || copy) && frame->format == AV_PIX_FMT_DRM_PRIME) {
                    dst->format = AV_PIX_FMT_NV12;           /* CPU readback = what ffmpeg_codec2 does today */
                    if (av_hwframe_transfer_data(dst, frame, 0) < 0) { fprintf(stderr, "transfer failed\n"); return 3; }
                    if (want_crc && frames == 30) {
                        for (int pl = 0; pl < 2; pl++) {
                            int h = pl ? dst->height / 2 : dst->height;
                            for (int y = 0; y < h; y++) crc = av_adler32_update(crc, dst->data[pl] + y * dst->linesize[pl], dst->width);
                        }
                    }
                    av_frame_unref(dst);
                }
                av_frame_unref(frame);
            }
        }
    }
    double ms = now_ms() - t0;
    printf("frames=%ld hw=%d fmt=%s ms=%.0f fps=%.1f", frames, hwframes == frames && frames > 0, fmtname, ms, frames * 1000.0 / ms);
    if (want_crc) printf(" crc30=%08x", crc);
    printf("\n");
    return hwframes == frames && frames > 0 ? 0 : 2;
}
