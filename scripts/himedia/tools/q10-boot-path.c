/*
 * q10-boot-path — did this boot come from a CHIP RESET (U-Boot) or a KEXEC?
 *
 * The ARM system counter keeps running across kexec but restarts at 0 on a SoC reset
 * (watchdog or power). Userspace may read CNTVCT (the kernel sets CNTKCTL.PL0VCTEN), so
 *   counter_seconds - uptime  ~= constant   after a chip reset,
 *   counter_seconds - uptime  >> constant   after kexec (it adds the previous kernel's lifetime).
 * The constant is not 0 on this box: the firmware leaves CNTVOFF at about -933 s (patch 0004).
 * Built 2026-10-11 to validate the kexec test loop (scripts/himedia/kexec-try.sh).
 * Build on the box: gcc -O2 -o /usr/local/sbin/q10-boot-path q10-boot-path.c
 */
#include <stdio.h>
#include <stdint.h>
#include <time.h>

static uint64_t cntvct(void)
{
	uint32_t lo, hi;
	__asm__ volatile("isb\n\tmrrc p15, 1, %0, %1, c14" : "=r"(lo), "=r"(hi));
	return ((uint64_t)hi << 32) | lo;
}

static uint32_t cntfrq(void)
{
	uint32_t f;
	__asm__ volatile("mrc p15, 0, %0, c14, c0, 0" : "=r"(f));
	return f;
}

int main(void)
{
	struct timespec up;
	uint32_t frq = cntfrq();
	double c, u;

	if (!frq)
		frq = 24000000;	/* the stock firmware never programs CNTFRQ (docs/261010-...) */
	clock_gettime(CLOCK_BOOTTIME, &up);
	c = (double)cntvct() / frq;
	u = up.tv_sec + up.tv_nsec / 1e9;
	printf("counter %.1f s  uptime %.1f s  counter-uptime %.1f s  (cntfrq %u)\n", c, u, c - u, frq);
	return 0;
}
