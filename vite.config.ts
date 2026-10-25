import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  define: { global: "globalThis" },
  server: {
    port: 5174,
    strictPort: true,
    open: true, // browser from $BROWSER, set to Brave by scripts/dev.mjs
    headers: {
      // Cross-origin isolation: required for multithreaded bb.js proving in the browser.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 2500 },
});
