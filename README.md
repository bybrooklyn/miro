# Miro

An AI that lives on your self-hosted server and actually runs it.

You say what you want running. Miro inspects the box, writes the compose, stands it up, wires it to
what is already there, keeps it healthy, updates it safely, and tells you when something needs you.
It learns your server as it goes, and it is built so that what it sends to an AI provider is
something you can see and switch off.

**Status: pre-1.0, and honest about it.** Every stage was proven against a real Debian box with real
systemd and real Docker before being called done - `PLAN.md` is the full design record and says what
is built, what is deferred, and what broke along the way.

## Install

On the server (Linux, systemd, root):

```sh
curl -fsSL https://raw.githubusercontent.com/bybrooklyn/miro/master/install.sh | sudo sh
```

That installs the daemon and the terminal client, pins its own Bun runtime, verifies the release
against its signed manifest before starting anything, and sets up a systemd unit that can update and
roll itself back. Then:

```sh
miro            # talk to it
mirod status    # one-glance health and setup readout
mirod egress    # exactly what has been sent to an AI provider, and what was redacted
```

Just the client, on your laptop (no root, nothing system-wide):

```sh
curl -fsSL https://raw.githubusercontent.com/bybrooklyn/miro/master/install.sh | sh -s -- --client
```

`--dry-run` prints every URL, path and system change without touching anything. `--uninstall`
removes Miro and keeps your data; `--purge` removes the data too. `--help` lists the rest.

## What it does

- **Runs apps as managed compose stacks** - deploy, update with exact image-ID rollback, edit, stop,
  remove, all as confirmed operations that verify and roll back on failure.
- **Learns an app once, then reuses it.** A verified install becomes a recipe; recipes that keep
  working get trusted, recipes that fail get demoted.
- **Teaches itself to operate software it has never seen** by inspecting it, reading its docs, and
  generating validated tools for it.
- **Keeps the box well-run**: off-box config backup, UPS/power monitoring with a graceful shutdown,
  reboot recovery, notifications to your phone only when something needs you.
- **Updates itself** and reverts automatically if the new version is unhealthy.
- **Private by default when you want it**: `local_only` mode pins every model choice to on-box models
  and refuses to fall back to the cloud; secrets and infrastructure identifiers are scrubbed from
  anything that does leave.

## Design

- `PLAN.md` - the living design record and decision log. Start here.
- `AGENTS.md` - how to build, test and work in the repo.

Bun + TypeScript monorepo: `apps/mirod` (the daemon), `apps/miro` (the terminal client),
`packages/*` (protocol, SDK, view-model, and the vendored agent runtime).

## License

AGPL-3.0-only. See `LICENSE`.
