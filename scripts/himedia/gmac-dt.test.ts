import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const DTS = readFileSync(`${import.meta.dir}/kernel/arm32/hi3798cv200-himedia-q10-pro.dts`, "utf8");
const BUILD = readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const gmac1 = strip(DTS).match(/&gmac1\s*\{([\s\S]*?)\n\};/)![1];

/*
 * ⛔ hix5hd2_gmac registers its MDIO bus on the gmac node and of_mdio scans DIRECT children
 * only. An `mdio {}` wrapper loses the PHY silently: the kernel ran every initcall and the box
 * never appeared on the LAN (2026-10-10).
 */
test("the PHY is a direct child of &gmac1, with no mdio wrapper", () => {
  expect(gmac1).not.toMatch(/\bmdio\s*\{/);
  // address 1 is MEASURED from the vendor kernel (f9841000.etherne:01, RTL8211E); 3 was copied and wrong
  expect(gmac1).toMatch(/ethernet-phy@1\s*\{\s*reg = <1>;/);
  expect(gmac1).not.toMatch(/reg = <3>/);
  expect(gmac1).toMatch(/#address-cells = <1>;/);
  expect(gmac1).toMatch(/#size-cells = <0>;/);
});

test("phy-reset delays are present, because the resolved reset makes them mandatory", () => {
  // the vendor timing (higmac/board.c: 20 ms pulse, >= 50 ms before MDIO), not Poplar 10/30
  expect(gmac1).toMatch(/hisilicon,phy-reset-delays-us = <10000 20000 100000>;/);
});

test("the phy reset provider is required, and the gate demands =y not =m", () => {
  expect(BUILD).toMatch(/\["RESET_TI_SYSCON",/);
  expect(BUILD).toContain('grep -q "^CONFIG_\\${opt}=y" .config');
  expect(BUILD).not.toContain('grep -q "^CONFIG_\\${opt}=[ym]" .config');
});

/*
 * ⛔ The vendor's host init releases PHY port 1's reset (TREQ1), not port 0 (the OTG port).
 * With only port 0, port 1 stayed in reset and the stick never enumerated (NO_STICK x2).
 */
test("xhci1 (f98b0000, where the stick lives) uses the vendor's PHY and reset", () => {
  const x = strip(DTS).match(/xhci1: usb@98b0000\s*\{([\s\S]*?)\n\t\};/);
  expect(x).not.toBeNull();
  // MEASURED from vendor clk-hiusb3.c hiclk_enable_usb3_host1: the 1-port PHY + VCC reset bit 28
  expect(x![1]).toMatch(/phys = <&usb2_phy2_port0>;/);
  expect(x![1]).toMatch(/resets = <&crg 0xb0 28>;/);
  expect(x![1]).toMatch(/phys-names = "inno";/);   // what xhci-histb.c actually reads
  expect(x![1]).toMatch(/status = "okay";/);
  // EHCI/OHCI never share the stick's PHY. They DO own usb2_phy1_port1: that is the side USB2
  // socket — releasing its reset enumerated a keyboard receiver on OHCI (2026-10-12, measured).
  // The 2026-10-10 version of this test forbade port 1 here, from before the socket was found.
  for (const n of ["ohci", "ehci"]) {
    const m = strip(DTS).match(new RegExp(`&${n}\\s*\\{([\\s\\S]*?)\\n\\};`));
    expect(m![1]).not.toMatch(/usb2_phy2_port0/);
    expect(m![1]).toMatch(/phys = <&usb2_phy1_port1>;/);
  }
});

/*
 * ⛔ The soc dma-ranges window must cover every byte the kernel can hand a DMA master. arm32
 * placed CMA at 0x76800000; with the arm64 tree's 1 GiB window every coherent allocation got
 * DMA_MAPPING_ERROR — gmac queues at 0xFFFFFFFF, xHCI halted on HSE (2026-10-11).
 */
test("soc dma-ranges covers all RAM the bootargs give the kernel", () => {
  const dtsi = strip(readFileSync(`${import.meta.dir}/kernel/arm32/hi3798cv200.dtsi`, "utf8"));
  const m = dtsi.match(/dma-ranges = <0x0 0x0 (0x[0-9a-f]+)>;/);
  expect(m).not.toBeNull();
  const mem = BUILD.match(/mem=(\d+)M/);
  expect(mem).not.toBeNull();
  expect(parseInt(m![1], 16)).toBeGreaterThanOrEqual(Number(mem![1]) * 1024 * 1024);
});
