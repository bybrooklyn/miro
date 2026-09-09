/** @jsxImportSource react */
import { PHASE_LABEL, operationDetails, countSteps, isQuiet, type ActivityNode, type Block } from "@miro/ui-model";
import { markdown } from "./markdown";

// Every block shape the view-model can produce, rendered for a browser. The terminal renderer draws the
// same list from the same reducer; if something here needs a decision made, it belongs in ui-model.

const MARK = { running: "▸", done: "✓", failed: "✗" } as const;

function Tree({ node, depth = 0 }: { node: ActivityNode; depth?: number }) {
  const children = node.children.filter((c) => !isQuiet(c));
  return (
    <>
      <div className="node" style={{ marginLeft: depth * 14 }}>
        <span className={`mark ${node.status}`}>{MARK[node.status]}</span>
        <span>
          {node.label}
          {node.detail ? <span className="detail"> · {node.detail}</span> : null}
        </span>
      </div>
      {children.map((c) => (
        <Tree key={c.id} node={c} depth={depth + 1} />
      ))}
    </>
  );
}

/** What Miro did, as one quiet line you can open - not a wall of tool output. A finished tree names what
 * it touched; a running one says what it is doing now. */
function Activity({ node }: { node: ActivityNode }) {
  const steps = countSteps(node);
  const names = node.children.filter((c) => !isQuiet(c)).map((c) => c.label.toLowerCase());
  const summary =
    node.status === "running"
      ? node.label
      : names.length
        ? `${node.label.toLowerCase()}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}`
        : node.label.toLowerCase();
  return (
    <details className="activity">
      <summary>
        <span>
          {summary}
          {steps > 1 ? <span className="detail"> · {steps} steps</span> : null}
          {node.status === "failed" ? <span className="failed"> · failed</span> : null}
        </span>
      </summary>
      <div className="tree">
        <Tree node={node} />
      </div>
    </details>
  );
}

function OperationCard({ block }: { block: Extract<Block, { kind: "operation" }> }) {
  const d = operationDetails(block.plan);
  const state = block.result?.outcome ?? "pending";
  const facts: [string, string][] = [];
  if (d.class) facts.push(["class", d.class]);
  if (d.writes) facts.push(["writes", d.writes.join(", ") || "nothing"]);
  if (d.network !== undefined) facts.push(["network", d.network ? "yes" : "no"]);
  if (d.command) facts.push(["command", d.command]);
  if (d.proposed) facts.push(["proposed", d.proposed]);
  if (d.scopeEvidence) facts.push(["scope", d.scopeEvidence]);
  if (d.irreversible) facts.push(["irreversible", "nothing to roll back"]);
  if (d.effectUnknown) facts.push(["dry run", "proved nothing about the effect"]);
  return (
    <div className={`card ${state}`}>
      <div className="eyebrow">
        <span>operation</span>
        <span>{block.plan.autoApprove ? "auto-approved" : "needs you"}</span>
        {block.phase && !block.result ? <span style={{ color: "var(--accent)" }}>{PHASE_LABEL[block.phase]}</span> : null}
      </div>
      <div className="title">{block.plan.goal}</div>
      {block.plan.summary && block.plan.summary !== block.plan.goal ? <div className="sub">{block.plan.summary}</div> : null}
      {d.warning ? (
        <div className="sub" style={{ color: "var(--warn)" }}>
          {d.warning}
        </div>
      ) : null}
      {facts.length ? (
        <dl className="facts">
          {facts.map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {d.diff ? (
        <pre className="out" style={{ marginTop: 10 }}>
          {d.diff}
        </pre>
      ) : null}
      {block.result ? <div className={`outcome ${block.result.outcome}`}>{block.result.message}</div> : null}
    </div>
  );
}

function Section({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <>
      <div className="eyebrow" style={{ marginTop: 10 }}>
        {title}
      </div>
      <ul className="steps">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </>
  );
}

function PlanCard({ block }: { block: Extract<Block, { kind: "plan" }> }) {
  const p = block.plan;
  const state = block.decision === "approved" ? "committed" : block.decision === "cancelled" ? "rolledback" : "pending";
  return (
    <div className={`card ${state}`}>
      <div className="eyebrow">
        <span>plan</span>
        {block.decision ? <span>{block.decision}</span> : null}
      </div>
      <div className="title">{p.title}</div>
      <Section title="findings" items={p.findings} />
      {p.components?.length ? (
        <>
          <div className="eyebrow" style={{ marginTop: 10 }}>
            components
          </div>
          <ul className="steps">
            {p.components.map((c, i) => (
              <li key={i}>
                <span style={{ color: "var(--dim)" }}>{c.action}</span> {c.name} - {c.detail}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Section title="steps" items={p.steps} />
      <Section title="verification" items={p.verification} />
      <Section title="notes" items={p.notes} />
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
              <div key={b.id} className="turn-user">
                <span>{b.text}</span>
              </div>
            );
          case "assistant":
            return (
              <div key={b.id} className={`assistant${b.streaming ? " streaming" : ""}`}>
                {markdown(b.text)}
              </div>
            );
          case "activity":
            return <Activity key={b.id} node={b.node} />;
          case "plan":
            return <PlanCard key={b.id} block={b} />;
          case "operation":
            return <OperationCard key={b.id} block={b} />;
          case "notice":
            return (
              <div key={b.id} className={`notice ${b.level}`}>
                {b.text}
              </div>
            );
        }
      })}
    </>
  );
}
