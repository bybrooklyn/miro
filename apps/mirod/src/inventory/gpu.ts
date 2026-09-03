import { existsSync, readdirSync } from "node:fs";
import { commandExists, run } from "./exec";

// GPU/accelerator awareness (plan §24) - for diagnosis and configuration only, not a hardware
// dashboard. Real Linux tooling (lspci, /dev/dri); graceful "not available" everywhere else,
// same pattern as the rest of inventory/.

export interface GpuDevice {
  vendor: string;
  model: string;
}

export interface GpuDetectionResult {
  available: boolean;
  gpus: GpuDevice[];
  hasNvidiaSmi: boolean;
  hasDriRenderNodes: boolean;
}

/** Parses `lspci -mm` output, keeping only VGA/3D/Display class devices. */
export function parseLspci(output: string): GpuDevice[] {
  const gpus: GpuDevice[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    // lspci -mm: `01:00.0 "VGA compatible controller" "NVIDIA Corporation" "GA104 [GeForce RTX 3070]" ...`
    const match = line.match(/^\S+\s+"([^"]+)"\s+"([^"]+)"\s+"([^"]+)"/);
    if (!match) continue;
    const [, deviceClass, vendor, model] = match;
    if (/VGA|3D|Display/i.test(deviceClass)) gpus.push({ vendor, model });
  }
  return gpus;
}

function hasDriRenderNode(): boolean {
  if (!existsSync("/dev/dri")) return false;
  try {
    return readdirSync("/dev/dri").some((f) => f.startsWith("renderD"));
  } catch {
    return false;
  }
}

export async function detectGpus(): Promise<GpuDetectionResult> {
  const hasNvidiaSmi = await commandExists("nvidia-smi");
  const hasDriRenderNodes = hasDriRenderNode();

  if (!(await commandExists("lspci"))) {
    return { available: false, gpus: [], hasNvidiaSmi, hasDriRenderNodes };
  }
  try {
    const output = await run("lspci", ["-mm"]);
    return { available: true, gpus: parseLspci(output), hasNvidiaSmi, hasDriRenderNodes };
  } catch {
    return { available: false, gpus: [], hasNvidiaSmi, hasDriRenderNodes };
  }
}
