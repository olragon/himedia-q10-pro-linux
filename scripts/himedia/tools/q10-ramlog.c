/*
 * q10-ramlog [--clear] — read (or reset) the RAM "UART" ring a --ramlog test kernel writes
 * (kernel/arm32/debug/q10ramlog.S): word 0 = bytes written, ring at +0x800 (2 KiB).
 * Uses mmap of /dev/mem: the page is highmem on this box, where read() of /dev/mem refuses.
 * Build on the box: gcc -O2 -o /usr/local/sbin/q10-ramlog q10-ramlog.c
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define RAMLOG_PHYS 0x7a87f000UL

int main(int argc, char **argv)
{
	int fd = open("/dev/mem", O_RDWR | O_SYNC);
	volatile uint8_t *p;
	uint32_t n, i, start;

	if (fd < 0) { perror("/dev/mem"); return 1; }
	p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, RAMLOG_PHYS);
	if (p == MAP_FAILED) { perror("mmap"); return 1; }
	if (argc > 1 && !strcmp(argv[1], "--clear")) {
		for (i = 0; i < 4096; i++) p[i] = 0;
		printf("ramlog cleared\n");
		return 0;
	}
	n = *(volatile uint32_t *)p;
	printf("=== ramlog: %u bytes written%s ===\n", n, n > 0x800 ? " (ring wrapped; last 2048 shown)" : "");
	start = n > 0x800 ? n - 0x800 : 0;
	for (i = start; i < n; i++) {
		uint8_t c = p[0x800 + (i & 0x7ff)];
		if (c != '\r') putchar(c);
	}
	putchar('\n');
	return 0;
}
