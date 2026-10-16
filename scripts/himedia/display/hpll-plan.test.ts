import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parsePresets, rateOf, words } from "./hpll-plan.ts";

const patch = readFileSync(new URL("../kernel/arm32/0015-clk-hisilicon-hi3798cv200-hdmi-pixel-clock.patch", import.meta.url), "utf8");
const presets = parsePresets(patch);

describe("HPLL presets (patch 0015)", () => {
  test("all 26 community rows are present", () => {
    expect(presets.length).toBe(26);
  });

  test("every row's words equal the ctrl0/ctrl1 its comment claims", () => {
    for (const p of presets) {
      const w = words(p);
      expect({ rate: p.request, ctrl0: w.ctrl0, ctrl1: w.ctrl1 }).toEqual({ rate: p.request, ...p.comment });
    }
  });

  test("every row's PLL actually makes the rate it says (to 0.01 %)", () => {
    for (const p of presets) {
      const w = words(p);
      const hz = rateOf(w.ctrl0, w.ctrl1, p.rate > 340_000_000 ? 1 : 2);
      expect(Math.abs(hz - p.rate) / p.rate).toBeLessThan(1e-4);
    }
  });

  test("a request is within 1 % of what the PLL makes (mode_valid tolerance)", () => {
    for (const p of presets) expect(Math.abs(p.rate - p.request) / p.request).toBeLessThan(0.01);
  });

  test("the HDMI 2.0 rates sit on the /1 divider, the rest on /2", () => {
    for (const p of presets) {
      const w = words(p);
      // the other divider must NOT reproduce the rate: a row on the wrong divider is 2x off
      const wrong = rateOf(w.ctrl0, w.ctrl1, p.rate > 340_000_000 ? 2 : 1);
      expect(Math.abs(wrong - p.rate) / p.rate).toBeGreaterThan(0.4);
    }
  });

  test("the words fastboot left (measured, k19) are the 148.352 MHz plan = 59.94 Hz", () => {
    const hz = rateOf(0x14e6ae6a, 0x00001062, 2);
    expect(Math.abs(hz - 148_351_650)).toBeLessThan(100);
    // 1080p: htotal 2200 x vtotal 1125
    expect(hz / (2200 * 1125)).toBeCloseTo(59.94, 2);
  });

  test("the 60.000 Hz plan is 148.5 MHz exactly", () => {
    expect(rateOf(0x12000000, 0x00002063, 2)).toBe(148_500_000);
  });

  test("the preset for the boot rate is a different, equivalent plan", () => {
    const boot = rateOf(0x14e6ae6a, 0x00001062, 2);
    const p = presets.find((x) => x.request === 148_352_000)!;
    const w = words(p);
    expect(w.ctrl0).not.toBe(0x14e6ae6a);
    expect(Math.abs(rateOf(w.ctrl0, w.ctrl1, 2) - boot)).toBeLessThan(500);
  });
});
