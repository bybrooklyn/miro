import { Database } from "bun:sqlite";
import { DB_PATH } from "@miro/protocol";
import { ensureDevicesTable, listDevices, revokeDevice } from "./store";

// `mirod devices` / `mirod devices revoke <id>` - see and cut off the devices that can reach this box
// remotely (deploy-anywhere PR 2). Runs and exits before the daemon boots, like the other CLIs, so it
// works over ssh whether or not a TUI is connected. A revoked token is refused on its next connection.
export async function maybeRunDevicesCli(): Promise<boolean> {
  const argv = process.argv.slice(2);
  if (argv[0] !== "devices") return false;
  const db = new Database(DB_PATH);
  ensureDevicesTable(db);

  if (argv[1] === "revoke") {
    const id = argv[2];
    if (!id) {
      console.error("usage: mirod devices revoke <id>");
      db.close();
      process.exit(2);
    }
    const ok = revokeDevice(db, id);
    console.log(ok ? `Revoked ${id}. Its next connection is refused.` : `Nothing to revoke: no active device with id ${id}.`);
    db.close();
    return true;
  }

  const rows = listDevices(db);
  db.close();
  if (rows.length === 0) {
    console.log("No paired devices. The local socket needs no pairing; run /pair in the TUI to invite a remote one.");
    return true;
  }
  const when = (t: number | null) => (t === null ? "never" : new Date(t).toISOString().replace("T", " ").slice(0, 16));
  console.log(`Paired devices (${rows.length}):\n`);
  for (const d of rows) {
    const state = d.revokedAt === null ? "active " : "REVOKED";
    console.log(`  ${state}  ${d.id}  ${d.name.padEnd(24)}  via ${d.transport}  paired ${when(d.createdAt)}  last seen ${when(d.lastSeenAt)}`);
  }
  console.log("\nRevoke one with: mirod devices revoke <id>");
  return true;
}
