import { join } from "node:path";
import { existsSync, mkdirSync, symlinkSync, lstatSync, rmSync, renameSync } from "node:fs";
import { MIRO_DIR } from "@miro/protocol";

// Generated extensions live outside the repo tree, deliberately - this project's own live-
// verification workflow does `rm -rf apps && tar xzf ...` on every VM resync (see PLAN.md's
// gotchas), which would silently delete anything generated under apps/mirod/. ~/.miro/extensions/
// is server-specific runtime state, same tier as the DB and secret key file.

export const EXTENSIONS_DIR = join(MIRO_DIR, "extensions");

/** apps/mirod's own node_modules - what every extension directory's node_modules symlink points
 * at, so generated code's `import ... from "@miro/sdk"` resolves. */
export const MIROD_NODE_MODULES = join(import.meta.dir, "../../node_modules");

/** An app name is a path segment under EXTENSIONS_DIR and a tool-name part. It comes from the
 * model's app_learn argument (which app docs can steer), so it is validated here, at the one place
 * every extension path is built: "../../etc/ssh" resolved to a real directory that promotion then
 * renamed aside, as root, with no engine in the way (audit A2). */
export const APP_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertAppName(app: string): string {
  if (!APP_NAME.test(app)) throw new Error(`"${app}" is not an app name (lowercase letters, digits, - and _, up to 64 characters)`);
  return app;
}

export function extensionDir(app: string): string {
  return join(EXTENSIONS_DIR, assertAppName(app));
}
export function stagingDir(app: string): string {
  return join(EXTENSIONS_DIR, `${assertAppName(app)}.staging`);
}
export function prevDir(app: string): string {
  return join(EXTENSIONS_DIR, `${assertAppName(app)}.prev`);
}

/** Generated code does `import ... from "@miro/sdk"` - normal resolution needs a node_modules to
 * walk up into, but an extension directory lives outside any workspace glob. Fix: a symlink into
 * the daemon's own node_modules, the same mechanism workspace hoisting already uses internally,
 * just applied across this one extra filesystem boundary. Recreated defensively every time a
 * directory is prepared (staging write, or daemon boot for already-promoted extensions) - cheap,
 * idempotent, matches ensureOperationsTable/ensureMemoryTable's own "just always ensure it" style. */
export function ensureNodeModulesSymlink(dir: string, mirodNodeModules: string): void {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "node_modules");
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) return; // already correct (or at least already a symlink - good enough)
    rmSync(target, { recursive: true, force: true });
  }
  symlinkSync(mirodNodeModules, target, "dir");
}

/** Promotion: current `<app>/` -> `<app>.prev/` (overwriting any older .prev - one generation of
 * rollback history only), then `<app>.staging/` -> `<app>/`. */
export function promoteStagingToLive(app: string): void {
  const live = extensionDir(app);
  const staging = stagingDir(app);
  const prev = prevDir(app);
  if (existsSync(prev)) rmSync(prev, { recursive: true, force: true });
  if (existsSync(live)) renameSync(live, prev);
  renameSync(staging, live);
}

export function discardStaging(app: string): void {
  const staging = stagingDir(app);
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
}
