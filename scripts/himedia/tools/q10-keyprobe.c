/*
 * q10-keyprobe — find where the Q10 Pro front-panel TOUCH keys arrive, from userspace, with no
 * kernel driver. RUNS ON THE BOX (mainline, root, /dev/mem). Read docs/261011-himedia-touchkeys.md.
 *
 * Why these two probes: the stock 3.18 kernel has NO key-scan code for this panel — both the
 * TM1629 and TM1628 keyled drivers stub every KEY_* op (docs, "Stock evidence") and no userspace
 * daemon reads GPIO or GPIO-I2C. The only live key input in stock Android is /dev/hi_ir, fed by
 * the IR block at 0xf8001000 and turned into keys by android_ir_user + /etc/key.xml. So the
 * leading hypothesis is that the TCH68 touch board emits IR-protocol frames into the IR line.
 *
 *   q10-keyprobe ir   [secs]   IR block in raw-symbol mode, poll the symbol FIFO, print each
 *                              symbol (low/high us) and an NEC decode (addr, cmd, mainline
 *                              scancode, stock key name for address 0x10).
 *   q10-keyprobe gpio [secs]   tight-loop sample every GPIO bank DATA register (all 13 PL061s)
 *                              and print every edge with a microsecond timestamp — catches
 *                              pulse trains the 1 Hz devmem watch (gpio-watch.sh) cannot.
 *
 * Safety: `ir` writes only the IR block and its clock gate (sysctrl 0xf8000048 bit4 on, bit5 =
 * reset released, exactly what the vendor ir_set_clk() does). Do NOT run it while a kernel IR
 * driver (ir-hix5hd2) is bound — check `ls /sys/class/rc` is empty. `gpio` only reads.
 * Build on the box: gcc -O2 -o /usr/local/sbin/q10-keyprobe q10-keyprobe.c
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static int memfd;
static volatile uint32_t *map(unsigned long phys)
{
	void *p = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, memfd, phys & ~0xfffUL);
	if (p == MAP_FAILED) { perror("mmap"); exit(1); }
	return (volatile uint32_t *)((char *)p + (phys & 0xfff));
}
static double now_us(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return t.tv_sec * 1e6 + t.tv_nsec / 1e3;
}

/* ---- IR block (vendor drv_ir_register.h; mainline ir-hix5hd2 uses the same map) ---- */
#define IR_BASE   0xf8001000UL
#define SC_CLK    0xf8000048UL		/* bit4 = IR clock enable, bit5 = IR soft reset */
#define IR_EN     (0x00 / 4)
#define IR_CFG    (0x04 / 4)
#define IR_BUSY   (0x1c / 4)
#define IR_DATAH  (0x20 / 4)		/* symbol mode: number of symbols in FIFO */
#define IR_DATAL  (0x24 / 4)		/* symbol: [15:0] low width, [31:16] high width, 10 us units */
#define IR_INTM   (0x28 / 4)
#define IR_INTS   (0x2c / 4)
#define IR_INTC   (0x30 / 4)
#define IR_START  (0x34 / 4)

/* Stock /etc/key.xml <himedia-key> commands for address 0x10 (the bundled remote). */
static const char *himedia_name(int cmd)
{
	static const struct { int c; const char *n; } t[] = {
		{0x45, "UP"}, {0x55, "DOWN"}, {0x07, "LEFT"}, {0x01, "RIGHT"}, {0x41, "ENTER"},
		{0x00, "BACK"}, {0x05, "MENU"}, {0x5d, "POWER"}, {0x7b, "POWER(alt)"}, {0x46, "HOME"},
	};
	for (unsigned i = 0; i < sizeof t / sizeof t[0]; i++)
		if (t[i].c == cmd) return t[i].n;
	return "?";
}

static int near(int v, int want) { return v > want * 7 / 10 && v < want * 13 / 10; }

static void nec_feed(int lo, int hi)
{
	static int nbits = -1;
	static uint32_t bits;
	if (near(lo, 9000) && near(hi, 4500)) { nbits = 0; bits = 0; return; }
	if (near(lo, 9000) && near(hi, 2250)) { printf("    NEC repeat\n"); nbits = -1; return; }
	if (nbits < 0) return;
	if (!near(lo, 560)) { nbits = -1; return; }
	if (near(hi, 1690)) bits |= 1u << nbits;
	else if (!near(hi, 560)) { nbits = -1; return; }	/* bit 32 is followed by a stop pulse */
	if (++nbits == 32) {
		int a = bits & 0xff, na = (bits >> 8) & 0xff, c = (bits >> 16) & 0xff, nc = bits >> 24;
		int std = ((a ^ na) == 0xff), cok = ((c ^ nc) == 0xff);
		unsigned sc = std ? (a << 8 | c) : (a << 16 | na << 8 | c);
		printf("    NEC raw 0x%08x  addr 0x%02x/0x%02x cmd 0x%02x%s  mainline scancode 0x%x  %s\n",
		       bits, a, na, c, cok ? "" : " (cmd check FAIL)", sc,
		       a == 0x10 && std ? himedia_name(c) : "(not the stock remote address)");
		nbits = -1;
	}
}

static int run_ir(int secs)
{
	volatile uint32_t *clk = map(SC_CLK), *ir = map(IR_BASE);
	printf("sysctrl 0x48 before: 0x%08x\n", *clk);
	*clk = (*clk | 0x10) & ~0x20u;
	usleep(1000);
	ir[IR_EN] = 1;
	for (int i = 0; (ir[IR_BUSY] & 1) && i < 1000; i++) usleep(100);
	/* symbol mode: max symbol width 0x3e80 <<16 | format 0 <<14 | 1 symbol threshold <<8 |
	 * mode symbol <<7 | 24 MHz -> freq field 23. Same fields as vendor ir_config(). */
	ir[IR_CFG] = (0x3e80u << 16) | (0 << 14) | (1 << 8) | (1 << 7) | 23;
	ir[IR_INTM] = 0xffffffff;	/* no IRQ: nothing in this kernel handles it */
	ir[IR_INTC] = 0xffffffff;
	ir[IR_START] = 1;
	printf("IR cfg=0x%08x en=%u — press the TOUCH keys now (and one remote key as a control)\n",
	       ir[IR_CFG], ir[IR_EN]);
	double end = now_us() + secs * 1e6;
	while (now_us() < end) {
		uint32_t n = ir[IR_DATAH];
		for (uint32_t i = 0; i < n && i < 256; i++) {
			uint32_t v = ir[IR_DATAL];
			int lo = (v & 0xffff) * 10, hi = (v >> 16) * 10;
			printf("%12.0f us  sym low %6d us  high %6d us\n", now_us(), lo, hi);
			nec_feed(lo, hi);
		}
		if (ir[IR_INTS]) ir[IR_INTC] = 0xffffffff;
		usleep(2000);
	}
	return 0;
}

/* ---- every GPIO bank, as fast as /dev/mem allows ---- */
static int run_gpio(int secs)
{
	static const unsigned long base[13] = {
		0xf8b20000, 0xf8b21000, 0xf8b22000, 0xf8b23000, 0xf8b24000, 0xf8004000, 0xf8b26000,
		0xf8b27000, 0xf8b28000, 0xf8b29000, 0xf8b2a000, 0xf8b2b000, 0xf8b2c000,
	};
	volatile uint32_t *g[13];
	uint8_t last[13];
	for (int b = 0; b < 13; b++) {
		g[b] = map(base[b]);
		last[b] = g[b][0x3fc / 4] & 0xff;
		printf("gpio%-2d dir 0x%02x data 0x%02x\n", b, g[b][0x400 / 4] & 0xff, last[b]);
	}
	double t0 = now_us(), end = t0 + secs * 1e6;
	unsigned long sweeps = 0;
	while (1) {
		for (int b = 0; b < 13; b++) {
			uint8_t v = g[b][0x3fc / 4] & 0xff;
			if (v != last[b]) {
				printf("%12.1f us  gpio%d 0x%02x -> 0x%02x  (bits 0x%02x)\n",
				       now_us() - t0, b, last[b], v, last[b] ^ v);
				last[b] = v;
			}
		}
		if ((++sweeps & 0xfff) == 0 && now_us() > end) break;
	}
	printf("%lu sweeps in %d s = %.1f us per sweep of 13 banks\n", sweeps, secs,
	       secs * 1e6 / sweeps);
	return 0;
}

int main(int argc, char **argv)
{
	memfd = open("/dev/mem", O_RDWR | O_SYNC);
	if (memfd < 0) { perror("/dev/mem"); return 1; }
	setvbuf(stdout, NULL, _IOLBF, 0);
	int secs = argc > 2 ? atoi(argv[2]) : 20;
	if (argc > 1 && !strcmp(argv[1], "ir")) return run_ir(secs);
	if (argc > 1 && !strcmp(argv[1], "gpio")) return run_gpio(secs);
	fprintf(stderr, "usage: q10-keyprobe ir|gpio [seconds]\n");
	return 2;
}
