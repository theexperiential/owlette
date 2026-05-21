import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { remarkMdxMermaid } from "fumadocs-core/mdx-plugins";

export const docs = defineDocs({
  dir: "content/docs",
});

export default defineConfig({
  mdxOptions: {
    // Rewrites ```mermaid fences into <Mermaid chart="..." /> (registered in
    // mdx-components.tsx) so they render as real diagrams instead of raw text.
    remarkPlugins: [remarkMdxMermaid],
  },
});
