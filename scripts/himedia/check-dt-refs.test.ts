import { test, expect, describe } from "bun:test";
import { parseDefines, parseRegistered, parseCrgRefs } from "./check-dt-refs.ts";

const HEADER = `
/* SPDX */
#define HISTB_APB_CLK            1
#define HISTB_COMBPHY1_CLK      33
#define HISTB_USB3_BUS_CLK      43
#define NOT_A_CLOCK_MACRO       99
`;

const DRIVER = `
#define HI3798CV200_COMBPHY1_MUX 80
static const struct hisi_mux_clock mux[] = {
  { HI3798CV200_COMBPHY1_MUX, "combphy1_mux", p, ARRAY_SIZE(p), 0, 0x188, 11, 1, 0, t },
};
static const struct hisi_gate_clock gate[] = {
  { HISTB_COMBPHY1_CLK, "clk_combphy1", "combphy1_mux", 0, 0x188, 10, 0, },
  { HISTB_USB3_BUS_CLK, "clk_u3_bus", NULL, 0, 0xb0, 0, 0, },
};
/* HISTB_APB_CLK is mentioned in a comment but never registered */
`;

describe("parseDefines", () => {
  test("takes HISTB_ and HI3798CV200_ macros only", () => {
    const d = parseDefines(HEADER + DRIVER);
    expect(d.get("HISTB_APB_CLK")).toBe(1);
    expect(d.get("HISTB_COMBPHY1_CLK")).toBe(33);
    expect(d.get("HI3798CV200_COMBPHY1_MUX")).toBe(80);
    expect(d.has("NOT_A_CLOCK_MACRO")).toBe(false);
  });
});

describe("parseRegistered", () => {
  test("a clock table entry counts as registration", () => {
    const r = parseRegistered(DRIVER);
    expect(r.has("HISTB_COMBPHY1_CLK")).toBe(true);
    expect(r.has("HISTB_USB3_BUS_CLK")).toBe(true);
    expect(r.has("HI3798CV200_COMBPHY1_MUX")).toBe(true);
  });

  // The whole point: being NAMED in a header is not being SUPPLIED by the driver.
  test("a mere mention is not registration", () => {
    expect(parseRegistered(DRIVER).has("HISTB_APB_CLK")).toBe(false);
  });
});

describe("parseCrgRefs", () => {
  test("collects clock ids across several cells", () => {
    const refs = parseCrgRefs(`
      xhci@98a0000 {
        clocks = <&crg 0x2b>, <&crg 0x2c>, <&crg 0x2d>, <&crg 0x2e>;
      };
    `);
    expect(refs).toHaveLength(1);
    expect(refs[0].prop).toBe("clocks");
    expect(refs[0].ids).toEqual([43, 44, 45, 46]);
  });

  // A reset is <&crg OFFSET BIT>: the first cell is a REGISTER OFFSET, not a clock id.
  // Checking it as a clock id would invent nine bogus failures per device tree.
  test("never reads a reset's register offset as a clock id", () => {
    const refs = parseCrgRefs(`hiahci { resets = <&crg 0xa8 0x8>, <&crg 0xa8 0x9>; };`);
    expect(refs).toHaveLength(0);
  });

  test("picks up assigned-clocks and its parents", () => {
    const refs = parseCrgRefs(`
      phy@858 {
        assigned-clocks = <&crg 0x50>;
        assigned-clock-parents = <&crg 0x42>;
      };
    `);
    expect(refs.map((r) => r.prop).sort()).toEqual(["assigned-clock-parents", "assigned-clocks"]);
    expect(refs.flatMap((r) => r.ids).sort((a, b) => a - b)).toEqual([66, 80]);
  });

  test("ignores clocks that do not come from &crg", () => {
    expect(parseCrgRefs(`node { clocks = <&sysclk 1>; };`)).toHaveLength(0);
  });

  test("ignores unrelated properties", () => {
    expect(parseCrgRefs(`node { phys = <&crg 0x5>; interrupts = <0 1 4>; };`)).toHaveLength(0);
  });
});

describe("the real failure this tool exists to catch", () => {
  test("the SATA clock ids are absent from mainline's header", () => {
    const d = parseDefines(HEADER);
    const byId = new Set([...d.values()]);
    for (const sata of [51, 52, 53, 54]) expect(byId.has(sata)).toBe(false);
  });
});

describe("a tree rendered back from a .dtb verifies NOTHING", () => {
  // dtc -I dtb replaces labels with numeric phandles. Reporting that as a pass was a real
  // false green in this repo: the validator looked clean while checking zero references.
  test("numeric phandles are not &crg references", () => {
    const rendered = `
      sata@9900000 {
        compatible = "generic-ahci";
        clocks = <0x07 0x33 0x07 0x34>;
      };
    `;
    expect(parseCrgRefs(rendered)).toHaveLength(0);
  });

  test("the same node in source form IS parsed", () => {
    const src = `sata@9900000 { clocks = <&crg 0x33>, <&crg 0x34>; };`;
    expect(parseCrgRefs(src)[0].ids).toEqual([51, 52]);
  });
});

describe("the SATA patch", () => {
  const PATCH = Bun.file(`${import.meta.dir}/kernel/0001-clk-hisilicon-crg-hi3798cv200-add-SATA-clocks.patch`);

  test("names all four ids in the public range, clear of driver-private ids", async () => {
    const text = await PATCH.text();
    const ids = [...text.matchAll(/^\+#define (HISTB_SATA_\w+)\s+(\d+)/gm)].map((m) => [m[1], Number(m[2])] as const);
    expect(ids).toHaveLength(4);
    for (const [, n] of ids) {
      expect(n).toBeGreaterThan(50);  // past the last existing public id
      expect(n).toBeLessThan(64);     // HI3798CV200_INNER_CLK_OFFSET — driver-private start
    }
  });

  test("registers all four as gates on CRG 0xa8, bits 0..3", async () => {
    const text = await PATCH.text();
    const gates = [...text.matchAll(/^\+\s+CLK_SET_RATE_PARENT, 0xa8, (\d+), 0 \},/gm)].map((m) => Number(m[1]));
    expect(gates.sort()).toEqual([0, 1, 2, 3]);
  });

  test("touches only the header and the CRG driver", async () => {
    const text = await PATCH.text();
    const targets = [...text.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    expect(targets.sort()).toEqual([
      "drivers/clk/hisilicon/crg-hi3798cv200.c",
      "include/dt-bindings/clock/histb-clock.h",
    ]);
  });
});
