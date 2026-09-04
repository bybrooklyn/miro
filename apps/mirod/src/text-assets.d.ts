// The vendored packages import their prompt templates as text (`with { type: "text" }`); Bun
// resolves that at runtime, and each package declares it for its own tsc run. A consumer's tsc
// run does not inherit those ambient declarations across the workspace boundary, so this repeats
// the one-liner here (same as packages/agent-core/src/text-assets.d.ts).
declare module "*.md" {
  const content: string;
  export default content;
}
