// Payslip's testnet anchor, run locally: the same handler as the Vercel deployment
// (anchor/lib/core.js), behind a plain Node HTTP server.
//
//   node scripts/anchor/server.mjs        → http://localhost:8790 (home domain localhost:8790)
//
// First run creates the anchor's keys in .secrets/anchor.secret.json (gitignored), funds the
// distribution account with friendbot and adds its USDC trustline.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { CORS, USDC, handle } from "../../anchor/lib/core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.ANCHOR_PORT ?? 8790);
const ORIGIN = `http://localhost:${PORT}`;
const KEYS_PATH = join(ROOT, ".secrets/anchor.secret.json");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

const keys = existsSync(KEYS_PATH)
  ? JSON.parse(readFileSync(KEYS_PATH, "utf8"))
  : { signing: Keypair.random().secret(), distribution: Keypair.random().secret(), jwtSecret: randomBytes(32).toString("hex") };
mkdirSync(dirname(KEYS_PATH), { recursive: true });
writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2) + "\n");
process.env.ANCHOR_SIGNING_SECRET ??= keys.signing;
process.env.ANCHOR_DISTRIBUTION_SECRET ??= keys.distribution;
process.env.ANCHOR_JWT_SECRET ??= keys.jwtSecret;

// The distribution account must exist and trust USDC.
const dist = Keypair.fromSecret(process.env.ANCHOR_DISTRIBUTION_SECRET);
let account = await horizon.loadAccount(dist.publicKey()).catch(() => null);
if (!account) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${dist.publicKey()}`);
  if (!r.ok) throw new Error(`friendbot ${r.status}`);
  account = await horizon.loadAccount(dist.publicKey());
}
if (!account.balances.some((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer)) {
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(120)
    .build();
  tx.sign(dist);
  await horizon.submitTransaction(tx);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw || "{}");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return {};
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const out = await handle({
    method: req.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: req.method === "POST" ? await readBody(req) : {},
    origin: ORIGIN,
  }).catch((e) => ({ status: 500, type: "application/json", body: JSON.stringify({ error: e.message }) }));
  res.writeHead(out.status, { ...CORS, "Content-Type": out.type });
  res.end(out.body);
}).listen(PORT, () => console.log(`[anchor] ${ORIGIN}  distribution ${dist.publicKey()}`));
