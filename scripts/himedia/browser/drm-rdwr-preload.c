/* drm-rdwr-preload.c — LD_PRELOAD shim for Chromium on the Q10: make every DRM PRIME export read-write.
 *
 * Mesa's libgbm exports gbm bo dma-bufs as DRM_CLOEXEC only (O_RDONLY file), and Chromium's LibYUV image
 * processor (the path it takes for hardware-decoded NV12 when the X11 GL stack cannot import NV12) then
 * mmap()s its AR24 pool frames PROT_READ|PROT_WRITE: EACCES, "Failed to map output FrameResource",
 * "ImageProcessor error", software decode. Adding DRM_RDWR to DRM_IOCTL_PRIME_HANDLE_TO_FD is exactly
 * what the exporter is allowed to ask for. Scoped to Chromium's process tree via /etc/chromium.d, never global.
 * Build: gcc -shared -fPIC -O2 -o drm-rdwr-preload.so drm-rdwr-preload.c -ldl */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <sys/ioctl.h>

#define DRM_IOCTL_PRIME_HANDLE_TO_FD_NR 0xc00c642dUL /* _IOWR('d', 0x2d, struct drm_prime_handle{u32,u32,s32}) */
#define DRM_RDWR 02

struct prime_handle { uint32_t handle, flags; int32_t fd; };

int ioctl(int fd, unsigned long req, ...)
{
	static int (*real)(int, unsigned long, ...);
	va_list ap;
	void *arg;

	if (!real)
		real = (int (*)(int, unsigned long, ...))dlsym(RTLD_NEXT, "ioctl");
	va_start(ap, req);
	arg = va_arg(ap, void *);
	va_end(ap);
	if (req == DRM_IOCTL_PRIME_HANDLE_TO_FD_NR && arg)
		((struct prime_handle *)arg)->flags |= DRM_RDWR;
	return real(fd, req, arg);
}
