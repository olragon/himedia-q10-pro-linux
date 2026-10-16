/* dmabuf-mmap-test.c <drm-node> — create a 1920x1080 XRGB dumb buffer, export it as a dma-buf (with and without
 * O_RDWR) and try to mmap it PROT_READ|PROT_WRITE, the way Chromium's libyuv image processor maps its AR24 pool
 * frames. Build on the box: gcc -O1 -I/usr/include/drm dmabuf-mmap-test.c -o dmabuf-mmap-test */
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
#include <drm.h>
#include <drm_mode.h>
int main(int argc, char **argv)
{
	int fd = open(argc > 1 ? argv[1] : "/dev/dri/card2", O_RDWR | O_CLOEXEC);
	struct drm_mode_create_dumb c = { .width = 1920, .height = 1080, .bpp = 32 };
	if (fd < 0) { perror("open"); return 1; }
	if (ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &c)) { perror("create_dumb"); return 1; }
	printf("dumb handle %u pitch %u size %llu\n", c.handle, c.pitch, (unsigned long long)c.size);
	unsigned flags[2] = { DRM_CLOEXEC, DRM_CLOEXEC | DRM_RDWR };
	for (int i = 0; i < 2; i++) {
		/* a fresh buffer each time: PRIME caches the first dma-buf of a handle, flags and all */
		if (i && ioctl(fd, DRM_IOCTL_MODE_CREATE_DUMB, &c)) { perror("create_dumb"); return 1; }
		struct drm_prime_handle h = { .handle = c.handle, .flags = flags[i] };
		if (ioctl(fd, DRM_IOCTL_PRIME_HANDLE_TO_FD, &h)) { perror("prime"); continue; }
		char path[64], line[128];
		snprintf(path, sizeof(path), "/proc/self/fdinfo/%d", h.fd);
		FILE *f = fopen(path, "r");
		while (f && fgets(line, sizeof(line), f))
			if (!strncmp(line, "flags:", 6)) printf("  fd %s", line);
		if (f) fclose(f);
		void *p = mmap(NULL, c.size, PROT_READ | PROT_WRITE, MAP_SHARED, h.fd, 0);
		printf("export flags %#x: mmap RW -> %s\n", flags[i], p == MAP_FAILED ? strerror(errno) : "ok");
		if (p != MAP_FAILED) { memset(p, 0x55, c.size); munmap(p, c.size); }
		void *q = mmap(NULL, c.size, PROT_READ, MAP_SHARED, h.fd, 0);
		printf("export flags %#x: mmap R  -> %s\n", flags[i], q == MAP_FAILED ? strerror(errno) : "ok");
	}
	return 0;
}
