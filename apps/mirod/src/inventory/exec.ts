import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

export async function run(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024, timeout: opts.timeoutMs });
  return stdout;
}
