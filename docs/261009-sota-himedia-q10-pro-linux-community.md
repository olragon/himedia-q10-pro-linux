# SOTA (community angle): Linux on Hi3798CV200 boxes (HiMedia Q10 Pro / Q5 Pro)

Date: 2026-10-09 · Angle: `community` · Method: GitHub REST API (dated `pushed_at`), raw READMEs, WebFetch, WebSearch.

## Verdict (decision first)

**A walked path EXISTS, and it is alive as of this week, but it is not on the HiMedia box and not from a mainstream distro.**

1. **Mainline Linux on the SoC is real and maintained.** `hi3798cv200.dtsi` + `hi3798cv200-poplar.dts` are in torvalds/linux; latest dts commits 2026-02-27 and 2026-06-25. In-tree: GMAC (`hix5hd2_gmac`), eMMC/SD (dw-mshc), USB2 PHY + EHCI/OHCI, PCIe (combphy), PL011, I2C, IR, GIC-400. Not in tree: HDMI/VDP, video codecs, DVB, audio.
2. **A fresh, active community project runs Linux 6.12 + Debian 12 on RETAIL Hi3798CV200 set-top boxes** (HiSilicon-Development org, created 2026-09-02, last push 2026-10-06, firmware release dated 2026-10-09). It keeps the vendor AArch32 Fastboot and trampolines into AArch64 Linux, so it works on locked boxes. It claims HDMI (`histb-vdp`/`histb-hdmi`), Panfrost GPU, Ethernet, eMMC, USB. But it supports **four Chinese DVB-C boxes (DVB-IP1001/2/4/6) only**; images are per-device and "must not be cross-flashed".
3. **No distro supports it.** Armbian: no board config, forum thread closed with no solution. OpenWrt: no hisilicon target in `target/linux`. LibreELEC: a developer said in 2018 "not possible", no plans. Debian-on-Poplar exists only for the open reference board.
4. **Nobody has reported Linux on a HiMedia Q10 Pro / Q5 Pro.** Zero hits. The box community stayed on Android (kernel 3.18 / HiSTBAndroid, rooting via adb). That is a gap, not a negative proof.

Implication for Tim: booting your own Linux on a Q10 Pro is a **first-of-its-kind port** unless you borrow the HiSilicon-Development boot-chain trick. Realistic route = copy that project's method (retain vendor Fastboot, ship a container with your kernel), needs UART + a full eMMC backup + a per-device DTS. Expect headless (ethernet/USB/eMMC/SATA-via-PCIe) to be achievable; HDMI console is shown on other boards with out-of-tree drivers only.

## Table: project -> what -> last activity -> usable for Q10 Pro?

| Project | What it is | Last activity (API `pushed_at`) | Usable for this box? |
|---|---|---|---|
| [HiSilicon-Development/Hi3798Cv200](https://github.com/HiSilicon-Development/Hi3798Cv200) (+ `linux-6.12.y`, `firmware`, `HiVXE-2.0`, `FFmpeg`) | Linux 6.12.111 + Debian 12.15 rootfs for 4 retail DVB-C STBs; AArch32 Fastboot -> AArch64 boot doc; HDMI, Panfrost, GMAC, eMMC, USB, HiVXE encoder | 2026-10-05 (repo), 2026-10-06 (firmware), created 2026-09-02 | **Method yes, images no.** Best template; per-device DTS/containers required |
| [torvalds/linux hi3798cv200 dts](https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/hisilicon/hi3798cv200-poplar.dts) | Mainline SoC + Poplar DTS | 2026-06-25 (dtsi), 2026-02-27 (poplar) | **Yes**, kernel base for a Q10 Pro DTS |
| [Charlesmingquan/imou-sn1-hi3798cv200](https://github.com/Charlesmingquan/imou-sn1-hi3798cv200) | Mainline 6.18.43 + FnNAS (Debian 12) on Imou SN1 (CV200, native SATA, RTL8211F); has `bootloader`, `dtb`, `build-armbian` dirs | 2026-09-08 (created 2026-08-28) | **Closest analogue** (NAS box with SATA). Same SoC, different board |
| [leandrotsampa/hisilicon-kernel](https://github.com/leandrotsampa/hisilicon-kernel) | Vendor 4.4.35 kernel for CV200/MV200, many branches (`hi3798cv200-dev`, `poplar-4.9`) | 2026-06-14 (created 2020-07) | Partial; vendor-kernel path, not mainline |
| [leandrotsampa/e2d-hi3798cv200](https://github.com/leandrotsampa/e2d-hi3798cv200) | Debian 10 armhf + Enigma2 + Kodi v19 with HW decode on CV200 STBs | 2021-03-05 (22 stars) | Dormant; proof Debian userland runs on vendor kernel |
| [leandrotsampa/v4l2-hisi](https://github.com/leandrotsampa/v4l2-hisi) | V4L2 mem2mem decoder/encoder driver for CV200 | 2026-06-14 | Interesting for video; unverified |
| [CoffeeCat0667/hisilicon3798mv200-Linux6.8-Ubuntu26.04-SDK](https://github.com/CoffeeCat0667/hisilicon3798mv200-Linux6.8-Ubuntu26.04-SDK) | Alpha 6.8 + Ubuntu 26.04 on Hi3798**M**V200 (HC2910); UART, eMMC, ethernet; multimedia excluded | 2026-08-31 | Different SoC variant; reference only |
| [96boards-poplar/*](https://github.com/96boards-poplar) (`linux`, `u-boot`, `poplar-tools`, `l-loader`) | Official Poplar org; Debian/Android recovery builder | `linux` 2020-05-07, `u-boot` 2020-06-02, `poplar-tools` 2026-03-31, `l-loader` 2026-03-01 | Poplar only (open bootloader). Boot chain not applicable to a locked box |
| [daniel-thompson/poplar-usbstick](https://github.com/daniel-thompson/poplar-usbstick) | Debian-on-USB installer for Poplar | 2018-02-05 | Dead; Poplar only |
| [hanwckf/bl-hi3798c](https://github.com/hanwckf/bl-hi3798c) | u-boot/ATF loader for Imou SN1 and DSH4904 (CV200) | 2022-07-24 (created 2020-04) | Dormant; only proof of custom bootloader on a retail CV200 |
| [a513187481/My-Hi3798-OpenWrt](https://github.com/a513187481/My-Hi3798-OpenWrt) | README is the generic P3TERX Actions-OpenWrt template, no Hi3798 content visible | 2026-04-01 | No |
| [lqinyli/hi3798mv100-openwrt](https://github.com/lqinyli/hi3798mv100-openwrt) | OpenWrt for MV100 (older SoC) | 2022-11-22 | No (wrong SoC) |
| Armbian (`armbian/build`) | No hisilicon/hi3798/poplar board config or path (tree search empty; poplar.conf/hi3798.conf 404) | n/a | **No** |
| OpenWrt (`target/linux`) | No hisilicon target in current list (40+ targets listed, none HiSilicon) | n/a | **No** |
| LibreELEC / CoreELEC | LibreELEC forum 2018: "HiSilicon SoC's are not currently supported"; tree has only an Amlogic fdhisi patch (unrelated) | 2018-01 thread | **No** |

## Success reports (prioritised)

- **Poplar NAS, 2019-07-22** ([96boards blog](https://www.96boards.org/blog/poplar-nas/)): Debian + vanilla mainline 5.2.0, 4 TB WD drive via ASM1062 SATA on the PCIe slot, saturated gigabit with Samba/NFS. Must disable NCQ. Worked: ethernet, PCIe-SATA. Reference board only.
- **Imou SN1, 2026-09** (repo above): mainline 6.18.43 + Debian 12 bookworm + FnNAS. Hardware table lists GbE (hix5hd2-gmac, RTL8211F), SATA, USB3, SD, QCA9377 SDIO wifi, Panfrost GPU; HDMI/VDP "needs vendor SDK, not mainline". This is the most relevant "what did they give up" statement: **HDMI and codecs via mainline are not available there**.
- **DVB-IP100x, 2026-10** (HiSilicon-Development): claims HDMI (`histb-vdp`, `histb-hdmi`), Panfrost, GMAC1 eth0, eMMC, 4 USB controllers, HiVXE encoder, on 6.12.111. Self-reported in the project's own docs; I did not boot it. Several rows say display/audio acceptance is still "per dedicated doc", i.e. not uniformly finished.
- **e2d (Atto Pixel), 2021-02**: Debian 10 armhf on vendor 4.4 kernel with Enigma2/Kodi, DVB tuners, HW decode.

## Forum / community state

- Armbian forum "Armbian for HiSilicon Hi3798mv300" (2021-09 to 2022-08, fetched): maintainer "never heard of this chip"; "no mainline support" (wrong for CV200, which does have DTS); a user warned the BootROM verifies bootloader signatures; one pointed to a teasiu kernel for MV100 Ubuntu. Topic closed, no result.
- LibreELEC forum, Q5 Pro (2018-01, fetched): not possible, GPU had no Linux driver at the time (Panfrost has since landed for Mali-T720 in mainline, which changes that old verdict for GPU only).
- CSDN/V2EX/cnblogs tutorials exist for flashing Ubuntu on Huawei Hi3798 boxes with HiTool + UART (snippet-only, unfetched; mostly MV100/MV200 and the old HiSTB SDK).
- HiMedia Q5/Q10 Pro: Android firmware/rooting threads only (Kodi forum, androidpctv, itvplus.net; snippet-only). No Linux-port thread found.
- 96Boards Poplar forum: **could not be read**. `discuss.96boards.org` fails DNS from WebFetch (ENOTFOUND) though `dig` resolves it; the Wayback fallback returned 429. Treat the "richest source" as unread.

## Is the community alive?

**Split verdict.**
- *Poplar / distro side:* dormant to dead. Last Poplar org kernel/u-boot activity 2020; Debian-on-Poplar stick 2018; the last Poplar blog success 2019; distro projects never adopted it.
- *Retail-box hacking side:* **alive and accelerating in the last 6 weeks.** Counts of repos touched in 2026-08..10: HiSilicon-Development (6 repos, created Sep 2026), Imou SN1 (Aug-Sep 2026), HC2910 MV200 (Aug 2026), plus mainline dts fixes in Feb and Jun 2026. All Chinese-language, small (9 stars on the main repo, QQ group), single or few authors. Risk: a burst of young repos can vanish; the main repo is 5 weeks old.
- *HiMedia boxes specifically:* no Linux activity at all.

## Caveats and gaps

- Secure boot: Armbian forum user claims BootROM checks bootloader signatures. HiSilicon-Development works around this by keeping the signed vendor Fastboot and only replacing the kernel/trustedcore/recovery container; whether Q10 Pro's Fastboot accepts an unsigned kernel container is **unverified** and the single most important thing to test (needs UART).
- Not verified by me: that any of the 6.12 images boot or that HDMI works. Claims come from the project's own docs.
- Q10 Pro "SATA bay" bridge type (PCIe combphy vs USB bridge) not researched here.
- Reddit, freaktab, xda, 4PDA, openwrt forum: not reached (no browser access in that run). Recorded as gaps, not as absence.

## Sourcing ledger

Fetched and read (13): GitHub API for ~12 repo/org/commit/release endpoints; raw READMEs of HiSilicon-Development/Hi3798Cv200, its Boot-Doc and DVBIP-100x intro, CoffeeCat0667 SDK, bl-hi3798c, poplar-tools, poplar-usbstick, e2d-hi3798cv200, Imou SN1 README.cn; torvalds/linux dts commits and dtsi; `armbian/build` and LibreELEC and OpenWrt tree listings; [96boards Poplar NAS blog](https://www.96boards.org/blog/poplar-nas/); [Armbian forum thread](https://forum.armbian.com/topic/18910-armbian-for-hisilicon-hi3798mv300/); [LibreELEC forum thread](https://forum.libreelec.tv/thread/11361-install-libreelec-himedia-q5-pro/).
Unavailable (3): discuss.96boards.org (DNS fail, two attempts), web.archive.org (429), en.opensuse.org/HCL:Poplar (403). `leandrotsampa/hisilicon-kernel` wiki Home was a stub only.
Snippet-only, unfetched (about 15): CSDN/V2EX/cnblogs Hi3798 Ubuntu tutorials, glinuz/hi3798mv100, lucamot/HiSTB, teasiu/HiSTBLinuxKernel, Kodi/androidpctv/itvplus Q10 Pro threads, openSUSE HCL, Poplar "Build with source but not work" thread (2893, ENOTFOUND).
Queries that returned nothing: GitHub repo search `poplar+hi3798`, `himedia+q10`; `hi3798+armbian`; `poplar hi3798cv200 debian`; GitHub code search (401, unauthenticated); WebSearch for a Q10 Pro Linux port (no hit).
