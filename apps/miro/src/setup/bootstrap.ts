import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BootstrapProbeResult {
  reachable: boolean;
  output: string;
}

/**
 * Attempts a real, non-interactive SSH connection to confirm access before ever running the
 * actual install payload (`curl -fsSL https://miro.computer/install | sudo sh`, plan §10). This
 * only runs a harmless remote echo - it never installs anything. BatchMode disables password
 * prompts, so a missing key or unreachable host fails fast instead of hanging on stdin.
 */
export async function probeSshAccess(
  host: string,
  options: { user?: string; port?: number; timeoutSeconds?: number; identityFile?: string } = {},
): Promise<BootstrapProbeResult> {
  const { user, port = 22, timeoutSeconds = 5, identityFile } = options;
  const target = user ? `${user}@${host}` : host;
  const identityArgs = identityFile ? ["-i", identityFile, "-o", "IdentitiesOnly=yes"] : [];
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-o", "BatchMode=yes",
        "-o", `ConnectTimeout=${timeoutSeconds}`,
        "-o", "StrictHostKeyChecking=accept-new",
        ...identityArgs,
        "-p", String(port),
        target,
        "echo miro-bootstrap-probe-ok",
      ],
      { timeout: (timeoutSeconds + 2) * 1000 },
    );
    return { reachable: stdout.includes("miro-bootstrap-probe-ok"), output: stdout.trim() };
  } catch (err: any) {
    return { reachable: false, output: String(err.stderr || err.message || "").trim() };
  }
}

/** The real one-liner - `install.sh` at the repo root, served raw from the public repo. Was a
 * miro.computer URL that never existed; a domain can front this later without changing callers. */
export function installCommand(): string {
  return "curl -fsSL https://raw.githubusercontent.com/bybrooklyn/miro/master/install.sh | sudo sh";
}
