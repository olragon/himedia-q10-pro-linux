/* gbm-mmap-test.c <drm-node> [flags] — allocate a 1920x1080 AR24 buffer through libgbm on <drm-node> and try
 * to mmap the exported dma-buf RW, like Chromium's pool frames. gcc gbm-mmap-test.c -o gbm-mmap-test -lgbm */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <errno.h>
#include <sys/mman.h>
struct gbm_device; struct gbm_bo;
struct gbm_device *gbm_create_device(int fd);
struct gbm_bo *gbm_bo_create(struct gbm_device *, unsigned, unsigned, unsigned, unsigned);
int gbm_bo_get_fd(struct gbm_bo *);
unsigned gbm_bo_get_stride(struct gbm_bo *);
int main(int argc, char **argv)
{
	int fd = open(argv[1], O_RDWR | O_CLOEXEC);
	unsigned flags = argc > 2 ? strtoul(argv[2], 0, 0) : 4 | 16;
	struct gbm_device *d = fd < 0 ? NULL : gbm_create_device(fd);
	if (!d) { perror("gbm device"); return 1; }
	struct gbm_bo *bo = gbm_bo_create(d, 1920, 1080, 0x34325241, flags);
	if (!bo) { printf("gbm_bo_create(flags %#x) failed\n", flags); return 1; }
	int pfd = gbm_bo_get_fd(bo);
	void *p = mmap(NULL, 1920 * 1080 * 4, PROT_READ | PROT_WRITE, MAP_SHARED, pfd, 0);
	printf("%s flags %#x stride %u: mmap RW -> %s\n", argv[1], flags, gbm_bo_get_stride(bo),
	       p == MAP_FAILED ? strerror(errno) : "ok");
	return 0;
}
