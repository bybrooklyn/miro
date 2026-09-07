import { test, expect } from "bun:test";
import { parseUpsc, upsStatusFrom } from "./power";

const SAMPLE = `battery.charge: 55
battery.runtime: 900
ups.mfr: Miro
ups.model: SimUPS
ups.status: OB DISCHRG`;

test("parseUpsc keeps multi-word values whole", () => {
  const v = parseUpsc(SAMPLE);
  expect(v["ups.status"]).toBe("OB DISCHRG");
  expect(v["battery.charge"]).toBe("55");
});

test("upsStatusFrom: OL is on-line, not on battery, not low", () => {
  const s = upsStatusFrom("ups@localhost", { "ups.status": "OL", "battery.charge": "100" });
  expect(s.onBattery).toBe(false);
  expect(s.lowBattery).toBe(false);
  expect(s.charge).toBe(100);
});

test("upsStatusFrom: OB DISCHRG is on battery but not yet low", () => {
  const s = upsStatusFrom("ups@localhost", parseUpsc(SAMPLE));
  expect(s.onBattery).toBe(true);
  expect(s.lowBattery).toBe(false);
  expect(s.charge).toBe(55);
  expect(s.runtimeSec).toBe(900);
});

test("upsStatusFrom: OB LB is the low-battery trigger", () => {
  const s = upsStatusFrom("ups@localhost", { "ups.status": "OB LB", "battery.charge": "8" });
  expect(s.onBattery).toBe(true);
  expect(s.lowBattery).toBe(true);
});

test("upsStatusFrom: missing numbers are null, not NaN", () => {
  const s = upsStatusFrom("ups@localhost", { "ups.status": "OL" });
  expect(s.charge).toBeNull();
  expect(s.runtimeSec).toBeNull();
});
