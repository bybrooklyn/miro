import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { OperationKind } from "../engine";
import { classifyCommand, normalizePath, realTarget, isSensitivePath, holdsSecretMaterial, isLifelinePath, isLifelineRoot, maxClass, redactSecretsInText } from "../classify";
import { runSandboxed, type SandboxResult } from "../sandbox";
import { snapshotPaths, restoreSnapshot, sizeOf, SNAPSHOT_MAX_BYTES, type Snapshot } from "../snapshot";

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
  /** The planner's declaration that `verify` describes a lasting state (drift detection re-runs it). */
  verifyKeeps?: boolean;
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
  // Prodtest: only a verify the planner declared as LASTING is re-run (read-only sandbox). A verify
  // is a step's post-condition by default - found live: re-running every one flagged half of a
  // real Jellyfin setup as drift because its checks described mid-sequence states (PLAN.md §5.24).
  prodtest: (p) => (p.verify && p.verifyKeeps ? p.command : null),

  async describe(p) {
    const c = classifyCommand(p.command);
    if (c.class === "forbidden") throw new Error(`refused: ${c.reasons.join("; ")}${c.alternative ? ` - ${c.alternative}` : ""}`);
    if (p.rollback) {
      const r = classifyCommand(p.rollback);
      if (r.class === "forbidden") throw new Error(`refused: rollback command - ${r.reasons.join("; ")}`);
    }
    // The declared scope is part of what is being approved (adversarial review: `tar -C /etc`
    // with writes:["/etc"] classified from the command text alone stayed `mutate`). Judged on the
    // declared path AND on what it resolves to: a bind mount follows the symlink, so
    // `/srv/app/data -> /etc` would otherwise be approved as /srv/app/data and mounted as /etc
    // (audit A5). The plan shows the declared paths - what the owner reads.
    const writes = p.writes.map((w) => normalizePath(w));
    const judged = [...new Set([...writes, ...writes.map(realTarget)])];
    const secret = judged.find((w) => isSensitivePath(w) || holdsSecretMaterial(w));
    if (secret) throw new Error(`refused: declared write scope ${secret} is, or contains, Miro's own state or secret material - name the exact directory the command writes (/etc, /var, /root, /home are never a scope)`);
    if (judged.includes("/")) throw new Error("refused: a command cannot declare the whole filesystem writable");
    // A root that does not exist and is named like a file: the sandbox creates a DIRECTORY there
    // (mkdir -p), the command's write then fails and the directory litters the host (audit B3).
    const fileLike = p.writes.find((w) => !existsSync(w) && /\.[A-Za-z0-9]{1,6}$/.test(basename(w)) && !basename(w).endsWith(".d"));
    if (fileLike) throw new Error(`refused: declared write root ${fileLike} does not exist and looks like a file - declare its parent directory (roots are directories, sockets, or existing files)`);
    const cls = judged.some((w) => isLifelinePath(w) || isLifelineRoot(w)) ? maxClass(c.class, "lifeline") : c.class;
    // The snapshot cap is known now, not only in captureState: promising "restored from snapshot"
    // for roots that will exceed it made rollback a silent no-op (audit A13).
    let snapshotBytes = 0;
    for (const w of writes) if (existsSync(w)) snapshotBytes += sizeOf(w, SNAPSHOT_MAX_BYTES);
    const overCap = snapshotBytes > SNAPSHOT_MAX_BYTES;
    const warnings = [
      cls === "lifeline" ? "can affect SSH, networking, or Miro itself" : cls === "destructive" ? "destroys data or is hard to reverse" : undefined,
      overCap ? `the declared roots exceed the ${Math.round(SNAPSHOT_MAX_BYTES / 1e6)} MB snapshot cap - nothing is snapshotted${p.rollback ? "; only the undo command can revert" : ", and no undo command was declared"}` : undefined,
    ].filter(Boolean);
    return {
      summary: `Run: ${p.command}`,
      autoApprove: false, // ponytail: maturity-based auto-approve for mutate lands with the ladder (§5.4 G)
      class: cls,
      writes,
      network: p.network,
      warning: warnings.length ? warnings.join("; ") : undefined,
      irreversible: overCap && !p.rollback ? true : undefined,
      expects: p.verify ? `the verify command (${p.verify}) exits 0 afterwards` : "no verify command declared - the outcome cannot be confirmed",
      rollbackWhen: overCap
        ? p.rollback
          ? "verify fails or the command fails - the undo command runs (the roots are too large to snapshot)"
          : "never - the roots are too large to snapshot and no undo command was declared"
        : p.rollback
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
