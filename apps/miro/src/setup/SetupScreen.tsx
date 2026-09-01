import { useEffect, useState } from "react";
import { discoverSshHosts, type SshHostEntry } from "./ssh-discovery";
import { probeSsh } from "./reachability";
import { probeSshAccess, installCommand } from "./bootstrap";

type Candidate = SshHostEntry & { reachable: boolean | null };
type Phase = "discovering" | "confirming" | "connecting" | "done" | "none";

/**
 * `miro setup`'s discovery + confirmation flow (plan §10's experienced/beginner bootstrap).
 * Everything up through the SSH access probe is real and live. The actual install step
 * (`curl -fsSL https://miro.computer/install | sudo sh` run *on* the target over that SSH
 * session) needs a real reachable server to run against, so it's shown as the next step rather
 * than executed — this environment has no real target to install onto.
 */
export function SetupScreen() {
  const [phase, setPhase] = useState<Phase>("discovering");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [index, setIndex] = useState(0);
  const [resultLine, setResultLine] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const hosts = discoverSshHosts();
      if (hosts.length === 0) {
        setPhase("none");
        return;
      }
      const withReachability = await Promise.all(
        hosts.map(async (h) => ({ ...h, reachable: h.hostname ? await probeSsh(h.hostname) : null })),
      );
      setCandidates(withReachability);
      setPhase("confirming");
    })();
  }, []);

  const current = candidates[index];

  async function handleAnswer(yes: boolean) {
    if (!current) return;
    if (!yes) {
      if (index + 1 < candidates.length) setIndex(index + 1);
      else setPhase("none");
      return;
    }
    setPhase("connecting");
    const result = await probeSshAccess(current.hostname ?? current.alias, {
      user: current.user ?? undefined,
      port: current.port ?? 22,
    });
    setResultLine(
      result.reachable
        ? `Connected. Next step would run on ${current.alias}: ${installCommand()}`
        : `Could not reach ${current.alias} over SSH: ${result.output || "no response"}`,
    );
    setPhase("done");
  }

  return (
    <box style={{ flexDirection: "column", padding: 1 }}>
      {phase === "discovering" && <text>Looking for Linux servers…</text>}
      {phase === "none" && (
        <text>No servers found in your SSH config. Add one to ~/.ssh/config and run `miro setup` again.</text>
      )}
      {phase === "confirming" && current && (
        <box style={{ flexDirection: "column" }}>
          <text>Found:</text>
          <text>  {current.alias}</text>
          <text>  {current.hostname ?? "(no hostname configured)"}</text>
          <text>  SSH {current.reachable ? "available" : "not reachable"}</text>
          <text> </text>
          <text>? Is this your server?</text>
          <select
            focused
            options={[
              { name: "Yes", description: "", value: "yes" },
              { name: "No", description: "", value: "no" },
            ]}
            onChange={(_index, option) => handleAnswer(option?.value === "yes")}
          />
        </box>
      )}
      {phase === "connecting" && <text>Connecting…</text>}
      {phase === "done" && <text>{resultLine}</text>}
    </box>
  );
}
