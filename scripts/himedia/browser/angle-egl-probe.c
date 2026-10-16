/* angle-egl-probe.c [angle-type-hex] — what does Chromium's ANGLE expose on this box? Loads /usr/lib/chromium/libEGL.so,
 * creates an ANGLE display on the X11 default display (type 0x320D OPENGLES, 0x3208 OPENGL, 0x3209 ...) and prints the
 * EGL extensions, so "supports_nv12_gl_native_pixmap" (needs EGL_EXT_image_dma_buf_import) can be checked without Chromium.
 * Build: gcc angle-egl-probe.c -o angle-egl-probe -ldl /usr/lib/arm-linux-gnueabihf/libX11.so.6 */
#include <stdio.h>
#include <stdlib.h>
#include <dlfcn.h>
void *XOpenDisplay(const char *);
typedef void *(*gpd_t)(unsigned, void *, const int *);
typedef int (*init_t)(void *, int *, int *);
typedef const char *(*qs_t)(void *, int);
int main(int argc, char **argv)
{
	void *h = dlopen("/usr/lib/chromium/libEGL.so", RTLD_NOW);
	if (!h) { printf("dlopen: %s\n", dlerror()); return 1; }
	gpd_t gpd = dlsym(h, "eglGetPlatformDisplayEXT"); if (!gpd) gpd = dlsym(h, "eglGetPlatformDisplay");
	init_t init = dlsym(h, "eglInitialize");
	qs_t qs = dlsym(h, "eglQueryString");
	void *xd = XOpenDisplay(NULL);
	int type = argc > 1 ? strtol(argv[1], 0, 16) : 0x320D;
	int attr[] = { 0x3203, type, 0x3038 };
	void *d = gpd(0x3202, xd, attr);
	int ma, mi;
	printf("display %p type %#x\n", d, type);
	if (!d || !init(d, &ma, &mi)) { printf("eglInitialize failed\n"); return 1; }
	printf("EGL %d.%d\n%s\n", ma, mi, qs(d, 0x3055));
	return 0;
}
