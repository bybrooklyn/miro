/** @jsxImportSource react */
import { PHASE_LABEL, operationDetails, countSteps, isQuiet, type ActivityNode, type Block } from "@miro/ui-model";

// Every block shape the view-model can produce, rendered for a browser. The terminal renderer draws the
// same list from the same reducer; if something here needs a decision made, it belongs in ui-model.

function Activity({ node, depth = 0 }: { node: ActivityNode; depth?: number }) {
  const children = node.children.filter((c) => !isQuiet(c));
  return (
    <div style={{ marginLeft: depth * 12 }}>
      <div>
        <span style={{ color: node.status === "failed" ? "var(--bad)" : node.status === "done" ? "var(--good)" : "var(--accent)" }}>
          {node.status === "running" ? "▸" : node.status === "failed" ? "✗" : "✓"}
        </span>{" "}
        {node.label}
        {node.detail ? <span style={{ color: "var(--dim)" }}> · {node.detail}</span> : null}
      </div>
      {children.map((c) => (
        <Activity key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}

function OperationCard({ block }: { block: Extract<Block, { kind: "operation" }> }) {
  const d = operationDetails(block.plan);
  const rows: [string, string][] = [];
  if (d.class) rows.push(["class", d.class]);
  if (d.writes) rows.push(["writes", d.writes.join(", ") || "nothing"]);
  if (d.network !== undefined) rows.push(["network", d.network ? "yes" : "no"]);
  if (d.command) rows.push(["command", d.command]);
  if (d.proposed) rows.push(["proposed", d.proposed]);
  if (d.scopeEvidence) rows.push(["scope", d.scopeEvidence]);
  if (d.irreversible) rows.push(["irreversible", "yes - nothing to roll back"]);
  if (d.effectUnknown) rows.push(["dry run", "proved nothing about the effect"]);
  return (
    <div className="operation block">
      <div className="label">operation · {block.plan.autoApprove ? "auto-approved" : "needs you"}</div>
      <div style={{ color: "var(--bright)" }}>{block.plan.goal}</div>
      <div style={{ color: "var(--dim)" }}>{block.plan.summary}</div>
      {d.warning ? <div style={{ color: "var(--warn)", marginTop: 6 }}>{d.warning}</div> : null}
      {rows.length ? (
        <dl className="kv" style={{ marginTop: 6 }}>
          {rows.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {d.diff ? <pre className="compose">{d.diff}</pre> : null}
      {block.phase && !block.result ? <div className="phase">{PHASE_LABEL[block.phase]}</div> : null}
      {block.result ? (
        <div className={`outcome ${block.result.outcome}`}>
          {block.result.outcome}: {block.result.message}
        </div>
      ) : null}
    </div>
  );
}

function PlanCard({ block }: { block: Extract<Block, { kind: "plan" }> }) {
  const p = block.plan;
  return (
    <div className="plan block">
      <div className="label">plan{block.decision ? ` · ${block.decision}` : ""}</div>
      <div style={{ color: "var(--bright)" }}>{p.title}</div>
      {p.findings?.length ? (
        <>
          <div className="label" style={{ marginTop: 8 }}>
            findings
          </div>
          <ul className="steps">
            {p.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </>
      ) : null}
      {p.components?.length ? (
        <>
          <div className="label" style={{ marginTop: 8 }}>
            components
          </div>
          <ul className="steps">
            {p.components.map((c, i) => (
              <li key={i}>
                {c.action} {c.name} - {c.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {p.steps?.length ? (
        <>
          <div className="label" style={{ marginTop: 8 }}>
            steps
          </div>
          <ul className="steps">
            {p.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      ) : null}
      {p.verification?.length ? (
        <>
          <div className="label" style={{ marginTop: 8 }}>
            verification
          </div>
          <ul className="steps">
            {p.verification.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
        </>
      ) : null}
      {p.notes?.length ? (
        <>
          <div className="label" style={{ marginTop: 8 }}>
            notes
          </div>
          <ul className="steps">
            {p.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

export function Transcript({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b) => {
        switch (b.kind) {
          case "user":
            return (
              <div key={b.id} className="user block">
                {b.text}
              </div>
            );
          case "assistant":
            return (
              <div key={b.id} className={`assistant block${b.streaming ? " streaming" : ""}`}>
                {b.text}
              </div>
            );
          case "activity":
            return (
              <div key={b.id} className="activity block">
                <div className="label">
                  {b.node.label} · {countSteps(b.node)} step{countSteps(b.node) === 1 ? "" : "s"}
                </div>
                <Activity node={b.node} />
              </div>
            );
          case "plan":
            return <PlanCard key={b.id} block={b} />;
          case "operation":
            return <OperationCard key={b.id} block={b} />;
          case "notice":
            return (
              <div key={b.id} className={`notice block ${b.level}`}>
                <div className="label">{b.source ? `${b.level} · ${b.source}` : b.level}</div>
                {b.text}
              </div>
            );
        }
      })}
    </>
  );
}
