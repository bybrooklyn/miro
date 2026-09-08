import { Database } from "bun:sqlite";
import { DB_PATH } from "@miro/protocol";
import { recentEgress } from "../agent/egress-store";

// `mirod egress [n]` - show exactly what left this box for an AI provider (PLAN.md private-by-default
// pillar). The audit trail never held content, only: when, which provider, at what trust, the content
// tier that left, and what was scrubbed. This is the surface the table never had - it was write-only,
// so the owner could not answer "what did you send?" without opening SQLite by hand.
export async function maybeRunEgressCli(): Promise<boolean> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "egress") return false;
  const limit = Number(argv[1]) || 50;
  const db = new Database(DB_PATH);
  const rows = recentEgress(db, limit);
  db.close();
  if (rows.length === 0) {
    console.log("No egress recorded. (Only sensitivity-bearing egresses are logged unless egress.log_all is on.)");
    return true;
  }
  console.log(`What left this box, newest first (${rows.length}):\n`);
  for (const r of rows) {
    const scrub = [r.secretRedacted ? "secrets redacted" : null, r.infraRedacted > 0 ? `${r.infraRedacted} infra identifier(s) redacted` : null]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${new Date(r.at).toISOString()}  ${r.provider} (trust ${r.trust})  content ${r.contentTier}${scrub ? `  [${scrub}]` : ""}`);
  }
  console.log("\nContent itself is never recorded. Set egress.log_all=true for a full trail, or privacy.mode=local_only so nothing leaves at all.");
  return true;
}
