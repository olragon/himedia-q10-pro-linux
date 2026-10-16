/*
 * A uImage that is not a kernel: 8 instructions whose only job is to reset the SoC.
 *
 * ⛔ The question it answers, which SIX build-and-boot rounds have all ASSUMED:
 * does the stock bootm actually jump into our image?
 *
 * Everything we have tested so far lives inside Linux, so every "frozen logo" was read as a
 * kernel bug. But a loader that silently refuses our image, or jumps somewhere wrong, produces
 * the identical observation — the vendor logo stays on screen because mainline has no display
 * driver to overwrite it either way. The two are indistinguishable from outside, and one of
 * them would mean none of the kernel work has ever been under test.
 *
 * ⭐ The signal needs no console, no network and no serial: arm the watchdog and spin. If our
 * code executes, the SoC resets a couple of seconds later and the box REBOOTS — which on HDMI
 * means the logo REDRAWS, over and over. A frozen logo means our code never ran.
 *
 * ARM SP805 (vendor DTB: watchdog@0xf8a2c000, "arm,sp805-wdt"), standard layout:
 *   +0x000 WdogLoad     counter reload value
 *   +0x008 WdogControl  bit0 INTEN (count+interrupt), bit1 RESEN (reset output)
 *   +0xC00 WdogLock     write 0x1ACCE551 to unlock, anything else to lock
 * The first timeout raises the interrupt; the second, uncleared, asserts reset. So the box
 * resets after TWO load periods, and we never clear it.
 *
 * bootm jumps with the MMU and caches off, so these are physical addresses and need no mapping.
 * r0/r1/r2 carry the Linux boot convention; we ignore them deliberately.
 */
	.text
	.arm
	.global _start
_start:
	ldr	r0, =0xf8a2c000		@ SP805 base
	ldr	r1, =0x1acce551		@ the magic unlock word
	str	r1, [r0, #0xc00]	@ WdogLock  <- unlock
	ldr	r1, =24000000		@ ~1 s at the 24 MHz APB clock
	str	r1, [r0, #0x000]	@ WdogLoad
	mov	r1, #3			@ INTEN | RESEN
	str	r1, [r0, #0x008]	@ WdogControl <- start counting
spin:
	b	spin			@ the reset is the only way out
