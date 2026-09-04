// Ambient types for Bun's `with { type: "text" }` import attribute (the vendored prompt
// templates are embedded this way). See packages/model-client/src/text-assets.d.ts for the
// same pattern; duplicated rather than shared since it's currently 4 lines in 2 places.
declare module "*.md" {
  const content: string;
  export default content;
}
