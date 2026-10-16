# HiMedia Q10 Pro — WiFi/BT, USB, SD card, SMP: vendor-to-mainline mapping

Date: 2026-10-11 · Status: research only. Nothing here was booted, flashed or committed.
Helper: `scripts/himedia/system-img-debugfs.sh` (read-only debugfs peek into `system.img` in a throwaway container).

## Confidence tags

- **[READ file:line]** — I read it in that file in this session.
- **[READ log]** — measured on the live stock box and recorded in `$HIMEDIA_ROOT/{logs,android-probe}`.
- **[INFER]** — a conclusion drawn from the above. The premise is named.
- **[UNKNOWN]** — no source I have answers it. Do not build on it.

## 0. Caveat that applies to every vendor-source claim

**[READ log] The stock box runs Linux `3.18.24_hi3798cv2x`**, not 4.4.35: `android-probe/20261010T154621-android-probe.md` usb-topology shows
`Manufacturer=Linux 3.18.24_hi3798cv2x xhci-hcd`. The source tree at `~/src/hisilicon-kernel-4.4.35` is a *different SDK drop*
(`Makefile:1-3` VERSION=4 PATCHLEVEL=4 SUBLEVEL=35). Everything I cite from that tree describes 4.4.35 and is **[INFER]** for the 3.18 binary
that actually runs on the box. The extracted vendor DT (`boot.img+0x8b5220.dts`) and the dmesg/probe logs **are** from the real box, so
addresses/IRQs/clocks from the DT and every "[READ log]" claim are firm. Register-sequence claims from `clk-hiusb3.c`, `platsmp.c` are "same SDK family, same SoC" — strong, not proven.

## 1. WiFi AP6255 (BCM43455) and Bluetooth

### 1.1 Which controller

| Item | Value | Tag |
| --- | --- | --- |
| Controller | `himciv200.SD@0xf9c40000`, alias `sdio` ("mmc2" in Android) | [READ vendor DT:490-499, aliases:15; READ log dmesg "mmc2: new ultra high speed SDR104 SDIO card"] |
| Base / size | `0xf9c40000` (soc-relative `0x9c40000`); vendor size 0x1000, use `0x10000` like sd0/emmc | [READ DT:493] |
| IRQ | `<0 0x56 4>` = **GIC SPI 86**, level high | [READ DT:494] |
| Clock | CRG reg **`0x28c`** (`PERI_CRG163_SDIO2`; vendor DT `clocks = <0x07 0x28c>`) | [READ DT:495; READ hi3798cv200-clock.h:119] |
| Clock register layout | default 0x32103, mask 0x77703, reset bit `BIT(4)`, rate mux bits[10:8] table {100,50,150,166.5 MHz}, sample phase [14:12], drive phase [18:16] — **identical to SDIO0 at 0x9c** | [READ clk-hi3798cv200.c:66-68,98-128; himci_hi3798cv2x.c:2-23] |
| Bus width | **4-bit** (`caps=0x80078007`: bits 0-2 = 4-bit, MMC-HS, SD-HS; bits 15-18 = UHS SDR12/25/50/104; bit 31 HW_RESET; bit 6 (8-bit) **clear**) | [READ DT:497; decoded with include/linux/mmc/host.h:241-268 — bit layout same in 3.18 per my knowledge, INFER] |
| Frequency | `max-frequency = 0x5f5e100` = **100 MHz**; the card enumerated as **SDR104** and `sd clock rate = 100000000` | [READ DT:498; READ log dmesg] |
| 1.8 V switch | Vendor `himciv200_start_signal_voltage_switch` returns early for `devid==0` (eMMC) and `devid==2` (**this controller**; devid = mmc index, Android names it mmc2) — it does *no* LDO switching for the SDIO slot, yet reaches SDR104. ⇒ the module's VDDIO is almost certainly **hard-wired 1.8 V** | [READ himciv200.c:875-876 and the `host->devid = mmc->index` assignment near line 1228; READ log SDR104] → conclusion [INFER] |
| Pinmux | DT 2nd reg `0xf8a210b0 len 0x40` is the vendor's "ioshare" window. The driver only writes it for `f9830000` (eMMC drive strength): no pin setup for this slot. ⇒ pads are left as U-Boot/boot ROM muxed them, exactly the situation our `emmc` node already lives in | [READ himci_hi3798cv2x.c:~92 (`strcmp ... f9830000.himciv200.MMC`)] → [INFER] |

### 1.2 Power, wake, 32 kHz

- **WL_REG_ON: there is no GPIO.** The stock `bcmdhd` printed `dhd_wlan_init_gpio: GPIO(WL_REG_ON) = -1` and `PULL WL_REG_ON(-1) HIGH!` [READ log `logs/20261010033845-after-probe/dmesg.txt:284-289`]. The driver never toggled a pin.
  So WL_REG_ON is either tied high on the board or driven by something the kernel does not model. **Best candidate [INFER]: the dw_mmc `PWREN` output** — the vendor `set_ios` writes `MCI_PWREN` on power up/off (`himciv200.c:98-100,963-968`), and mainline `dw_mmc` writes PWREN too, so a board that wires PWREN to the module enable would work with no DT help. **[UNKNOWN]** whether this board does; confirm with a multimeter or by testing mainline.
- **Host-wake (WL_HOST_WAKE): [UNKNOWN].** No `oob`/`irq` platform line appears in the DHD log; DHD ran in-band SDIO IRQ. ⚠️ Yet the AP6255 NVRAM sets **`sd_oobonly=1`** [READ system.img `/etc/firmware/ap6335/nvram_ap6255.txt`]. In-band IRQ worked for DHD, but for `brcmfmac` the safe choice is to **delete `sd_oobonly=1` from the NVRAM copy** (and `sd_gpout/sd_gpval` can stay). [INFER — test on hardware; if SDIO IRQ never fires, this line is the first suspect].
- **32.768 kHz LPO: [UNKNOWN].** The Android driver manages no clock, nothing in the vendor DT names one, so it is probably supplied on the board. Do not invent a clock in DT. If the WiFi probe dies with "chip did not respond"/timeouts, trace the LPO pin before blaming SDIO.
- **Chip ID [READ log]:** `chip:0x4345 rev:0x6 pkg:0x2` (BCM43455 **c0**), dongle RAM 819200, F1 signature `0x15264345`, NVRAM selected by `nv_by_chip=3 ... 0x4345 6 nvram_ap6255.txt`.

### 1.3 Draft mainline nodes (UNTESTED)

Mainline has **no clock for CRG 0x28c** — `crg-hi3798cv200.c` only models `0x9c` (sdio0) and `0xa0` (mmc). **A clock patch is required first** [READ `drivers/clk/hisilicon/crg-hi3798cv200.c:39,70-72,83-85,119-127`; include/dt-bindings/clock/histb-clock.h:31-34 has only SDIO0]:

```
histb-clock.h : #define HISTB_SDIO1_BIU_CLK 5x / CIU / DRV / SAMPLE   (new ids; pick unused numbers)
crg-hi3798cv200.c:
  mux   sdio1_mux  : sdio_mux_p, reg 0x28c, shift 8, width 2, table {0,1,2,3}
  gate  clk_sdio1_biu : parent "200m"      reg 0x28c bit 0   (same as sdio0: crg:119-120)
  gate  clk_sdio1_ciu : parent "sdio1_mux" reg 0x28c bit 1   (same as sdio0: crg:121-122)
  (phase clocks, only for the UHS upgrade below): sample [14:12], drive [18:16] on 0x28c
```

First bring-up node — deliberately **not UHS** (the plain `snps,dw-mshc` glue has no tuning op, so SDR50/SDR104 cannot be used; start at SD-HS 50 MHz):

```dts
	sdio2: mmc@9c40000 {
		compatible = "snps,dw-mshc";
		reg = <0x9c40000 0x10000>;
		interrupts = <GIC_SPI 86 IRQ_TYPE_LEVEL_HIGH>;
		clocks = <&crg HISTB_SDIO1_BIU_CLK>, <&crg HISTB_SDIO1_CIU_CLK>;
		clock-names = "biu", "ciu";
		resets = <&crg 0x28c 4>;          /* vendor _rstbit BIT(4), same as sd0 <&crg 0x9c 4> */
		reset-names = "reset";
		status = "disabled";
	};
```

Board file:

```dts
&sdio2 {
	bus-width = <4>;
	max-frequency = <50000000>;
	non-removable;                  /* soldered module: no CD, enumerate once */
	cap-sd-highspeed;
	cap-sdio-irq;
	keep-power-in-suspend;
	disable-wp;
	mmc-pwrseq = <&wifi_pwrseq>;    /* optional; drop if WL_REG_ON has no GPIO */
	#address-cells = <1>;
	#size-cells = <0>;
	status = "okay";

	wifi@1 {
		compatible = "brcm,bcm4329-fmac";   /* binding for all SDIO brcmfmac chips */
		reg = <1>;
		/* no interrupt-names/interrupts: in-band SDIO IRQ (host-wake GPIO UNKNOWN) */
	};
};
/ {
	wifi_pwrseq: wifi-pwrseq {
		compatible = "mmc-pwrseq-simple";
		/* reset-gpios: none known. post-power-on-delay-ms = <100>; */
		post-power-on-delay-ms = <100>;
	};
};
```
`wifi@1` / `brcm,bcm4329-fmac` and `mmc-pwrseq-simple` are standard mainline bindings [INFER, from kernel knowledge; the .config has `CONFIG_PWRSEQ_SIMPLE=y`, `BRCMFMAC=m`, `BRCMFMAC_SDIO=y`, `MMC_DW_HI3798CV200=y` — READ `.config` lines 2806-2808, 7396, 7455].
Upgrade path to SDR104 (the vendor's mode): compatible `hisilicon,hi3798cv200-dw-mshc` with `clock-names = "ciu","biu","ciu-sample","ciu-drive"` (as the `emmc` node) — that driver supplies `execute_tuning` using the sample phase clock [READ `drivers/mmc/host/dw_mmc-hi3798cv200.c:30-80`]. Then add `sd-uhs-sdr104` and a fixed 1.8 V vqmmc only if the voltage handling is understood. Not for the first boot.

### 1.4 Firmware files (stock `system.img`, ext4, inspected read-only) [READ log via debugfs]

All in `/etc/firmware/ap6335/` (the directory is misnamed `ap6335`; the module in use is AP6255):

| Stock file | Size | Install on the mainline rootfs as |
| --- | ---: | --- |
| `fw_bcm43455c0_ag.bin` | 526 309 | `/lib/firmware/brcm/brcmfmac43455-sdio.bin` |
| `nvram_ap6255.txt` | 1 680 | `/lib/firmware/brcm/brcmfmac43455-sdio.himedia,q10-pro.txt` (board-specific name = DT root `compatible[0]`, `/` replaced by `_`; fallback `brcmfmac43455-sdio.txt`). Edit: drop `sd_oobonly=1`; the stock `macaddr=00:90:4c:c5:12:38` is a placeholder, set a real MAC |
| `BCM4345C0.hcd` | 65 570 | `/lib/firmware/brcm/BCM4345C0.hcd` (BT patchram; see 1.5) |
| `config.txt` | 90 | **not used** — it is DHD's `nv_by_chip=` selector |
| (absent) `clm.blob` | — | The DHD log says `Ignore clm file .../ap6335/clm.blob`: **no CLM blob ships**. brcmfmac 43455 wants `brcm/brcmfmac43455-sdio.clm_blob`; take it from linux-firmware (Cypress/Infineon) |

Tags: sizes/names [READ]; destination names [INFER] from brcmfmac's `brcmfmac<chip>-sdio.<board compatible>.txt` convention. ⚠️ `fw_bcm43455c0_ag.bin` is a *DHD-flavoured* build; brcmfmac speaks BCDC and normally works with it, but if it misbehaves swap in linux-firmware's `cyfmac43455-sdio-standard.bin` (same chip rev) as `brcmfmac43455-sdio.bin`. Other files present, **ignore**: `BCM4345C5.hcd`, `bcm4339a0.hcd`, `fw_bcm4339a0_*`, `fw_bcm43456c5_*`, `nvram_ap6256/ap6335` (other modules in the same ROM). Stock also carries `mt7662*` (MediaTek WiFi USB dongle firmware) — unrelated.
Stock `/lib/modules/` has `bcmdhd.ko`, `rtl8188eu.ko` (USB dongle) — no `brcmfmac`.

### 1.5 Bluetooth

- **UART: `/dev/ttyAMA1`** — `bt_vendor.conf: UartPort = /dev/ttyAMA1`, `FwPatchFilePath = /etc/firmware/ap6335/` [READ system.img `/etc/bluetooth/bt_vendor.conf`]. ttyAMA0 is the console on `uart@f8b00000`; the second PL011 in the vendor DT is **`uart@0xf8b02000`, SPI 0x33 = 51** [READ DT:455-462], so ttyAMA1 = our `uart2` (`serial@8b02000`, SPI 51) — [INFER from probe order; the vendor DT lists no uart1]. Our dtsi already defines `uart2` (disabled).
- **BT_REG_ON, BT_HOST_WAKE, DEV_WAKE: [UNKNOWN].** `libbt-vendor.so` (`/vendor/lib`, 30 KB) controls power through **`/sys/class/rfkill/rfkill%d/{type,state}`** (strings: `init_rfkill`, `ro.rfkilldisabled`) and defaults to `/dev/ttyO1` [READ strings]. The vendor kernel config has **`# CONFIG_RFKILL_GPIO is not set`** (`hi3798cv200_android_defconfig:1133`) and the vendor DT has no rfkill/gpio consumer node, so the rfkill device comes from a driver I could not locate (stock tries `rtk_rfkill.ko`, which does not exist in this image — `dmesg` "insmod rtk_rfkill.ko failed"). Treat BT power/wake pins as unknown; they may be tied on.
- **RTS/CTS pinmux on uart2: [UNKNOWN].** HCI over this UART needs flow control; the vendor DT has no pinctrl so the bootloader mux is all we have.
- **Draft (UNTESTED, compatible from memory of the RPi 3B+ BCM43455 setup, verify in `drivers/bluetooth/hci_bcm.c`):**

```dts
&uart2 {
	status = "okay";
	uart-has-rtscts;
	bluetooth {
		compatible = "brcm,bcm43438-bt";
		max-speed = <921600>;               /* stock patch download is at 115200 (strings) */
		/* shutdown-gpios / device-wakeup-gpios / host-wakeup-gpios: UNKNOWN */
		/* firmware-name resolves to brcm/BCM4345C0.hcd */
	};
};
```
`CONFIG_BT_HCIUART_BCM=y` and `BT_BCM=m` are in `.config` [READ lines 1305,1318].
- The stock `qcom.bluetooth.soc=rome` / `persist.sys.uart.port=ttyAMA0` properties are Android leftovers; ignore.

## 2. USB

### 2.1 Controller map

| Vendor node | Addr | SPI | Mainline node | USB2 PHY | SS lane |
| --- | --- | ---: | --- | --- | --- |
| `ohci@f9880000` | 0xf9880000 | 0x43=67 | `ohci` | **PHY01 port 1** (vendor init cancels `USB2_PHY01_SRST_TREQ1`, CRG 0xbc bit 9) | none |
| `ehci@f9890000` | 0xf9890000 | 0x42=66 | `ehci` | same as OHCI | none |
| `hiudc@f98c0000` + `hiusbotg` | 0xf98c0000 | 0x44=68 | not in mainline | OTG, shares PHY01 port 0 mux (`0xf8a2012c`) | — |
| `xhci@f98a0000` (**xhci0**) | 0xf98a0000 | 0x45=69 | `xhci0` | **PHY01 port 0** (`PERI_USB0`=0x120, reset `TREQ0` = CRG 0xbc bit 8) | combphy0 (USB3-only) |
| `xhci@f98b0000` (**xhci1**) | 0xf98b0000 | 0x55=85 | `xhci1` | **1-port PHY2** (`PERI_USB1`=0x124, `SRST_REQ` bit 6 + `TREQ` bit 10) | combphy1 — **taken by SATA** (vendor sets `USB3_PORT_DISABLE`) |

Sources: addresses/IRQs [READ DT:568-618]; PHY pairing from the vendor clock code [READ `clk-hiusb3.c:142-169,232-343` (host0), `:172-229,346-420` (host1); `clk-hiusb2.c:66-70,149-200` (EHCI/OHCI cancels TREQ1)]. Note the enable-order dependency: `hiclk_enable_usb3_host0` first calls `clk_prepare_enable(PERI_CRG46_USB2CTRL)`, i.e. it piggy-backs on the *EHCI/OHCI* USB2 init for the shared 2-port PHY [READ clk-hiusb3.c:236,254].
Live confirmation [READ log android-probe usb-sysfs]: Android bus 1=EHCI, 2=OHCI, 3/4=xhci `f98a0000` (HS/SS roots, 1 port each), 5/6=xhci `f98b0000`; the Genesys hub `05e3:0608` and the stick are on **bus 5** (xhci1 HS). Bus 6 (xhci1 SS root) has a root hub but, per the vendor code, the lane is disabled because combphy1 is SATA.
Android's register state agrees with "all deasserted": `CRG_USB3 0xf8a220b0 = 0x007f007f`, `CRG_USB2PHY 0xf8a220bc = 0x00000005`, `CRG_USB2CTRL 0xb8 = 0x3f` [READ `android-probe/regs-android-20261010-233226.txt`].

### 2.2 The answer to "which usb2 phy for xhci0": **`usb2_phy1_port0`, not `usb2_phy2_port0`**

Your DT guess (`usb2_phy2_port0`) is **wrong** by the vendor code [READ clk-hiusb3.c]:
- host0 writes tuning words to `PERI_USB0` (`0x120`) — that is the register of `usb2_phy1` (`usb2_phy@120`) — and releases **`USB2_PHY01_SRST_TREQ0`** (`BIT(8)` of CRG `0xbc`) = `usb2_phy1_port0`'s reset `<&crg 0xbc 8>` in our dtsi.
- `usb2_phy2` (`@124`, reset `0xbc 6/10`) is what **host1** uses (`PERI_USB1`=0x124, `PHY2_SRST_REQ/TREQ`). That is what we already put on xhci1, correctly.
- Tag: **[READ]** for the register/bit mapping; "this is what the *3.18* kernel does" is **[INFER]** (§0). Probability low that it differs: both kernels are one SDK family and the Android register dump matches.

### 2.3 Exact DT changes

```dts
&xhci0 {
	phys = <&usb2_phy1_port0>, <&combphy0 PHY_TYPE_USB3>;
	phy-names = "usb", "combo";
	phys-names = "inno", "combo";   /* ⛔ xhci-histb.c reads "phys-names" (NOT phy-names):
	                                   "inno" => GUSB2PHYCFG0 ULPI/UTMI-8 fix, "combo" => GUSB3PIPECTL0 TX margin/deemph */
	status = "okay";
};
```
- The existing `xhci0` node has only `phy-names`; without `phys-names` the controller-side `xhci_histb_config()` quirks are skipped [READ `drivers/usb/host/xhci-histb.c:54-72`].
- `resets = <&crg 0xb0 12>` ✓ matches `USB3_VCC_SRST_REQ = BIT(12)` and clocks bits 0/2/3/4 ✓ [READ clk-hiusb3.c:56-63; crg-hi3798cv200.c:178-185].
- combphy0 in our dtsi is `hisilicon,fixed-mode = <PHY_TYPE_USB3>` ✓ (the vendor host0 never reads a mux, only host1 does: clk-hiusb3.c:360).
- **EHCI/OHCI**: our (mainline-derived) dtsi gives them `phys = <&usb2_phy1_port0>`. The vendor code releases **port 1** for that pair. Once xhci0 also uses port 0 the two share one phy handle (refcounted `phy_init/power_on`, harmless), but the physical truth per vendor is **port 1** → change `ehci`/`ohci` to `phys = <&usb2_phy1_port1>`. [READ clk-hiusb2.c:166-198] Our own note in the board DTS that EHCI/OHCI "changed nothing" also fits: nothing is plugged into that pair (Android: EHCI/OHCI root hubs empty).
- ⚠️ **Clock-bit gap [READ → risk INFER].** Vendor host0 enables CRG `0xb0` bits **0,5,6** (BUS, BUS_GS, BUS_GM) and **1** (REF_CKEN), plus 2,3,4. Mainline models only bits 0,2,3,4 (host0) and 16,18,19,20 (host1). Bits 1,5,6 / 17,21,22 are not described by any mainline clock. Android leaves all of them set (`0x007f007f`). xhci1 already works under our kernel ⇒ U-Boot (or reset default) leaves the host1 equivalents on; **I could not establish the same for the host0 bits** — read `0xf8a220b0` from the running mainline box (devmem) before enabling; if bits 1/5/6 are clear, add gate clocks for them to the CRG driver or the xHCI register read will stall the bus (the failure looks like a hang, not an error — see the xhci1 comment in the board DTS).
- ⚠️ PHY tuning words (vendor `inno_phy_config_2p_0`: reg 0x00=0x1c, 0x07=0x00, 0x11=0x40; Android readback `PERI_USB0 = 0x00a01140`) are performed by `phy-hisi-inno-usb2` only partly — signal quality on the side port may need those values [INFER; I did not diff the mainline PHY driver against them].

### 2.4 Physical port mapping — **[UNKNOWN] beyond this**

- The only controller with an enabled SuperSpeed lane is **xhci0** (combphy0 is USB3-only) ⇒ the single side **USB3** socket must be xhci0 [INFER, strong: it is the only SS path]. The Android boot log also shows a transient *full-speed* device enumerating on `usb 3-1` (xhci0's HS root) [READ log dmesg:231] and nothing there by the time of the later probe — consistent with an external port someone used (e.g. a 2.4 GHz dongle), not an internal part.
- The Genesys hub (4 ports, on xhci1-HS) presumably feeds the rear USB2 and the two side USB2 [INFER from "1x USB3 + 2x USB2 side + rear" in the task statement; **which hub port is which connector is UNKNOWN**; the stick sat on hub port 2].
- EHCI/OHCI: no device in any probe ⇒ **[UNKNOWN] whether they reach a connector** (could be the OTG/micro-USB, or unconnected).
- Cheapest test: enable xhci0, then plug a device into each connector while reading `dmesg`/`lsusb -t` and record the bus/port.

## 3. SD card reader (`sd0` = `mmc@9820000`)

| Item | Value | Tag |
| --- | --- | --- |
| Base / IRQ | `0xf9820000`, SPI **0x22 = 34** — matches our dtsi (`GIC_SPI 34`) | [READ DT:478-488] |
| Clock | CRG `0x9c`, reset `<&crg 0x9c 4>` — matches dtsi | [READ DT:482; crg-hi3798cv200.c:119-122] |
| `caps` | `0x80000007` ⇒ 4-bit, MMC-HS, SD-HS, (HW_RESET bit 31); **no UHS bits** | [READ DT:485 + host.h decode] |
| `max-frequency` | `0x2faf080` = **50 MHz** | [READ DT:487] |
| Card-detect | **Native `MCI_CDETECT` register** (dw_mmc CD input), no GPIO property anywhere in the vendor DT; vendor `get_cd` reads the register | [READ himciv200.c:117-132,1176; vendor DT has no cd-gpios] |
| Write-protect | Vendor has no WP handling that I found | [UNKNOWN — grep was not exhaustive]; micro-SD ⇒ `disable-wp` is the safe choice [INFER] |
| Signal-voltage LDO | `ldo-addr = 0xf8a2011c` (PERI_CTRL + 0x11c), `ldo-shift = 0`; bits `[6:4]` = BYPASS(6) / ENABLE(5) / VOLTAGE(4). The vendor switches 3.3 V ↔ 1.8 V by writing this register; the driver exits early for the eMMC (devid 0) and the SDIO slot (devid 2), so the SD slot (devid **1**) is the one using it | [READ DT:484; himciv200_def.h:175-179; himciv200.c:840-860,875] |
| Pinmux | Window `0xf8a21158`; the vendor driver never writes it for this slot | [READ DT:480; himci_hi3798cv2x.c] → pads as left by the bootloader [INFER] |

**DT:** our board file *already* enables `&sd0 { bus-width = <4>; cap-sd-highspeed; status = "okay"; }` (it is therefore one boot away from being tested; I cannot tell from the repo whether it has been). What to change:

```dts
&sd0 {
	bus-width = <4>;
	max-frequency = <50000000>;
	cap-sd-highspeed;
	disable-wp;
	/* no cd-gpios, no broken-cd: native CD pad, like the vendor.
	   no sd-uhs-*: no mainline driver for the PERI_CTRL+0x11c LDO, so never request 1.8 V. */
	status = "okay";
};
```
- Because there is no mainline LDO driver, the slot must stay at whatever voltage U-Boot left (3.3 V, since the stock cards boot in HS) — **[INFER]**. This is why UHS must not be advertised.
- If insertion never registers, try `broken-cd` (polling) before assuming wiring — the native-CD pad could be inverted on some boards [INFER, no evidence either way].

## 4. SMP — vendor 32-bit secondary bring-up

### 4.1 Context and TEE finding

- Our boot: `smp: Brought up 1 node, 1 CPU` (single core because PSCI was deleted) [READ `q10log-20261011/boot-1/dmesg-early.txt:55-57`]; CPU is `ARMv7 [410fd034] revision 4` = Cortex-A53 r0p4, running in AArch32 [READ :3].
- The stock Android kernel brings **all four cores up** (`recon` shows `processor 0..3`, count = 4) **without PSCI**: the vendor DT cpu nodes have no `enable-method` and the DT has **no `psci` or `optee` node** [READ DT:38-70, whole-file grep for `psci` = none; READ recon]. (The SDK's *own* `arch/arm/boot/dts/hi3798cv200.dts` has `psci`+`optee` — a TEE variant that this box's firmware does not use [READ that file:44,130].) ⇒ the stock path is **platform SMP code, not firmware PSCI** [INFER, strong].
- Both shipped defconfigs have `# CONFIG_TEE is not set` and `# CONFIG_ARM_PSCI is not set` [READ `hi3798cv200_android_defconfig:1188,445`; `hi3798cv200_defconfig:950,438`], so the non-TEE branch of the code below is the live one [INFER: 3.18 binary config unverified].

### 4.2 The code, precisely

`arch/arm/mach-hi3798cv2x/platsmp.c`, `headsmp.S`, `hotplug.c`, `include/mach/platform.h` (all 4.4.35).

**Registers (physical, CRG block `0xF8A22000`) [READ platform.h:21-29; hi3798cv200-clock.h:36-37]:**

| Register | Address | Meaning |
| --- | --- | --- |
| `PERI_CRG18_CPU_LP` | `0xF8A22048` | CPU low-power / frequency select. Bit **10** = `CPU_SW_BEGIN` (frequency-switch strobe). Other bits' meaning [UNKNOWN]. |
| `PERI_CRG20_CPU_1` | `0xF8A22050` | CPU reset control. Per core *n* (0-3): bit **`8+n`** = core reset (`CPU_REG_CORE_SRST`=8), bit **`12+n`** = core power-on reset (`CPU_REG_COREPO_SRST`=12). Bit `6`+ = `COREPDBG_SRST`, bit **16** `CPU_REG_CKEN` (defined, **not used** by power-up). |
| SRAM boot window | phys **`0xFFFF0000`** (`SRAM_BASE_ADDRESS`) | where a freshly released core fetches. |
| `SC_GEN1` (TEE path only) | `0xF8000000 + 0x84` | `REG_BASE_SCTL + REG_SC_GEN1`; secure code reads the jump address here. |

**Order of operations (`hi3798cv2x_boot_secondary`, platsmp.c:51-105) [READ]:**
1. `set_scu_boot_addr(0xFFFF0000, virt_to_phys(hi3798cv2x_secondary_startup))` (hotplug.c:91-129): `ioremap(0xFFFF0000, PAGE_SIZE)`; write word0 = `0xe51ff004` (**`ldr pc, [pc, #-4]`**), word1 = jump phys address; `smp_wmb`; flush D-cache + `outer_clean_range`. *(Under `CONFIG_TEE` instead: write the jump address to `0xF8000084` — not our path.)*
2. `spin_lock(&boot_lock)`; `slave_cores_power_up(cpu)` (platsmp.c:144-177):
   a. save `0xF8A22048`; write **`0x206`** then **`0x606`** (selects 400 MHz: bit 10 set = start switch);
   b. `0xF8A22050 &= ~(1 << (cpu+12))` (release core power-on reset);
   c. `0xF8A22050 &= ~(1 << (cpu+8))` (release core reset) — the core starts executing at its reset vector now;
   d. write `saved & ~BIT(10)` then `saved` to `0xF8A22048` (restore CPU frequency, strobe again).
3. `write_pen_release(cpu)`, `arch_send_wakeup_ipi_mask`, then spin ≤5 s for `pen_release == -1`. (Legacy holding-pen handshake — see 4.3.)

**Secondary entry `hi3798cv2x_secondary_startup` (headsmp.S:21-56) [READ]:**
1. `cpsr = SVC32, IRQ+FIQ masked` (`0xd3`).
2. `#ifndef CONFIG_TEE`: read the 64-bit register via **`mrrc p15,1,r0,r1,c15`**, set **bit 6**, write back with `mcrr` — that is **CPUECTLR.SMPEN** on a Cortex-A53 (data coherency with the cluster) [encoding→register name is from the A53 TRM, not in the repo: INFER]. Then `flash_cache_all`: SCTLR clear M/C/A bits, set V(13)/Z(11)/A(1); invalidate TLB + I-cache; `bl v7_invalidate_l1`.
3. Compute `MPIDR & 15`, spin on `pen_release` (via physical `adr`/literal pair) until it equals this core, then `b secondary_startup` (generic ARM entry).
- `smp_init_cpus` (platsmp.c:124-142): core count from **L2CTLR[25:24] + 1** (`mrc p15,1,c9,c0,2`). Mainline gets this from the DT `cpu@N` nodes.
- Hotplug (`hotplug.c`): `cpu_die` = `v7_exit_coherency_flush(louis)`, clear CPUECTLR bit 6, then `for(;;) wfi()`. No power-down, **and nothing re-resets the core** ⇒ a CPU taken offline can never be brought back by this code [INFER from reading the loop and `slave_cores_power_up` only *clearing* resets]. Do not promise hotplug.

### 4.3 Mapping to a mainline `smp_operations` (DRAFT, UNTESTED)

Model it on `arch/arm/mach-hisi/platsmp.c` (`hix5hd2_smp_ops`) — the CRG is already a syscon in our dtsi (`hisilicon,hi3798cv200-crg`, `simple-mfd`).

```dts
cpu@N { /* N = 0..3 */  enable-method = "hisilicon,hi3798cv200-smp"; ... };   /* and no /psci node */
```
```c
/* arch/arm/mach-hisi/platsmp.c  (sketch) */
static struct regmap *crg;
static int hi3798cv200_boot_secondary(unsigned int cpu, struct task_struct *idle)
{
	unsigned int lp;
	void __iomem *rom = ioremap(0xFFFF0000, PAGE_SIZE);   /* prefer an of_iomap()'d DT node */
	if (!rom) return -ENOMEM;
	writel_relaxed(0xe51ff004, rom);                       /* ldr pc, [pc, #-4] */
	writel_relaxed(__pa_symbol(hi3798cv200_secondary_startup), rom + 4);
	wmb(); iounmap(rom);

	regmap_read(crg, 0x48, &lp);
	regmap_write(crg, 0x48, 0x206); regmap_write(crg, 0x48, 0x606);
	regmap_update_bits(crg, 0x50, BIT(12 + cpu), 0);        /* core PO reset */
	regmap_update_bits(crg, 0x50, BIT(8 + cpu), 0);         /* core reset   */
	regmap_write(crg, 0x48, lp & ~BIT(10)); regmap_write(crg, 0x48, lp);
	return 0;                                               /* core code waits for the CPU */
}
CPU_METHOD_OF_DECLARE(hi3798cv200_smp, "hisilicon,hi3798cv200-smp", &hi3798cv200_smp_ops);
```
and a tiny `headsmp.S` stub: SVC mode, **set CPUECTLR.SMPEN**, `bl v7_invalidate_l1`, `b secondary_startup`. Drop the vendor's `pen_release`/`boot_lock` handshake: modern ARM core code passes the stack in `secondary_data` and the generic `cpu_up` waits for the CPU itself. `CONFIG_HOTPLUG_CPU` may stay, with `.cpu_die` = WFI loop; expect offline CPUs not to return (see 4.2).
Notes: [INFER] `v7_invalidate_l1` is an exported entry in `arch/arm/mm/cache-v7.S` (the vendor stub calls it and mainline's own `secondary_startup` users do the same); [INFER] 400 MHz dance is a safety step for releasing resets from a possibly fast PLL — keep it first, remove after it is proven redundant.

### 4.4 What depends on secure world

- **Nothing in the non-TEE path.** Every access is a plain NS `readl/writel` to CRG (`0xF8A22xxx`) and to the on-chip SRAM, plus a CP15 write to CPUECTLR [READ code]. Whether those accesses **work from our AArch32 NS entry** is proven only indirectly: the stock Android kernel performs them on this very box and gets 4 cores [INFER, via the 3.18 caveat].
- **Open risks [UNKNOWN until tried]:**
  1. A core released from reset must *fetch* from `0xFFFF0000` (high-vector reset). I infer this because the vendor writes `ldr pc,[pc,#-4]` exactly there; the hardware strap that sets it is not documented anywhere I have.
  2. CPUECTLR write access depends on EL3 having set `ACTLR_EL3`/`ACTLR_EL2` bits; the stock kernel's non-TEE stub assumes they are set. If the write traps, the secondary dies silently.
  3. The TEE path (`SC_GEN1`) would mean a monitor must be waiting on that register; nothing indicates it on this box.
  A failed secondary shows up as `CPU1: failed to come online` after ~1 s (generic code timeout), not as a boot hang — safer than the earlier PSCI attempt (a bad `smc` can hang before any output; see the board DTS note).

## 5. Suggested order for the next hardware session

1. Read `0xf8a220b0` (USB3 clocks), `0xf8a22188`, `0xf8a2011c`, `0xf8a22050/48` from the running mainline box before changing anything.
2. USB: `xhci0` + `phys-names` (§2.3); plug each connector in turn and record bus/port.
3. SD: add `max-frequency`/`disable-wp`; test with a card at boot and hot-inserted.
4. WiFi: clock patch + `sdio2` (§1.3), firmware per §1.4, `sd_oobonly` removed; expect probe to depend on the unknown WL_REG_ON / LPO.
5. SMP last, one change at a time, with the SP805 watchdog ladder armed.
