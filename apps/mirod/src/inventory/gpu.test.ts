import { test, expect } from "bun:test";
import { parseLspci, detectGpus } from "./gpu";

test("parseLspci extracts VGA/3D/Display devices from `lspci -mm` output", () => {
  const output = [
    '00:02.0 "VGA compatible controller" "Intel Corporation" "UHD Graphics 630"',
    '01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA104 [GeForce RTX 3070]"',
    '02:00.0 "Ethernet controller" "Intel Corporation" "I219-V"',
  ].join("\n");
  expect(parseLspci(output)).toEqual([
    { vendor: "Intel Corporation", model: "UHD Graphics 630" },
    { vendor: "NVIDIA Corporation", model: "GA104 [GeForce RTX 3070]" },
  ]);
});

test("parseLspci returns nothing when there's no GPU-class device", () => {
  expect(parseLspci('00:1f.3 "Audio device" "Intel Corporation" "Sunrise Point-LP HD Audio"')).toEqual([]);
});

test(
  "detectGpus reports unavailable on this dev box (no lspci on macOS, real check)",
  async () => {
    const result = await detectGpus();
    expect(result.available).toBe(false);
    expect(result.gpus).toEqual([]);
    expect(result.hasNvidiaSmi).toBe(false);
    expect(result.hasDriRenderNodes).toBe(false);
  },
  // See network.test.ts's getTailscaleStatus test for why this retries.
  { timeout: 10000, retry: 2 },
);
