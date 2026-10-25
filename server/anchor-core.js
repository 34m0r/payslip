// Payslip's testnet anchor: SEP-1 / SEP-10 / SEP-24 withdrawals of testnet USDC, with no cap
// beyond the employee's balance and a SIMULATED bank payout.
//
// Stateless server: the Stellar ledger is the database, so it runs as a serverless function.
//   - the amount the employee confirms is written on the anchor's own account (a manageData entry
//     `w:<id>` = `<amount>|<account fingerprint>`);
//   - the memo is derived from the withdrawal id;
//   - the status is computed on demand from Horizon: no entry → incomplete; entry, no payment →
//     pending_user_transfer_start; payment with the memo → pending_anchor, then completed.
//
// Configuration (environment): ANCHOR_SIGNING_SECRET, ANCHOR_DISTRIBUTION_SECRET, ANCHOR_JWT_SECRET.
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";

const NETWORK = Networks.TESTNET;
const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const PAYOUT_DELAY_MS = 4000; // the simulated bank transfer, after the USDC lands

// Payout currencies, at FIXED DEMO RATES (USDC → local currency). A real deployment would quote
// live rates (SEP-38) through an anchor in the employee's country; ours only simulates the payout.
export const PAYOUT_RATES = { EUR: 0.92, BRL: 5.4, NGN: 1550, MXN: 18.5, INR: 84, USD: 1 };
const LOCALE = { EUR: "fr-FR", BRL: "pt-BR", NGN: "en-NG", MXN: "es-MX", INR: "en-IN", USD: "en-US" };
const currencyOf = (c) => (Object.hasOwn(PAYOUT_RATES, c) ? c : "USD");
const convert = (usdc, ccy) => (Number(usdc) * PAYOUT_RATES[ccy]).toFixed(2);
const money = (amount, ccy) => Number(amount).toLocaleString(LOCALE[ccy], { style: "currency", currency: ccy });
const horizon = new Horizon.Server(HORIZON_URL);

function config() {
  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`missing ${k}`);
    return v;
  };
  return {
    signing: Keypair.fromSecret(need("ANCHOR_SIGNING_SECRET")),
    dist: Keypair.fromSecret(need("ANCHOR_DISTRIBUTION_SECRET")),
    jwtSecret: need("ANCHOR_JWT_SECRET"),
  };
}

// ---------------------------------------------------------------------------
// JWT (HS256)
// ---------------------------------------------------------------------------

const b64u = (s) => Buffer.from(s).toString("base64url");
function jwtSign(secret, iss, claims, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify({ iss, iat: now, exp: now + ttlSec, ...claims }))}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
function jwtVerify(secret, token) {
  const [h, p, s] = String(token ?? "").split(".");
  if (!s || createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url") !== s) return null;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString());
  return claims.exp > Date.now() / 1000 ? claims : null;
}

// ---------------------------------------------------------------------------
// Ledger-backed withdrawal records
// ---------------------------------------------------------------------------

const sha = (s) => createHash("sha256").update(s).digest("hex");
/** Memo id derived from the withdrawal id (48 bits: unique enough for a testnet anchor). */
const memoOf = (id) => BigInt(`0x${sha(id).slice(0, 12)}`).toString();
const fingerprint = (account) => sha(account).slice(0, 16);
const entryName = (id) => `w:${id}`;

async function readEntry(dist, id) {
  const account = await horizon.loadAccount(dist.publicKey());
  const raw = account.data_attr[entryName(id)];
  if (!raw) return null;
  const [amount, fp, ccy] = Buffer.from(raw, "base64").toString().split("|");
  return { amount, fp, ccy: currencyOf(ccy) };
}

async function writeEntry(dist, id, amount, account, ccy) {
  const source = await horizon.loadAccount(dist.publicKey());
  const tx = new TransactionBuilder(source, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: NETWORK })
    .addOperation(Operation.manageData({ name: entryName(id), value: `${amount}|${fingerprint(account)}|${ccy}` }))
    .setTimeout(60)
    .build();
  tx.sign(dist);
  await horizon.submitTransaction(tx);
}

/** The USDC payment that settles withdrawal `id`, if it has landed. */
async function findPayment(dist, id, account, amount) {
  const memo = memoOf(id);
  const page = await horizon.payments().forAccount(dist.publicKey()).order("desc").limit(200).join("transactions").call();
  return page.records.find(
    (p) => p.type === "payment" && p.to === dist.publicKey() && p.from === account && p.asset_code === USDC.code
      && p.asset_issuer === USDC.issuer && p.transaction_attr?.memo_type === "id" && p.transaction_attr?.memo === memo
      && Number(p.amount) >= Number(amount),
  ) ?? null;
}

async function status(cfg, id, account) {
  const entry = await readEntry(cfg.dist, id);
  if (!entry) return { id, kind: "withdrawal", status: "incomplete" };
  if (entry.fp !== fingerprint(account)) return null;
  const base = {
    id,
    kind: "withdrawal",
    amount_in: entry.amount,
    amount_in_asset: `stellar:${USDC.code}:${USDC.issuer}`,
    amount_out: convert(entry.amount, entry.ccy),
    amount_out_asset: `iso4217:${entry.ccy}`,
    amount_fee: "0",
    withdraw_anchor_account: cfg.dist.publicKey(),
    withdraw_memo: memoOf(id),
    withdraw_memo_type: "id",
  };
  const p = await findPayment(cfg.dist, id, account, entry.amount);
  if (!p) return { ...base, status: "pending_user_transfer_start" };
  const landed = Date.parse(p.created_at);
  return Date.now() - landed < PAYOUT_DELAY_MS
    ? { ...base, status: "pending_anchor", stellar_transaction_id: p.transaction_hash }
    : { ...base, status: "completed", stellar_transaction_id: p.transaction_hash, completed_at: new Date(landed + PAYOUT_DELAY_MS).toISOString(), message: `Virement bancaire simulé de ${money(convert(entry.amount, entry.ccy), entry.ccy)} (taux de démo, testnet)` };
}

// ---------------------------------------------------------------------------
// HTTP handler, shared by the Vercel function and the local server
//   handle({ method, path, query, headers, body, origin }) → { status, type, body }
// ---------------------------------------------------------------------------

const json = (status, body) => ({ status, type: "application/json", body: JSON.stringify(body) });
const html = (status, title, body) => ({ status, type: "text/html; charset=utf-8", body: page(title, body) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // The Payslip app is cross-origin isolated (COEP require-corp).
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export async function handle({ method, path, query, headers, body, origin }) {
  if (method === "OPTIONS") return { status: 204, type: "text/plain", body: "" };
  const cfg = config();
  const home = new URL(origin).host;
  const bearer = () => jwtVerify(cfg.jwtSecret, String(headers.authorization ?? "").replace(/^Bearer /, ""));

  if (path === "/.well-known/stellar.toml") {
    return { status: 200, type: "text/plain", body: toml(origin, cfg) };
  }

  // SEP-10
  if (path === "/auth" && method === "GET") {
    const account = query.account;
    if (!/^G[A-Z2-7]{55}$/.test(account ?? "")) return json(400, { error: "invalid account" });
    return json(200, { transaction: WebAuth.buildChallengeTx(cfg.signing, account, home, 900, NETWORK, home), network_passphrase: NETWORK });
  }
  if (path === "/auth" && method === "POST") {
    try {
      const { clientAccountID } = WebAuth.readChallengeTx(body.transaction, cfg.signing.publicKey(), NETWORK, home, home);
      // Accounts signed by their master key (our employees); multisig would check the account's signers.
      WebAuth.verifyChallengeTxSigners(body.transaction, cfg.signing.publicKey(), NETWORK, [clientAccountID], home, home);
      return json(200, { token: jwtSign(cfg.jwtSecret, `${origin}/auth`, { sub: clientAccountID, jti: randomUUID() }, 24 * 3600) });
    } catch (e) {
      return json(400, { error: `challenge rejected: ${e.message}` });
    }
  }

  // SEP-24
  if (path === "/sep24/info") {
    return json(200, {
      deposit: {},
      withdraw: { USDC: { enabled: true, fee_fixed: 0, fee_percent: 0 } },
      fee: { enabled: false },
      features: { account_creation: false, claimable_balances: false },
    });
  }
  if (path === "/sep24/transactions/withdraw/interactive" && method === "POST") {
    const auth = bearer();
    if (!auth?.sub) return json(403, { error: "authentication required" });
    if (body.asset_code !== "USDC") return json(400, { error: "only USDC is supported" });
    if (body.account && body.account !== auth.sub) return json(403, { error: "account does not match the SEP-10 token" });
    const id = randomUUID();
    const token = jwtSign(cfg.jwtSecret, `${origin}/auth`, { sub: auth.sub, tx: id, amount: body.amount ?? "", ccy: currencyOf(body.payout_currency) }, 3600);
    return json(200, { type: "interactive_customer_info_needed", url: `${origin}/sep24/interactive?id=${id}&token=${token}`, id });
  }
  if (path === "/sep24/transaction" && method === "GET") {
    const auth = bearer();
    if (!auth?.sub) return json(403, { error: "authentication required" });
    const t = await status(cfg, String(query.id ?? ""), auth.sub);
    return t ? json(200, { transaction: t }) : json(404, { error: "transaction not found" });
  }

  // Interactive page: the employee confirms the amount; the bank account is a simulated one.
  if (path === "/sep24/interactive") {
    const p = method === "POST" ? body : query;
    const claims = jwtVerify(cfg.jwtSecret, p.token);
    if (!claims || claims.tx !== p.id) return html(403, "Lien expiré", "<p>Relancez le retrait depuis Payslip.</p>");
    if (method === "POST") {
      const amount = Number(p.amount);
      if (!(amount > 0)) return html(400, "Montant invalide", "<p>Saisissez un montant positif.</p>");
      if (!(await readEntry(cfg.dist, p.id))) await writeEntry(cfg.dist, p.id, amount.toFixed(7).replace(/\.?0+$/, ""), claims.sub, currencyOf(p.ccy));
    }
    const entry = await readEntry(cfg.dist, p.id);
    if (entry) {
      return html(200, "Retrait confirmé", `<p>${esc(entry.amount)} USDC seront convertis en <b>${esc(money(convert(entry.amount, entry.ccy), entry.ccy))}</b> et virés sur votre compte (simulé). Payslip envoie les USDC. Vous pouvez fermer cette fenêtre.</p><script>setTimeout(() => window.close(), 2500)</script>`);
    }
    return html(200, "Retirer vers votre banque", `
      <form method="post">
        <input type="hidden" name="id" value="${esc(p.id)}"><input type="hidden" name="token" value="${esc(p.token)}">
        <label>Montant (USDC)<input id="amount" name="amount" type="number" min="0.0000001" step="any" required value="${esc(claims.amount ?? "")}"></label>
        <label>Recevoir en<select id="ccy" name="ccy">${Object.keys(PAYOUT_RATES).map((c) => `<option value="${c}"${c === currencyOf(claims.ccy) ? " selected" : ""}>${c}</option>`).join("")}</select></label>
        <p class="quote">Vous recevrez <b id="out">…</b></p>
        <p class="muted">Taux de démonstration fixe (1 USDC = <span id="rate"></span>), pas un taux de marché. Compte bancaire : <b>compte de démonstration (testnet)</b>, virement simulé.</p>
        <button>Confirmer le retrait</button>
      </form>
      <script>
        const RATES = ${JSON.stringify(PAYOUT_RATES)}, LOCALE = ${JSON.stringify(LOCALE)};
        const fmt = (v, c) => v.toLocaleString(LOCALE[c], { style: "currency", currency: c });
        const update = () => {
          const c = document.getElementById("ccy").value, a = Number(document.getElementById("amount").value) || 0;
          document.getElementById("out").textContent = fmt(a * RATES[c], c);
          document.getElementById("rate").textContent = fmt(RATES[c], c);
        };
        document.getElementById("amount").addEventListener("input", update);
        document.getElementById("ccy").addEventListener("change", update);
        update();
      </script>`);
  }

  return json(404, { error: "not found" });
}

function toml(origin, cfg) {
  return `NETWORK_PASSPHRASE="${NETWORK}"
SIGNING_KEY="${cfg.signing.publicKey()}"
WEB_AUTH_ENDPOINT="${origin}/auth"
TRANSFER_SERVER_SEP0024="${origin}/sep24"

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
}

function page(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#EEF4F1;color:#18233F;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#F7FAF8;border:1px solid #CBD8D6;border-radius:14px;padding:28px;width:min(92vw,420px)}h1{font-size:22px;margin:0 0 4px}.eyebrow{color:#1F6F5C;font-size:13px;font-weight:600;margin:0 0 12px}
label{display:grid;gap:6px;margin:16px 0}input,select{font:inherit;padding:10px;border:1px solid #CBD8D6;border-radius:10px;background:#fff}.quote{font-size:18px;margin:4px 0 8px}button{font:600 16px system-ui;background:#18233F;color:#EEF4F1;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}.muted{color:#4F5D75;font-size:14px}</style></head>
<body><main><p class="eyebrow">Anchor testnet Payslip</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}
