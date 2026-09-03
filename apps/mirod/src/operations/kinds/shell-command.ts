import type { OperationKind } from "../engine";
import { classifyCommand, normalizePath, isSensitivePath, isLifelinePath, maxClass, redactSecretsInText } from "../classify";
import { runSandboxed, type SandboxResult } from "../sandbox";
import { snapshotPaths, restoreSnapshot, type Snapshot } from "../snapshot";

// The generic shell mutation (PLAN.md §5.4 B, §5.7). The model supplies the command, the scope it
// needs (writable roots + network), and optionally a verify command and a rollback command; the
// engine supplies confirmation, a snapshot of the declared roots before apply, the kernel sandbox
// during apply, verification, and rollback (snapshot restore, then the model's undo command).
// The classifier is the gate: a `forbidden` command never becomes an operation - the tool refuses
// before runOperation, and describe() refuses again as defence in depth.

export interface ShellCommandParams {
  command: string;
  writes: string[];
  network: boolean;
  verify?: string;
  rollback?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellCommandCaptured {
  snapshot: Snapshot;
}

/** Output of the last apply for a given params object, for the tool to hand back to the model -
 * runOperation itself only returns outcome + message. Keyed by object identity, so it cannot leak
 * across calls; entries are dropped once read. */
const outputs = new WeakMap<object, SandboxResult>();
export function takeOutput(params: object): SandboxResult | undefined {
  const r = outputs.get(params);
  outputs.delete(params);
  return r;
}

export const shellCommandKind: OperationKind<ShellCommandParams, ShellCommandCaptured> = {
  kind: "shell.command",

  async describe(p) {
    const c = classifyCommand(p.command);
    if (c.class === "forbidden") throw new Error(`refused: ${c.reasons.join("; ")}${c.alternative ? ` - ${c.alternative}` : ""}`);
    if (p.rollback) {
      const r = classifyCommand(p.rollback);
      if (r.class === "forbidden") throw new Error(`refused: rollback command - ${r.reasons.join("; ")}`);
    }
    // The declared scope is part of what is being approved (adversarial review: `tar -C /etc`
    // with writes:["/etc"] classified from the command text alone stayed `mutate`).
    const writes = p.writes.map((w) => normalizePath(w));
    const secret = writes.find((w) => isSensitivePath(w));
    if (secret) throw new Error(`refused: declared write scope ${secret} is Miro's own state or secret material`);
    if (writes.includes("/")) throw new Error("refused: a command cannot declare the whole filesystem writable");
    const cls = writes.some((w) => isLifelinePath(w)) ? maxClass(c.class, "lifeline") : c.class;
    const warning =
      cls === "lifeline"
        ? "can affect SSH, networking, or Miro itself"
        : cls === "destructive"
          ? "destroys data or is hard to reverse"
          : undefined;
    return {
      summary: `Run: ${p.command}`,
      autoApprove: false, // ponytail: maturity-based auto-approve for mutate lands with the ladder (§5.4 G)
      class: cls,
      writes,
      network: p.network,
      warning,
      expects: p.verify ? `the verify command (${p.verify}) exits 0 afterwards` : "no verify command declared - the outcome cannot be confirmed",
      rollbackWhen: p.rollback
        ? "verify fails or the command fails - the declared roots are restored from snapshot, then the undo command runs"
        : "verify fails or the command fails - the declared roots are restored from snapshot",
      scopeEvidence: "the roots the command itself declared writable",
      // An arbitrary command's effect cannot be predicted from its text (the classifier judges risk,
      // not outcome) - honestly "none", shown as "effect unknown" rather than a false "no changes".
      dryRunFidelity: "none",
      details: { command: p.command, reasons: c.reasons, verify: p.verify ?? null, rollback: p.rollback ?? null, cwd: p.cwd ?? null },
    };
  },

  async captureState(p) {
    // A random suffix, not just Date.now(): two shell ops capturing in the same millisecond would
    // otherwise write the same `shell-<ts>.tar` and one op's rollback would restore the other's
    // bytes (audit E3). trash.ts adds the same for the same reason.
    return { snapshot: await snapshotPaths(p.writes, `shell-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`) };
  },

  async apply(p) {
    // Capabilities kept: a mutate operation may legitimately need root's (apt, dpkg, chown). Reads
    // drop them all; this is confirmed, scoped, snapshotted, and verified instead.
    const r = await runSandboxed(["sh", "-c", p.command], { writableRoots: p.writes, network: p.network, cwd: p.cwd, timeoutMs: p.timeoutMs, keepCapabilities: true });
    outputs.set(p, r);
    if (r.exitCode !== 0) {
      // Redact: this message flows to the model, to operations.error, to an incident memory row,
      // and into a Dreaming reflection prompt sent to a real provider (audit L1).
      throw new Error(`exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}: ${redactSecretsInText((r.stderr || r.stdout).trim().slice(0, 2000))}`);
    }
  },

  async verify(p) {
    if (!p.verify) return true;
    // Read-only view of the same roots apply wrote, so verify can see its work but not change it.
    const r = await runSandboxed(["sh", "-c", p.verify], { writableRoots: [], visibleRoots: p.writes, network: p.network, timeoutMs: 60_000 });
    return r.exitCode === 0;
  },

  async rollback(p, captured) {
    await restoreSnapshot(captured.snapshot).catch((err) => console.error("[mirod] snapshot restore failed", err));
    if (p.rollback) {
      await runSandboxed(["sh", "-c", p.rollback], { writableRoots: p.writes, network: p.network, timeoutMs: 60_000, keepCapabilities: true }).catch(() => {});
    }
  },
};
