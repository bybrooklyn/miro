# Miro dev commands. Run `just` to list them.

# List recipes.
default:
    @just --list

# Use when deps look corrupt ("Cannot find module '@miro/*'" or "'@earendil-works/*'")
# — a partial or emptied node_modules makes a plain `bun install` report "no changes"
# without recreating the workspace symlinks, so force a full reinstall.
# NEVER wipe ~/.bun/install/cache here: the private pi.dev packages are slow and hard
# to refetch, and a warm cache makes this reset take seconds.
# Reinstall the workspace from scratch (nuke every node_modules, then reinstall).
renv:
    rm -rf node_modules apps/*/node_modules packages/*/node_modules
    bun install --force
    @echo "✓ workspace reinstalled — run 'just check' to verify"

# Typecheck every package (there is no repo-wide tsc script otherwise).
check:
    cd packages/sdk && bunx tsc --noEmit
    cd packages/protocol && bunx tsc --noEmit
    cd apps/mirod && bunx tsc --noEmit
    cd apps/miro && bunx tsc --noEmit
    @echo "✓ all packages typecheck"

# Run the whole test suite (from repo root — bun test paths are cwd-relative).
test:
    bun test

# Run the daemon and the TUI client together.
dev:
    bun run dev
