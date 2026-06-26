import { defineConfig } from "tsup"
export default defineConfig({
  entry: ["src/index.ts", "src/providers/nmi-card.ts", "src/providers/nmi-ach.ts"],
  outDir: ".medusa/server/src",
  format: ["esm"],
  dts: true,
  clean: true,
  bundle: true,
  target: "node20",
  external: [/^@medusajs\//],
})
