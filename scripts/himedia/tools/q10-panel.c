/*
 * q10-panel — drive the Q10 Pro front panel (Titan Micro TM1629A, 3-wire) from userspace.
 *
 * Pins (stock kernel disassembly, docs/261011-himedia-hud-ir-research.md): GPIO2_0 = STB,
 * GPIO2_3 = DIO, GPIO2_4 = CLK on the PL061 at 0xf8b22000. Bit-banged through /dev/mem: the
 * TM16xx serial bus has no minimum clock, so a slow bang is always correct.
 * Protocol (TM16xx family): STB low frames a command; bytes LSB-first; DIO sampled on CLK rise.
 *   0x40 write display RAM (auto-increment)   0x44 fixed address   0x42 read key-scan (4 bytes)
 *   0xC0|addr set address (16 bytes of display RAM: 8 grids x SEG1-8, SEG9-16)
 *   0x80|0x08|brightness(0-7) display on      0x80 display off
 *
 *   q10-panel keys            read the 4 key-scan bytes (chip present + idle => all 0x00;
 *                             no chip / wrong pins => 0xff from the pull-up)
 *   q10-panel all [bright]    light every segment (find the digits by eye)
 *   q10-panel raw b0 .. b15   write 16 display bytes (hex)
 *   q10-panel off             display off
 *   q10-panel text "HELLO" [b] show up to 6 characters (16-segment font, calibrated by photo)
 *   q10-panel clock [b]       run forever: local time HHMMSS (q10-hud.service)
 * Build on the box: gcc -O2 -o /usr/local/sbin/q10-panel q10-panel.c
 */
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#define GPIO2_BASE 0xf8b22000UL
#define STB 0
#define DIO 3
#define CLK 4

static volatile uint32_t *g;

static void dly(void) { struct timespec t = {0, 2000}; nanosleep(&t, NULL); }
static void pin(int n, int v) { g[(1u << n)] = v ? (1u << n) : 0; }	/* PL061: addr bits [9:2] mask */
static int  get(int n) { return (g[(1u << n)] >> n) & 1; }
static void dir_out(int n, int out)
{
	uint32_t d = g[0x400 / 4];
	g[0x400 / 4] = out ? (d | (1u << n)) : (d & ~(1u << n));
}

static void tx(uint8_t b)
{
	for (int i = 0; i < 8; i++) {
		pin(CLK, 0); pin(DIO, (b >> i) & 1); dly();
		pin(CLK, 1); dly();
	}
}

static uint8_t rx(void)
{
	uint8_t b = 0;
	for (int i = 0; i < 8; i++) {
		pin(CLK, 0); dly(); dly();
		pin(CLK, 1); dly();
		b |= get(DIO) << i;
	}
	return b;
}

static void cmd(uint8_t c) { pin(STB, 0); dly(); tx(c); pin(STB, 1); dly(); }

/*
 * The Q10 Pro front panel is a VFD with SIX 16-segment characters (plus icons), driven by the
 * TM1629A in the STANDARD layout: character k = GRID k+1 = display RAM bytes 2k (SEG1-8) and
 * 2k+1 (SEG9-16), one 16-bit word per character. Bit -> segment, CALIBRATED BY PHOTO on the box
 * (2026-10-11, tests A-D: one bit per character, read off the glass):
 *   0 A1  1 A2  2 B  3 C  4 D  5 D  6 E  7 F  8 H(upper diag/stroke)  9 I(upper)  10 J(upper)
 *   11 G1  12 G2  13 K(lower-left diag)  14 L(lower centre)  15 M(lower diag)
 * A-G are certain (digits use only those); 8-10 and 13-15 are read from blurry photos.
 * The disassembly's "transposed 7-segment" layout (docs/261011-himedia-hud-segment-map.md) is
 * the stock driver's GENERIC path and does NOT match this glass.
 */
#define S_A  0x0003
#define S_B  0x0004
#define S_C  0x0008
#define S_D  0x0030
#define S_E  0x0040
#define S_F  0x0080
#define S_H  0x0100
#define S_I  0x0200
#define S_J  0x0400
#define S_G1 0x0800
#define S_G2 0x1000
#define S_G  (S_G1 | S_G2)
#define S_K  0x2000
#define S_L  0x4000
#define S_M  0x8000
#define NCHARS 6

static uint16_t glyph(char c)
{
	static const uint16_t digit[10] = {
		S_A|S_B|S_C|S_D|S_E|S_F, S_B|S_C, S_A|S_B|S_G|S_E|S_D, S_A|S_B|S_G|S_C|S_D,
		S_F|S_G|S_B|S_C, S_A|S_F|S_G|S_C|S_D, S_A|S_F|S_G|S_E|S_D|S_C, S_A|S_B|S_C,
		S_A|S_B|S_C|S_D|S_E|S_F|S_G, S_A|S_B|S_C|S_D|S_F|S_G,
	};
	static const struct { char c; uint16_t g; } alpha[] = {
		{'A', S_A|S_B|S_C|S_E|S_F|S_G}, {'B', S_A|S_B|S_C|S_D|S_I|S_L|S_G2},
		{'C', S_A|S_D|S_E|S_F}, {'D', S_A|S_B|S_C|S_D|S_I|S_L}, {'E', S_A|S_D|S_E|S_F|S_G1},
		{'F', S_A|S_E|S_F|S_G1}, {'G', S_A|S_C|S_D|S_E|S_F|S_G2}, {'H', S_B|S_C|S_E|S_F|S_G},
		{'I', S_A|S_D|S_I|S_L}, {'J', S_B|S_C|S_D|S_E}, {'K', S_E|S_F|S_G1|S_J|S_M},
		{'L', S_D|S_E|S_F}, {'M', S_B|S_C|S_E|S_F|S_H|S_J}, {'N', S_B|S_C|S_E|S_F|S_H|S_M},
		{'O', S_A|S_B|S_C|S_D|S_E|S_F}, {'P', S_A|S_B|S_E|S_F|S_G}, {'Q', S_A|S_B|S_C|S_D|S_E|S_F|S_M},
		{'R', S_A|S_B|S_E|S_F|S_G|S_M}, {'S', S_A|S_C|S_D|S_F|S_G}, {'T', S_A|S_I|S_L},
		{'U', S_B|S_C|S_D|S_E|S_F}, {'V', S_E|S_F|S_K|S_J}, {'W', S_B|S_C|S_E|S_F|S_K|S_M},
		{'X', S_H|S_J|S_K|S_M}, {'Y', S_H|S_J|S_L}, {'Z', S_A|S_D|S_J|S_K},
		{'-', S_G}, {'_', S_D}, {'=', S_G|S_D}, {'*', S_G|S_H|S_I|S_J|S_K|S_L|S_M},
	};
	if (c >= '0' && c <= '9')
		return digit[c - '0'];
	if (c >= 'a' && c <= 'z')
		c -= 32;
	for (unsigned i = 0; i < sizeof alpha / sizeof alpha[0]; i++)
		if (alpha[i].c == c)
			return alpha[i].g;
	return 0;
}

static void encode(const char *text, int colon, uint8_t ram[16])
{
	(void)colon;		/* the colon/icon bits are not mapped yet */
	memset(ram, 0, 16);
	for (int k = 0; k < NCHARS && text[k]; k++) {
		uint16_t g = glyph(text[k]);
		ram[2 * k] = g & 0xff;
		ram[2 * k + 1] = g >> 8;
	}
}

/* The stock write: 0x00 (mode), 0x40 (auto-increment), 0xC0 + RAM, 0x03, display on. */
static void show(const uint8_t ram[16], int bright)
{
	cmd(0x00);
	cmd(0x40);
	pin(STB, 0); dly(); tx(0xC0);
	for (int i = 0; i < 16; i++) tx(ram[i]);
	pin(STB, 1); dly();
	cmd(0x03);
	cmd(0x88 | (bright & 7));
}

int main(int argc, char **argv)
{
	int fd = open("/dev/mem", O_RDWR | O_SYNC);
	if (fd < 0) { perror("/dev/mem"); return 1; }
	g = mmap(NULL, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, GPIO2_BASE);
	if (g == MAP_FAILED) { perror("mmap"); return 1; }
	const char *op = argc > 1 ? argv[1] : "keys";

	pin(STB, 1); pin(CLK, 1); pin(DIO, 1);
	dir_out(STB, 1); dir_out(CLK, 1); dir_out(DIO, 1);
	printf("gpio2 dir=0x%02x data=0x%02x\n", g[0x400 / 4] & 0xff, g[0x3fc / 4] & 0xff);

	if (!strcmp(op, "keys")) {
		pin(STB, 0); dly(); tx(0x42); dir_out(DIO, 0); dly(); dly();
		uint8_t k[4];
		for (int i = 0; i < 4; i++) k[i] = rx();
		pin(STB, 1); dir_out(DIO, 1);
		printf("keys: %02x %02x %02x %02x\n", k[0], k[1], k[2], k[3]);
		return 0;
	}
	if (!strcmp(op, "probe")) {
		/* Is DIO really wired to this GPIO? Drive it, release it, read at once: a connected
		 * line holds its charge for microseconds (or is pulled), an unmuxed pad reads 0. */
		for (int v = 1; v >= 0; v--) {
			pin(DIO, v); dir_out(DIO, 1); dly();
			dir_out(DIO, 0);
			int r0 = get(DIO); dly(); int r1 = get(DIO);
			struct timespec t = {0, 5000000}; nanosleep(&t, NULL);
			int r2 = get(DIO);
			printf("drove DIO=%d -> released: read %d at once, %d after 2us, %d after 5ms\n", v, r0, r1, r2);
		}
		dir_out(DIO, 1); pin(DIO, 1);
		return 0;
	}
	if (!strcmp(op, "off")) { cmd(0x80); puts("display off"); return 0; }
	if (!strcmp(op, "text") && argc > 2) {
		uint8_t ram[16];
		char t[8] = {0};
		int colon = 0, j = 0;
		for (const char *p = argv[2]; *p && j < NCHARS; p++) {
			if (*p == ':') colon = 1; else t[j++] = *p;
		}
		encode(t, colon, ram);
		show(ram, argc > 3 ? atoi(argv[3]) : 2);
		printf("text \"%s\"%s\n", t, colon ? " with colon" : "");
		return 0;
	}
	if (!strcmp(op, "clock")) {
		/* Local time HHMMSS on the six characters — the box's front-panel clock. */
		for (;;) {
			time_t now = time(NULL);
			struct tm tm;
			char t[8];
			uint8_t ram[16];
			localtime_r(&now, &tm);
			snprintf(t, sizeof t, "%02d%02d%02d", tm.tm_hour, tm.tm_min, tm.tm_sec);
			encode(t, now & 1, ram);
			show(ram, argc > 2 ? atoi(argv[2]) : 2);
			sleep(1);
		}
	}

	uint8_t ram[16];
	int bright = 7;
	if (!strcmp(op, "all")) {
		memset(ram, 0xff, sizeof ram);
		if (argc > 2) bright = atoi(argv[2]) & 7;
	} else if (!strcmp(op, "raw") && argc >= 18) {
		for (int i = 0; i < 16; i++) ram[i] = (uint8_t)strtoul(argv[2 + i], NULL, 16);
	} else {
		fprintf(stderr, "usage: q10-panel keys | all [0-7] | raw b0..b15 | text STR [b] | clock [b] | off\n");
		return 2;
	}
	cmd(0x40);
	pin(STB, 0); dly(); tx(0xC0);
	for (int i = 0; i < 16; i++) tx(ram[i]);
	pin(STB, 1); dly();
	cmd(0x88 | bright);
	printf("wrote 16 bytes, display on (brightness %d)\n", bright);
	return 0;
}
