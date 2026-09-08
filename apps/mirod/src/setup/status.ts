import type { Database } from "bun:sqlite";

// Setup status + the "well-run server" gap analysis (PLAN.md magic-setup slice). One source of truth
// for: (a) the proactive proposal nudge in the context block - Miro offers to close the gaps as one
// plan; (b) the config_status read tool; (c) the `mirod status` CLI. Keys off the settings the setup
// tools write on commit, so "configured" means genuinely wired, not merely attempted.

export interface Gap {
  key: string;
  label: string;
  /** The tool(s) that close this gap - fed to the agent so its proposal is actionable. */
  how: string;
}

export interface SetupStatus {
  configured: string[];
  gaps: Gap[];
}

/** One setting, or null - shared so any read path (context block, status) survives a missing table. */
export function readSetting(db: Database, key: string): string | null {
  return get(db, key);
}

function get(db: Database, key: string): string | null {
  // Defensive: a caller (a test, an early-boot path) may not have the settings table yet - treat a
  // missing table as "nothing configured", never throw (buildContextBlock rides on this).
  try {
    return (db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
  } catch {
    return null;
  }
}

export function computeSetupStatus(db: Database): SetupStatus {
  const configured: string[] = [];
  const gaps: Gap[] = [];

  if (get(db, "backup.enabled") === "true") configured.push(`config backup → ${get(db, "backup.repo") ?? "(local repo)"}`);
  else gaps.push({ key: "backup", label: "off-box config backup", how: "backup_configure(enable:true) then backup_now" });

  if (get(db, "notify.ntfy.url") || get(db, "notify.gotify.url")) configured.push("phone notifications");
  else gaps.push({ key: "notifications", label: "phone notifications", how: "ntfy_install (self-host) or notify_configure (an existing ntfy/Gotify)" });

  const ups = get(db, "power.ups");
  if (ups) configured.push(`UPS/power monitoring → ${ups}`);
  else gaps.push({ key: "ups", label: "UPS/power monitoring", how: "nut_install" });

  // Update checks read the public releases of a public repo, so no credential is needed at all - the
  // daily check is on by default and this is a configured item, not a gap. A token is still honoured
  // (provider.github) for a private fork or to lift the unauthenticated API rate limit.
  configured.push(hasSecret(db, "provider.github") ? "automatic update checks (authenticated)" : "automatic update checks");

  return { configured, gaps };
}

function hasSecret(db: Database, ref: string): boolean {
  try {
    return !!db.query("SELECT 1 FROM secrets WHERE ref = ?").get(ref);
  } catch {
    return false;
  }
}

/** Context-block lines nudging the agent to OFFER the missing baseline as one plan (PLAN.md magic
 * setup: draft-a-plan-then-confirm). Empty when the baseline is fully set up. Deliberately says
 * "offer once, don't nag" - the magic is a helpful proposal, not pestering. */
export function setupGapLines(db: Database): string[] {
  const { gaps } = computeSetupStatus(db);
  if (gaps.length === 0) return [];
  return [
    `Well-run-server baseline not yet set up: ${gaps.map((g) => g.label).join(", ")}. ` +
      `When it fits (a fresh session, or once you've done what the owner asked), proactively OFFER to set these up as ONE plan (a system_plan) the owner can approve-all / pick / skip - offer once, never nag or re-offer something declined. How: ${gaps.map((g) => `${g.label} → ${g.how}`).join("; ")}.`,
  ];
}
