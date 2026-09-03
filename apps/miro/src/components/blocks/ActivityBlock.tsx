import { countSteps, isQuiet, type ActivityNode } from "@miro/ui-model";
import { theme } from "../../theme";
import { Spinner } from "../Spinner";

function NodeView({ node, indent }: { node: ActivityNode; indent: number }) {
  const failed = node.status === "failed";
  return (
    <box flexDirection="column" paddingLeft={indent}>
      {node.status === "running" ? (
        <box flexDirection="row" gap={1}>
          <Spinner />
          <text fg={theme.text}>{node.label}</text>
        </box>
      ) : (
        <text fg={failed ? theme.error : theme.textMuted}>
          {`${failed ? "✗" : "✓"} ${node.label}${node.detail ? ` · ${node.detail}` : ""}`}
        </text>
      )}
      {node.children.map((child) => (
        <NodeView key={child.id} node={child} indent={2} />
      ))}
    </box>
  );
}

/** Learn progress only when it's needed: a tree that finished cleanly collapses to one dim line;
 * anything still running or failed stays open so you can see where it is or what broke. */
export function ActivityBlock({ node }: { node: ActivityNode }) {
  if (isQuiet(node)) {
    const steps = countSteps(node);
    // The detail rides along on the collapsed line: it is the one thing the daemon reported about a
    // call that went fine ("Debian 13"), and collapsing it away would lose it for good.
    const detail = node.detail ? ` · ${node.detail}` : "";
    return <text fg={theme.textMuted}>{`✓ ${node.label}${detail}${steps > 0 ? ` (+${steps} steps)` : ""}`}</text>;
  }
  return <NodeView node={node} indent={0} />;
}
