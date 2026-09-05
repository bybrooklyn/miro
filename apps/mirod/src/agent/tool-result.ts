import type { AgentToolResult } from "@miro/agent-core";
import { redactSecretsInText } from "../operations/classify";

// The one way a tool answer becomes model-visible text (audit 2026-09-05, S2/X1). It used to be
// nine byte-identical private copies, eight of which had dropped the redaction the ninth
// (extension-tools) carried - so container/journal logs, the very place an app prints its own
// token, reached the model unscrubbed. One leaf module, always redacting: redaction is idempotent,
// so the call sites that already scrub individual fields stay correct.
//
// details ?? null: JSON.stringify(undefined) returns the value undefined (not a string),
// producing a malformed {text: undefined} block that crashes downstream message processing -
// found live when a void-returning tool (browser_open) hit this exact bug. null is a real JSON
// literal; undefined coerced through here is not.
export function textResult(details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: redactSecretsInText(JSON.stringify(details ?? null, null, 2)) }], details };
}
