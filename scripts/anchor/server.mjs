// Payslip's testnet anchor: a minimal SEP-1 / SEP-10 / SEP-24 withdrawal anchor for testnet USDC.
// It replaces the SDF test anchor, which caps withdrawals at 10 USDC: here the only limit is the
// employee's balance. The bank payout is SIMULATED (testnet): once the anchor's distribution
// account receives the USDC with the right memo, the withdrawal is marked completed.
//
//   node scripts/anchor/server.mjs        → http://localhost:8790 (home domain localhost:8790)
//
// Keys and transactions live in .secrets/ (gitignored): anchor.secret.json, anchor-db.json.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.ANCHOR_PORT ?? 8790);
const HOME = `localhost:${PORT}`;
const ORIGIN = `http://${HOME}`;
const NETWORK = Networks.TESTNET;
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const KEYS_PATH = join(ROOT, ".secrets/anchor.secret.json");
const DB_PATH = join(ROOT, ".secrets/anchor-db.json");
const horizon = new Horizon.Server(HORIZON_URL);

const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : fallback);
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2) + "\n"); };

// ---------------------------------------------------------------------------
// Setup: signing key (SEP-10), distribution account (receives USDC), JWT secret
// ---------------------------------------------------------------------------

async function setup() {
  const keys = readJson(KEYS_PATH, null) ?? {
    signing: Keypair.random().secret(),
    distribution: Keypair.random().secret(),
    jwtSecret: randomBytes(32).toString("hex"),
  };
  writeJson(KEYS_PATH, keys);
  const dist = Keypair.fromSecret(keys.distribution);
  let account = await horizon.loadAccount(dist.publicKey()).catch(() => null);
  if (!account) {
    const r = await fetch(`https://friendbot.stellar.org?addr=${dist.publicKey()}`);
    if (!r.ok) throw new Error(`friendbot ${r.status}`);
    account = await horizon.loadAccount(dist.publicKey());
  }
  if (!account.balances.some((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer)) {
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.changeTrust({ asset: USDC }))
      .setTimeout(120)
      .build();
    tx.sign(dist);
    await horizon.submitTransaction(tx);
  }
  return { signing: Keypair.fromSecret(keys.signing), dist, jwtSecret: keys.jwtSecret };
}

const { signing, dist, jwtSecret } = await setup();
const db = readJson(DB_PATH, { txs: {}, nextMemo: 1000, cursor: "0" });
const save = () => writeJson(DB_PATH, db);

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString("base64url");
function jwtSign(claims, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iss: `${ORIGIN}/auth`, iat: now, exp: now + ttlSec, ...claims }))}`;
  return `${body}.${createHmac("sha256", jwtSecret).update(body).digest("base64url")}`;
}
function jwtVerify(token) {
  const [h, p, s] = String(token ?? "").split(".");
  if (!s || createHmac("sha256", jwtSecret).update(`${h}.${p}`).digest("base64url") !== s) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  return claims.exp > Date.now() / 1000 ? claims : null;
}
const bearer = (req) => jwtVerify((req.headers.authorization ?? "").replace(/^Bearer /, ""));

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // The Payslip app is cross-origin isolated (COEP require-corp): let it embed our responses.
  "Cross-Origin-Resource-Policy": "cross-origin",
};
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { ...CORS, "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  const type = req.headers["content-type"] ?? "";
  if (type.includes("application/json")) return JSON.parse(raw || "{}");
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  if (type.includes("multipart/form-data")) {
    // SEP-24 allows multipart: plain text fields only.
    const out = {};
    for (const m of raw.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) out[m[1]] = m[2];
    return out;
  }
  return {};
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The SEP-24 transaction object, as clients see it. */
const view = (t) => ({
  id: t.id,
  kind: "withdrawal",
  status: t.status,
  amount_in: t.amount_in,
  amount_out: t.amount_out,
  amount_fee: t.amount_in ? "0" : undefined,
  started_at: t.started_at,
  completed_at: t.completed_at,
  withdraw_anchor_account: t.status === "incomplete" ? undefined : dist.publicKey(),
  withdraw_memo: t.status === "incomplete" ? undefined : t.memo,
  withdraw_memo_type: t.status === "incomplete" ? undefined : "id",
  stellar_transaction_id: t.stellar_transaction_id,
  more_info_url: `${ORIGIN}/sep24/interactive?id=${t.id}`,
  message: t.message,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const TOML = `NETWORK_PASSPHRASE="${NETWORK}"
SIGNING_KEY="${signing.publicKey()}"
WEB_AUTH_ENDPOINT="${ORIGIN}/auth"
TRANSFER_SERVER_SEP0024="${ORIGIN}/sep24"

[DOCUMENTATION]
ORG_NAME="Payslip testnet anchor"
ORG_DESCRIPTION="Testnet withdrawal anchor for Payslip. Bank payouts are simulated."

[[CURRENCIES]]
code="USDC"
issuer="${USDC.issuer}"
status="test"
is_asset_anchored=false
desc="Circle testnet USDC, withdrawn to a simulated bank account."
`;

async function route(req, res) {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "", "text/plain");

  if (path === "/.well-known/stellar.toml") return send(res, 200, TOML, "text/plain");

  // SEP-10
  if (path === "/auth" && req.method === "GET") {
    const account = url.searchParams.get("account");
    if (!account || !/^G[A-Z2-7]{55}$/.test(account)) return send(res, 400, { error: "invalid account" });
    const transaction = WebAuth.buildChallengeTx(signing, account, HOME, 900, NETWORK, HOME);
    return send(res, 200, { transaction, network_passphrase: NETWORK });
  }
  if (path === "/auth" && req.method === "POST") {
    const { transaction } = await readBody(req);
    try {
      const { clientAccountID } = WebAuth.readChallengeTx(transaction, signing.publicKey(), NETWORK, HOME, HOME);
      // Accounts whose master key signs (our employees). Multisig would use the account's signers.
      WebAuth.verifyChallengeTxSigners(transaction, signing.publicKey(), NETWORK, [clientAccountID], HOME, HOME);
      return send(res, 200, { token: jwtSign({ sub: clientAccountID, jti: randomUUID() }, 24 * 3600) });
    } catch (e) {
      return send(res, 400, { error: `challenge rejected: ${e.message}` });
    }
  }

  // SEP-24
  if (path === "/sep24/info") {
    return send(res, 200, {
      deposit: {},
      withdraw: { USDC: { enabled: true, fee_fixed: 0, fee_percent: 0 } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
    });
  }
  if (path === "/sep24/transactions/withdraw/interactive" && req.method === "POST") {
    const auth = bearer(req);
    if (!auth?.sub) return send(res, 403, { error: "authentication required" });
    const p = await readBody(req);
    if (p.asset_code !== "USDC") return send(res, 400, { error: "only USDC is supported" });
    if (p.account && p.account !== auth.sub) return send(res, 403, { error: "account does not match the SEP-10 token" });
    const t = { id: randomUUID(), account: auth.sub, status: "incomplete", amount_in: p.amount, started_at: new Date().toISOString() };
    db.txs[t.id] = t;
    save();
    const token = jwtSign({ sub: auth.sub, tx: t.id }, 3600);
    return send(res, 200, { type: "interactive_customer_info_needed", url: `${ORIGIN}/sep24/interactive?id=${t.id}&token=${token}`, id: t.id });
  }
  if (path === "/sep24/transaction" && req.method === "GET") {
    const auth = bearer(req);
    const t = db.txs[url.searchParams.get("id")];
    if (!auth?.sub) return send(res, 403, { error: "authentication required" });
    if (!t || t.account !== auth.sub) return send(res, 404, { error: "transaction not found" });
    return send(res, 200, { transaction: view(t) });
  }

  // The interactive page: confirm the amount; the bank account is a simulated one.
  if (path === "/sep24/interactive") {
    const p = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
    const claims = jwtVerify(p.token);
    const t = db.txs[p.id];
    if (!t) return send(res, 404, page("Retrait introuvable", "<p>Ce retrait n'existe pas.</p>"), "text/html");
    if (req.method === "GET" && (!claims || claims.tx !== t.id)) {
      return send(res, 200, page("Statut du retrait", `<p>Statut : <b>${esc(t.status)}</b>${t.amount_in ? `, ${esc(t.amount_in)} USDC` : ""}.</p>`), "text/html");
    }
    if (!claims || claims.tx !== t.id) return send(res, 403, page("Lien expiré", "<p>Relancez le retrait depuis Payslip.</p>"), "text/html");
    if (req.method === "POST" && t.status === "incomplete") {
      const amount = Number(p.amount);
      if (!(amount > 0)) return send(res, 400, page("Montant invalide", "<p>Saisissez un montant positif.</p>"), "text/html");
      Object.assign(t, { status: "pending_user_transfer_start", amount_in: amount.toFixed(7).replace(/\.?0+$/, ""), memo: String(db.nextMemo++) });
      t.amount_out = t.amount_in;
      save();
    }
    if (t.status !== "incomplete") {
      return send(res, 200, page("Retrait confirmé", `<p>Envoyez <b>${esc(t.amount_in)} USDC</b> : Payslip s'en charge. Vous pouvez fermer cette fenêtre.</p><script>setTimeout(() => window.close(), 1500)</script>`), "text/html");
    }
    return send(res, 200, page("Retirer vers votre banque", `
      <form method="post">
        <input type="hidden" name="id" value="${esc(t.id)}"><input type="hidden" name="token" value="${esc(p.token)}">
        <label>Montant (USDC)<input name="amount" type="number" min="0.0000001" step="any" required value="${esc(t.amount_in ?? "")}"></label>
        <p class="muted">Compte bancaire : <b>compte de démonstration (testnet)</b>. Le virement bancaire est simulé.</p>
        <button>Confirmer le retrait</button>
      </form>`), "text/html");
  }

  return send(res, 404, { error: "not found" });
}

function page(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#EEF4F1;color:#18233F;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#F7FAF8;border:1px solid #CBD8D6;border-radius:14px;padding:28px;width:min(92vw,420px)}h1{font-size:22px;margin:0 0 4px}.eyebrow{color:#1F6F5C;font-size:13px;font-weight:600;margin:0 0 12px}
label{display:grid;gap:6px;margin:16px 0}input{font:inherit;padding:10px;border:1px solid #CBD8D6;border-radius:10px}button{font:600 16px system-ui;background:#18233F;color:#EEF4F1;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}.muted{color:#4F5D75;font-size:14px}</style></head>
<body><main><p class="eyebrow">Anchor testnet Payslip</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

// ---------------------------------------------------------------------------
// Payment watcher: USDC received with a known memo → pending_anchor → completed (payout simulated)
// ---------------------------------------------------------------------------

async function watch() {
  try {
    const r = await fetch(`${HORIZON_URL}/accounts/${dist.publicKey()}/payments?cursor=${db.cursor}&order=asc&limit=50&join=transactions`);
    const records = (await r.json())._embedded?.records ?? [];
    for (const p of records) {
      db.cursor = p.paging_token;
      const memo = p.transaction?.memo_type === "id" ? p.transaction.memo : null;
      if (p.type !== "payment" || p.to !== dist.publicKey() || p.asset_code !== USDC.code || p.asset_issuer !== USDC.issuer || !memo) continue;
      const t = Object.values(db.txs).find((x) => x.memo === memo && x.status === "pending_user_transfer_start");
      if (!t) continue;
      if (p.from !== t.account || Number(p.amount) < Number(t.amount_in)) {
        Object.assign(t, { status: "error", message: `payment ${p.transaction_hash} does not match the withdrawal` });
        continue;
      }
      Object.assign(t, { status: "pending_anchor", stellar_transaction_id: p.transaction_hash });
      console.log(`[anchor] ${t.amount_in} USDC received for ${t.id} (tx ${p.transaction_hash.slice(0, 10)}…)`);
      setTimeout(() => {
        Object.assign(t, { status: "completed", completed_at: new Date().toISOString(), message: "Virement bancaire simulé (testnet)" });
        save();
        console.log(`[anchor] ${t.id} completed`);
      }, 3000);
    }
    if (records.length) save();
  } catch (e) {
    console.warn(`[anchor] watcher: ${e.message}`);
  }
  setTimeout(watch, 3000);
}

http.createServer((req, res) => route(req, res).catch((e) => send(res, 500, { error: e.message }))).listen(PORT, () => {
  console.log(`[anchor] ${ORIGIN}  signing ${signing.publicKey()}  distribution ${dist.publicKey()}`);
  watch();
});
