# Q10 Pro — what the vendor device tree settles

**Date:** 2026-10-10
**Source:** `boot.img` @ `0x8b5220` (13,027 B) inside `update.zip` inside the stock
`Q10_PRO_v2.1.4_Android_7_31-05-2019` firmware. Extracted with `bun run himedia:inspect`.

## Why this mattered

Mainline's CRG driver does not define the SATA clocks, so the port could not proceed without
knowing *where those clocks live in hardware*. Guessing register offsets on a box whose rescue
path is already weak was not acceptable. The vendor's own device tree is the ground truth.

## The decisive result: the vendor's clock index IS the CRG register offset

The vendor device tree asks its clock controller for a single clock per controller:

| Controller | Address | IRQ | vendor `clocks = <&clk N>` |
|---|---|---|---|
| `hiahci` (SATA) | `0xf9900000` | `0x46` | **`0xa8`** (168) |
| `xhci0` (USB3 #0) | `0xf98a0000` | `0x45` | **`0xb0`** (176) |
| `xhci1` (USB3 #1) | `0xf98b0000` | `0x55` | **`0xbc`** (188) |

Independently, the reference NAS board's *mainline* device tree expresses the same hardware as
resets: `hiahci … resets = <&crg 0xa8 …>` and `xhci … resets = <&crg 0xb0 0xc>`.

⇒ For **SATA** two independent sources agree, so `0xa8` being the SATA control register in the
CRG is **confirmed rather than inferred**. Likewise `0xb0` for USB3 instance 0, which mainline
also corroborates (see below).

⛔ **But the general claim "the vendor index is always the register offset" is FALSE, and an
earlier draft of this doc asserted it.** Checked against mainline's `crg-hi3798cv200.c`:

- mainline puts **both** USB3 instances at register **`0xb0`** — instance 0 at bits 0/2/3/4 and
  instance 1 at bits **16/18/19/20**;
- mainline's **`0xbc`** is the **USB2 PHY reference** clocks (bits 0 and 2), not USB3 at all.

So the vendor's `0xbc` for `xhci1` does **not** correspond to a USB3 register. The vendor's
single `clk` index is an index into *its own* table, which happens to coincide with the register
offset in some cases and not others. Treat each one as needing corroboration — the SATA value
has it, `xhci1`'s does not.

The CRG itself is at `reg = <0xf8a22000 0x400  0xf8a20000 0x848>`, compatible
`"hi3798cv200.clock", "hisilicon,clock-reset"` — the same block mainline's
`crg-hi3798cv200.c` drives.

## Consequence 1 — USB 3.0 needs NO kernel patch, only the right node

Mainline already defines **two** sets of USB3 clocks: `HISTB_USB3_{BUS,UTMI,PIPE,SUSPEND}_CLK`
(43-46) and the same four with a `_CLK1` suffix (47-50). Those are the two controller instances.

⛔ **This box uses `xhci1`, not `xhci0`.** The runtime recon showed the live controller is
`f98b0000.xhci`, and the reference port's device tree uses `0x98a0000` — the *other* instance.
**Copying the reference node would have configured the controller that is not wired to the
physical USB 3.0 port**, and the symptom would have been a dead port with a clean boot.

⇒ Our node: `reg = <0x98b0000 0x10000>`, `interrupts = <0 0x55 4>`, and the **`_CLK1`** clocks —
`HISTB_USB3_BUS_CLK1` (47), `HISTB_USB3_UTMI_CLK1` (48), `HISTB_USB3_PIPE_CLK1` (49),
`HISTB_USB3_SUSPEND_CLK1` (50), which mainline registers as gates on `0xb0` bits 16, 20, 19, 18.

⭐ So nothing has to be guessed for USB 3.0: the driver, the clocks and the register bits are all
already upstream. Only the node is missing.

## Consequence 2 — SATA needs four new clocks, and now we know where

The work is bounded: add four clock ids to `include/dt-bindings/clock/histb-clock.h` and
register them in `drivers/clk/hisilicon/crg-hi3798cv200.c` as gates on **CRG offset `0xa8`**.

⚠️ **What is still not pinned down is the bit assignment within `0xa8`.** Mainline's CRG driver
has **no entry at `0xa8` at all** (verified by reading the gate table), so there is nothing
upstream to copy. The reference port's device tree places the four *resets* at bits
`0x8, 0x9, 0xa, 0xb` of that register, which makes the low bits the plausible home for the clock
gates — but that is an inference, not evidence, and must not be written as fact. The
authoritative source is the HiSTBLinux BSP's own clock table for `hi3798cv200.clock`, which is on
GitHub. Read it before writing the patch.

⭐ Useful precedent for the patch's shape: USB3 puts two instances in one register's low and high
halves. A SATA block with four gates in `0xa8` is entirely consistent with that style.

## Consequence 3 — the vendor models the SATA PHY differently, and we should not copy it

```
hiahci-phy@0xF9900000 {
    compatible = "hiahci-phy";
    reg = <0xf9900000 0x1000  0xf8a20000 0x3000>;
    #phy-cells = <0x00>;
};
```

The vendor uses a dedicated `hiahci-phy` driver rather than the combo PHY. Mainline instead
models this as **combphy in `PHY_TYPE_SATA` mode**, which the mainline combphy driver supports.
Follow mainline: the vendor PHY driver is not upstream and never will be.

## ⭐ RESOLVED: SATA and the second USB3 SuperSpeed lane are mutually exclusive

The vendor's own SATA clock driver (`drivers/hisilicon/clk/hi3798cv2x/clk-hiahci.c` in the
HiSTBLinux BSP) states the mux outright:

```c
/* 00 PCIE, 01 USB3.0, 10 SATA */
#define COMBPHY1_SEL_MASK   (BIT(11) | BIT(12))
#define COMBPHY1_SEL_SATA    BIT(12)
#define PERI_CTRL            (0x0008)
```

⭐ **SATA is on combphy1**, selected by a three-way mux at PERI_CTRL offset `0x8`, bits 11-12.
That agrees exactly with mainline's `hisilicon,mode-select-bits = <0x8 0xb 0x1800>` — offset 8,
bit 11, mask bits 11+12 — so mainline already has the mechanism. The driver also pokes
`PERI_CRG98_COMBPHY` to `0xd00` for a 25 MHz VPLL, and **refuses to prepare the clock unless the
mux already reads SATA**, i.e. something earlier in boot must select it.

And the runtime answers which lanes are in use today. **Both** xHCI controllers are enabled, each
with a SuperSpeed root hub:

| Controller | USB2 bus | USB3 bus (5 Gb/s) |
|---|---|---|
| `f98a0000.xhci` (xhci0) | 3 | **4** |
| `f98b0000.xhci` (xhci1) | 5 | **6** |

Two SuperSpeed lanes in use means **both combo PHYs are currently in USB3 mode** — which is only
possible because **no disk is fitted**.

⇒ **The honest conclusion: you get SATA *or* the second USB3 SuperSpeed lane, not both.** Fitting
a disk and switching combphy1 to SATA costs one xHCI its SuperSpeed capability; that controller
keeps working at USB 2.0 speeds through the inno USB2 PHY. This is not a real loss — the box
advertises only **one** USB 3.0 host port — but it must be designed for rather than discovered.

⇒ For the arm64 DTS: **combphy0 stays `PHY_TYPE_USB3`** feeding one xHCI, and **combphy1 goes to
`PHY_TYPE_SATA`** for the AHCI node. The other xHCI is declared without a combo PHY.

## ⚠️ A superseded note on "combphy1 is free for SATA"

That conclusion rested on there being no PCIe device — which remains true (`/sys/bus/pci/devices/`
is empty and Wi-Fi is SDIO). But it is **not** the whole question, because **the vendor's xHCI
nodes carry no `phys` property at all** — the vendor driver configures the combo PHY internally.
So the vendor device tree **does not reveal which combo PHY lane feeds `xhci1`**.

⇒ That question is now **answered above, from the BSP source**: combphy1 is the SATA-capable
lane, both combo PHYs are presently in USB3 mode, and SATA displaces one SuperSpeed lane. The
no-PCIe observation stands and still matters — PCIe is the *third* option on that same mux, so
nothing is competing for it.

## Also confirmed from the vendor tree

- CPUs: four `arm,cortex-a53` in one cluster.
- UARTs: `uart0 @ 0xf8b00000` (the console, `ttyAMA0 @ 115200`) and `uart2 @ 0xf8b02000`.
- I2C ×5 (`0xf8b10000`–`0xf8b14000`), SPI0 `0xf8b1a000`.
- eMMC/SD: `hi3798cv200,himciv200`; the Wi-Fi SDIO host seen at runtime is `f9c40000.himciv200.SD`.
- PCIe node exists at `0xf9860000` but nothing is attached.
- NAND controller `hifmc100.NAND @ 0xf9950000`, USB device controller `hiudc @ 0xf98c0000`.

## Next

1. Read the BSP clock driver for the **bit layout of CRG `0xa8`** — the last unknown blocking the
   SATA patch.
2. Write the arm64 board DTS: xhci1 with `_CLK1` clocks, plus the AHCI node once the clocks exist.
3. Validate it with `bun run himedia:check-dt`, which will fail until the clocks are registered —
   that failure is the gate working.
4. ~~Resolve the combphy-lane question~~ — **done**, see above. Instead: find what sets the
   combphy1 mux to SATA during boot (the vendor clock driver refuses to run unless it is already
   set). On mainline that is the combphy driver's job via `mode-select-bits`, so it should follow
   from a correct device tree, but it is worth confirming in the boot log over UART.

ref: docs/261010-himedia-q10-pro-recon-findings.md
ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
