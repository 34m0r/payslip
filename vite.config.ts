import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const BB_DIR = join(__dirname, "node_modules/@aztec/bb.js/dest/browser");
const DEPLOYMENT = join(__dirname, "deployments/testnet.json");
const SECRETS = join(__dirname, ".secrets/testnet.secret.json");

/** The anchor's testnet keys, from .secrets/ in dev (on Vercel: project environment variables). */
// Imported at runtime by URL, so Vite does not bundle the server code into its config.
const importServer = (file: string) => import(/* @vite-ignore */ pathToFileURL(join(__dirname, "server", file)).href);

function loadAnchorKeys() {
  const path = join(__dirname, ".secrets/anchor.secret.json");
  if (!existsSync(path)) return;
  const k = JSON.parse(readFileSync(path, "utf8"));
  process.env.ANCHOR_SIGNING_SECRET ??= k.signing;
  process.env.ANCHOR_DISTRIBUTION_SECRET ??= k.distribution;
  process.env.ANCHOR_JWT_SECRET ??= k.jwtSecret;
}

// Cross-origin isolation: required for multithreaded bb.js proving in the browser.
const ISOLATION = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

/**
 * Testnet plumbing for the browser:
 * - `/bb/*`: bb.js's browser build served intact. It spawns its wasm workers from paths relative
 *   to its own URL, which break once a bundler chunks it, so the app loads it as native ESM.
 * - `virtual:payslip-testnet`: the public deployment (contract ids, accounts, payroll tx hashes)
 *   and, in dev or when PAYSLIP_DEMO_KEYS=1, the demo employees' confidential READ keys (`sk`) for
 *   the employee screen: they decrypt and prove, but move no funds. No signing key ever reaches the
 *   browser: payrolls and cash-outs are signed server-side (server/testnet.js, api/*).
 * - In dev, the same server routes as on Vercel: /api/testnet, /api/payroll, /api/cashout and the
 *   anchor (/.well-known/stellar.toml, /auth, /sep24/*), with keys read from .secrets/.
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
      return [
        `export const deployment = ${JSON.stringify(deployment)};`,
        `export const demoKeys = ${JSON.stringify(demoKeys)};`,
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
      // Payslip's testnet anchor on the app's own origin, as api/anchor.js serves it on Vercel.
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (!/^\/(\.well-known\/stellar\.toml|auth|sep24\/)/.test(url.pathname)) return next();
        loadAnchorKeys();
        const { handle, CORS } = await importServer("anchor-core.js");
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const raw = Buffer.concat(chunks).toString();
        const type = req.headers["content-type"] ?? "";
        const body = type.includes("application/json") ? JSON.parse(raw || "{}")
          : type.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : {};
        const out = await handle({
          method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
          headers: req.headers, body, origin: `http://${req.headers.host}`,
        }).catch((e: Error) => ({ status: 500, type: "application/json", body: JSON.stringify({ error: e.message }) }));
        res.writeHead(out.status, { ...CORS, ...ISOLATION, "Content-Type": out.type });
        res.end(out.body);
      });
      // Server-side testnet actions, as api/testnet.js, api/payroll.js and api/cashout.js on Vercel.
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!["/api/testnet", "/api/payroll", "/api/cashout"].includes(path)) return next();
        loadAnchorKeys();
        if (existsSync(SECRETS)) process.env.PAYSLIP_TESTNET_KEYS ??= readFileSync(SECRETS, "utf8");
        const t = await importServer("testnet.js");
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || "{}") : {};
        const send = (status: number, value: unknown) => {
          res.writeHead(status, { ...ISOLATION, "Content-Type": "application/json" });
          res.end(JSON.stringify(value));
        };
        if (path === "/api/testnet") return send(200, t.capabilities());
        if (path === "/api/payroll") {
          res.writeHead(200, { ...ISOLATION, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
          const emit = (line: unknown) => res.write(JSON.stringify(line) + "\n");
          await t.runPayroll(emit).catch((e: { status?: number; message: string }) => emit({ type: "error", status: e.status ?? 500, message: e.message }));
          return res.end();
        }
        const action = { start: t.cashoutStart, status: t.cashoutStatus, settle: t.cashoutSettle }[body.action as string];
        if (!action) return send(400, { error: "unknown action" });
        try { send(200, await action(`http://${req.headers.host}`, body)); }
        catch (e) { send((e as { status?: number }).status ?? 500, { error: (e as Error).message }); }
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
  // Same headers as production (vercel.json), so `vite preview` tests the real build.
  preview: { port: 4174, strictPort: true, headers: ISOLATION },
});
