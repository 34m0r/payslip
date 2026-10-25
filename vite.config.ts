import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const BB_DIR = join(__dirname, "node_modules/@aztec/bb.js/dest/browser");
const DEPLOYMENT = join(__dirname, "deployments/testnet.json");
const SECRETS = join(__dirname, ".secrets/testnet.secret.json");

// Cross-origin isolation: required for multithreaded bb.js proving in the browser.
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

/**
 * Testnet plumbing for the browser:
 * - `/bb/*`: bb.js's browser build served intact. It spawns its wasm workers from paths relative
 *   to its own URL, which break once a bundler chunks it, so the app loads it as native ESM.
 * - `virtual:payslip-testnet`: the public deployment (contract ids, accounts, payroll tx hashes)
 *   and, in dev only or when PAYSLIP_DEMO_KEYS=1, the demo employees' confidential keys (`sk`)
 *   for the employee screen. The employer's keys (account secret, `sk`, audit key), which let the
 *   globe sign real payrolls, are embedded in dev only. All are throwaway testnet keys; the
 *   verifier page needs none.
 */
function payslipTestnet(): Plugin {
  const id = "virtual:payslip-testnet";
  let embedKeys = false;
  let serving = false;
  return {
    name: "payslip-testnet",
    configResolved(c) {
      serving = c.command === "serve";
      embedKeys = serving || process.env.PAYSLIP_DEMO_KEYS === "1";
    },
    resolveId: (s) => (s === id ? "\0" + id : undefined),
    load(s) {
      if (s !== "\0" + id) return;
      this.addWatchFile(DEPLOYMENT);
      const deployment = existsSync(DEPLOYMENT) ? JSON.parse(readFileSync(DEPLOYMENT, "utf8")) : null;
      const secrets = embedKeys && existsSync(SECRETS) ? JSON.parse(readFileSync(SECRETS, "utf8")) : null;
      const demoKeys = secrets ? Object.fromEntries(Object.entries(secrets.employees).map(([k, v]) => [k, (v as { sk: string }).sk])) : {};
      const employerKeys = secrets && serving ? secrets.employer : null;
      return [
        `export const deployment = ${JSON.stringify(deployment)};`,
        `export const demoKeys = ${JSON.stringify(demoKeys)};`,
        `export const employerKeys = ${JSON.stringify(employerKeys)};`,
      ].join("\n");
    },
    configureServer(server) {
      server.middlewares.use("/bb", (req, res, next) => {
        const file = join(BB_DIR, (req.url ?? "/").split("?")[0]);
        if (!file.startsWith(BB_DIR) || !existsSync(file)) return next();
        res.setHeader("Content-Type", file.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        // bb.js's workers are documents of their own: they need the isolation headers too.
        for (const [k, v] of Object.entries(ISOLATION)) res.setHeader(k, v);
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const f of readdirSync(BB_DIR)) this.emitFile({ type: "asset", fileName: `bb/${f}`, source: readFileSync(join(BB_DIR, f)) });
    },
  };
}

export default defineConfig({
  root: "web",
  plugins: [react(), payslipTestnet()],
  define: { global: "globalThis" },
  // noir_js loads its wasm relative to import.meta.url: keep those packages out of pre-bundling.
  optimizeDeps: { exclude: ["@noir-lang/noirc_abi", "@noir-lang/acvm_js", "@aztec/bb.js"] },
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 2500, target: "es2022" },
  server: {
    port: 5174,
    strictPort: true,
    open: true, // browser from $BROWSER, set to Brave by scripts/dev.mjs
    headers: ISOLATION,
  },
});
