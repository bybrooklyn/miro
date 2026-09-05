# Miro dev commands. Run `just` to list them.

# List recipes.
default:
    @just --list

# Use when deps look corrupt ("Cannot find module '@miro/*'") - a partial or emptied
# node_modules makes a plain `bun install` report "no changes" without recreating the
# workspace symlinks, so force a full reinstall. If packages still install as bare
# package.json + README (Bun's global cache corrupted - seen twice, PLAN.md gotchas), also
# `rm -rf ~/.bun/install/cache` first; everything is public now, so a cold cache costs a minute.
# Reinstall the workspace from scratch (nuke every node_modules, then reinstall).
renv:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    bun install --force
    @echo "✓ workspace reinstalled - run 'just check' to verify"

# Typecheck every package (there is no repo-wide tsc script otherwise).
check:
    for d in packages/* apps/*; do if [ -f "$d/tsconfig.json" ]; then echo "tsc: $d"; (cd "$d" && bunx tsc --noEmit) || exit 1; fi; done
    @echo "✓ all packages typecheck"

# Run the whole test suite (from repo root - bun test paths are cwd-relative).
test:
    bun test

# Run the daemon and the TUI client together.
dev:
    bun run dev
