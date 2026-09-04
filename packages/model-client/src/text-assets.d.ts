// Ambient types for Bun's `with { type: "text" }` import attribute (vendored dialect/provider
// prompt templates are embedded this way). Mirrors oh-my-pi's own types/assets/index.d.ts -
// only the extensions this package actually uses.
declare module "*.md" {
  const content: string;
  export default content;
}
