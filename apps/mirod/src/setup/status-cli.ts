import { Database } from "bun:sqlite";
import { DB_PATH } from "@miro/protocol";
import { computeSetupStatus } from "./status";
import { computeSeverity } from "../operations/severity";

// `mirod status` - a one-glance config/health readout (PLAN.md magic-setup slice), the "manage from
// anywhere" surface over SSH. Runs and exits before the daemon boots; opens its own DB handle (WAL,
// safe alongside a running daemon). computeSeverity reads the live box, so this reflects real health.
export async function maybeRunStatusCli(): Promise<boolean> {
  if (process.argv.slice(2)[0] !== "status") return false;
  const db = new Database(DB_PATH);
  const s = computeSetupStatus(db);
  let health: number | string;
  try {
    health = await computeSeverity(db);
  } catch {
    health = "unknown";
  }
  console.log(`Miro status  (health severity: ${health})`);
  console.log("\nConfigured:");
  if (s.configured.length) for (const c of s.configured) console.log(`  ✓ ${c}`);
  else console.log("  (nothing yet)");
  console.log("\nMissing from the well-run baseline:");
  if (s.gaps.length) for (const g of s.gaps) console.log(`  • ${g.label}  —  ${g.how}`);
  else console.log("  (all set)");
  db.close();
  return true;
}
