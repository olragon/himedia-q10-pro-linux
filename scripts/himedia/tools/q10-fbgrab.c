/*
 * q10-fbgrab > fb.raw — dump what the TV is showing: the VDP G0 scan-out buffer the boot logo,
 * simplefb/simpledrm and every desktop draw into (0x7b68c000, 1920x1080, 7680-byte stride,
 * ARGB8888 little-endian = BGRA bytes). Lets the bring-up verify graphics with no one at the TV:
 *   ssh root@q10 q10-fbgrab > fb.raw; ffmpeg -f rawvideo -pix_fmt bgra -s 1920x1080 -i fb.raw fb.png
 * The address is read from G0_ADDR at run time, so a later driver that moves the buffer still works.
 * Build on the box: gcc -O2 -o /usr/local/sbin/q10-fbgrab q10-fbgrab.c
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

int main(void)
{
	int fd = open("/dev/mem", O_RDONLY | O_SYNC);
	if (fd < 0) { perror("/dev/mem"); return 1; }
	volatile uint32_t *vdp = mmap(NULL, 0x8000, PROT_READ, MAP_SHARED, fd, 0xf8cc0000);
	if (vdp == MAP_FAILED) { perror("mmap vdp"); return 1; }
	uint32_t addr = vdp[0x7010 / 4];
	uint32_t stride = (vdp[0x701c / 4] & 0xffff) * 16;
	uint32_t reso = vdp[0x7020 / 4];
	uint32_t w = (reso & 0xfff) + 1, h = ((reso >> 12) & 0xfff) + 1;
	fprintf(stderr, "G0 addr 0x%08x %ux%u stride %u\n", addr, w, h, stride);
	size_t len = (size_t)stride * h;
	uint8_t *fb = mmap(NULL, len, PROT_READ, MAP_SHARED, fd, addr);
	if (fb == MAP_FAILED) { perror("mmap fb"); return 1; }
	for (uint32_t y = 0; y < h; y++)
		if (fwrite(fb + (size_t)y * stride, 4, w, stdout) != w) return 1;
	return 0;
}
