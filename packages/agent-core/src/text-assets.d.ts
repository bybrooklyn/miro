// Ambient types for Bun's `with { type: "text" }` import attribute (the vendored compaction
// prompt templates are embedded this way). See packages/model-client/src/text-assets.d.ts.
declare module "*.md" {
  const content: string;
  export default content;
}
