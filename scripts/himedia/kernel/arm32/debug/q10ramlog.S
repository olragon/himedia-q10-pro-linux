/* SPDX-License-Identifier: GPL-2.0 */
/*
 * q10ramlog — a DEBUG_LL "UART" that is a ring in RAM (HiMedia Q10 Pro bring-up, 2026-10-11).
 *
 * Installed OVER arch/arm/include/debug/pl01x.S by `build-kernel-arm32.ts --ramlog` (restored
 * pristine on every other build). With EARLY_PRINTK + `earlyprintk` on the command line, every
 * printk from setup_arch onwards lands here. The page is the tail of ramoops' dmesg zone 3
 * (0x7a87f000), which the base kernel reserves and never writes unless it oopses, and DRAM
 * survives the SP805 warm reset — so a kexec'd test kernel that dies with no console leaves its
 * last ~2 KiB of log behind for `q10-ramlog` to read from the base kernel.
 *
 * Layout: word 0 = total bytes ever written; bytes 0x800..0xfff = ring (index = count & 0x7ff).
 * ⛔ senduart clobbers r2. Every caller in 6.18 (kernel/debug.S printascii/printch,
 * compressed/debug.S putc) uses r2 only as waituart/busyuart scratch or as the unused virtual
 * address, so this is safe there — re-check if another caller appears.
 */
#ifdef CONFIG_DEBUG_UART_PHYS
		.macro	addruart, rp, rv, tmp
		ldr	\rp, =CONFIG_DEBUG_UART_PHYS
		ldr	\rv, =CONFIG_DEBUG_UART_VIRT
		.endm
#endif

		.macro	senduart,rd,rx
		ldr	r2, [\rx]
		add	r2, r2, #1
		str	r2, [\rx]
		sub	r2, r2, #1
		lsl	r2, r2, #21		@ & 0x7ff — not an ARM immediate,
		lsr	r2, r2, #21		@ so mask with a shift pair
		add	r2, r2, #0x800
		strb	\rd, [\rx, r2]
		.endm

		.macro	waituartcts,rd,rx
		.endm

		.macro	waituarttxrdy,rd,rx
		.endm

		.macro	busyuart,rd,rx
		.endm
