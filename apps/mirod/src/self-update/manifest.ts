import type { Channel } from "./github";

// The signed release manifest (PLAN.md §5.16): the one artifact Sigstore signs. It carries the
// version, the human-facing summary/notes shown at the update prompt, and - crucially - the tarball's
// sha256, so verifying the manifest's signature and then matching the download's digest to it extends
// trust from the signature to the (unsigned) tarball. release.yml writes it; verify.ts checks its
// signature; fetch.ts matches the digest.

export interface UpdateManifest {
  schema: 1;
  version: string;
  channel: Channel;
  /** One line shown directly at the update prompt. */
  summary: string;
  /** Full release notes, shown on request. */
  notes: string;
  commit: string;
  artifact: { name: string; sha256: string; size: number };
  createdAt: number;
}

/** Parse and shape-check a manifest's bytes. Throws on anything malformed - a manifest that does not
 * parse is a failed verification, never a silent default. */
export function parseManifest(bytes: Uint8Array | string): UpdateManifest {
  const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
  const m = JSON.parse(text) as Record<string, unknown>;
  const a = m.artifact as Record<string, unknown> | undefined;
  if (
    m.schema !== 1 ||
    typeof m.version !== "string" ||
    (m.channel !== "stable" && m.channel !== "beta") ||
    typeof m.summary !== "string" ||
    typeof m.notes !== "string" ||
    typeof m.commit !== "string" ||
    !a ||
    typeof a.name !== "string" ||
    typeof a.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(a.sha256) ||
    typeof a.size !== "number"
  ) {
    throw new Error("malformed update manifest");
  }
  return {
    schema: 1,
    version: m.version,
    channel: m.channel,
    summary: m.summary,
    notes: m.notes,
    commit: m.commit,
    artifact: { name: a.name, sha256: a.sha256, size: a.size },
    createdAt: typeof m.createdAt === "number" ? m.createdAt : 0,
  };
}

/** Hex sha256 of a file. ponytail: reads the whole file into memory - update tarballs are a few MB;
 * stream it if artifacts ever get large. */
export async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}
