import { existsSync, writeFileSync, mkdirSync, chmodSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import type { OperationKind } from "../engine";
import { isSensitivePath, isLifelinePath, realTarget, redactSecretsInText } from "../classify";
import { substituteSecrets } from "./http-mutation";

// Write a secret-bearing file - an env_file, a config with a password - from a template whose
// `{{secret:<ref>}}` placeholders are resolved at apply time (PLAN.md VPN slice). The reference-safe
// way to get a secret into a container's environment (gluetun's WireGuard/OpenVPN creds) or an app's
// config file WITHOUT the value ever reaching the model, the approval plan, or a committed file: the
// plan shows the template with placeholders, the resolved file lands 0600, and the path is outside
// the backup allowlist so it never leaves the box. Mirrors http-mutation's substituteSecrets, applied
// to a file instead of a request.

export interface SecretFileParams {
  path: string;
  /** File content with at least one {{secret:<ref>}} placeholder, resolved at apply time. */
  template: string;
  reason?: string;
}

export interface SecretFileCaptured {
  existed: boolean;
}

export function secretFileKind(getSecret: (ref: string) => string | null): OperationKind<SecretFileParams, SecretFileCaptured> {
  return {
    kind: "secret.file",

    async describe(p) {
      const real = realTarget(p.path);
      if (isSensitivePath(p.path) || isSensitivePath(real)) throw new Error(`refused: ${p.path} is secret material Miro manages itself, not writable through a generic operation`);
      if (!/\{\{secret:/.test(p.template)) throw new Error("refused: secret_file is for files that carry a secret - use file_write for content with no {{secret:<ref>}} placeholder");
      const lifeline = isLifelinePath(p.path) || isLifelinePath(real);
      return {
        summary: `Write ${p.path} with resolved secrets (${Buffer.byteLength(p.template)} bytes, mode 0600)`,
        autoApprove: false,
        class: lifeline ? "lifeline" : "mutate",
        writes: [dirname(real)],
        network: false,
        warning: lifeline ? "this file can affect SSH, networking, or Miro itself" : undefined,
        // The template (placeholders) is shown; the resolved value never appears in the plan.
        details: { path: p.path, template: redactSecretsInText(p.template), mode: "0600" },
        expects: `${p.path} exists with the resolved content (its secret values are never shown)`,
        rollbackWhen: "verify fails, or a referenced secret is unset - a file this operation created is removed",
        scopeEvidence: "only the file's own directory; written 0600 so only the daemon user can read it",
        dryRunFidelity: "partial",
      };
    },

    async captureState(p) {
      // Only whether it existed - never the prior CONTENT, which would put a secret into the
      // operations table (and thus the redacted-but-still state export). A created file is removed on
      // rollback; a pre-existing secret file is left as written (its prior secret content is not
      // recoverable here, by design). ponytail: no prior-content capture for secret files.
      return { existed: existsSync(p.path) };
    },

    async apply(p) {
      const resolved = substituteSecrets(p.template, getSecret); // throws if a referenced secret is unset
      mkdirSync(dirname(p.path), { recursive: true });
      writeFileSync(p.path, resolved, { mode: 0o600 });
      chmodSync(p.path, 0o600); // enforce 0600 even if the file pre-existed with looser perms
    },

    async verify(p) {
      return existsSync(p.path) && statSync(p.path).size > 0;
    },

    async rollback(p, captured) {
      if (!captured.existed) {
        try {
          unlinkSync(p.path);
        } catch {
          // best effort
        }
      }
    },

    // Its verify would re-read a secret file; nothing model-safe to re-check for drift.
    prodtest: () => null,
  };
}
