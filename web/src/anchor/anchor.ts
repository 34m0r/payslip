/**
 * Minimal SEP-1 / SEP-10 / SEP-24 client for the withdrawal (cash-out) flow.
 * Works with accounts whose only signer is the device key (master weight 0):
 * the SEP-10 challenge is signed by the device key, which the anchor checks
 * against the account's signers.
 */
import {
  Asset,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";
import { parse } from "smol-toml";
// Standalone config (was ./net.js in Claimlink). Testnet by default.
import { Horizon, Networks } from "@stellar/stellar-sdk";
export const anchorConfig = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  network: Networks.TESTNET as string,
  fee: "10000",
};
const server = () => new Horizon.Server(anchorConfig.horizonUrl);
const NETWORK = () => anchorConfig.network;
const FEE = () => anchorConfig.fee;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (label: string, value?: unknown) =>
  console.log(value === undefined ? label : `${label.padEnd(28)} ${typeof value === "string" ? value : JSON.stringify(value)}`);

export interface AnchorInfo {
  homeDomain: string;
  webAuthEndpoint: string;
  signingKey: string;
  transferServer: string;
  currencies: { code: string; issuer?: string }[];
}

export async function discover(homeDomain: string): Promise<AnchorInfo> {
  // A local anchor (Payslip's testnet anchor in dev) serves plain http; every other one https.
  const scheme = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(homeDomain) ? "http" : "https";
  const res = await fetch(`${scheme}://${homeDomain}/.well-known/stellar.toml`);
  if (!res.ok) throw new Error(`stellar.toml ${res.status}`);
  const toml = parse(await res.text()) as Record<string, unknown>;
  const need = (k: string) => {
    const v = toml[k];
    if (typeof v !== "string") throw new Error(`stellar.toml missing ${k}`);
    return v;
  };
  const currencies = ((toml.CURRENCIES as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
    code: String(c.code),
    issuer: c.issuer ? String(c.issuer) : undefined,
  }));
  return {
    homeDomain,
    webAuthEndpoint: need("WEB_AUTH_ENDPOINT"),
    signingKey: need("SIGNING_KEY"),
    transferServer: need("TRANSFER_SERVER_SEP0024"),
    currencies,
  };
}

/** SEP-10: get challenge, validate it, sign with the account's signer, exchange for a JWT. */
export async function sep10(anchor: AnchorInfo, accountId: string, signer: Keypair): Promise<string> {
  const url = new URL(anchor.webAuthEndpoint);
  url.searchParams.set("account", accountId);
  const ch = (await (await fetch(url)).json()) as { transaction?: string; error?: string };
  if (!ch.transaction) throw new Error(`SEP-10 challenge error: ${ch.error ?? "no transaction"}`);

  // Throws if the challenge is malformed or not signed by the anchor's SIGNING_KEY.
  const { tx } = WebAuth.readChallengeTx(
    ch.transaction,
    anchor.signingKey,
    NETWORK(),
    anchor.homeDomain,
    url.host,
  );
  tx.sign(signer);

  const res = await fetch(anchor.webAuthEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transaction: tx.toXDR() }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`SEP-10 token error: ${body.error ?? res.status}`);
  return body.token;
}

/**
 * SEP-24 POST. Anchors differ on accepted body formats: try JSON first (Anchor Platform),
 * fall back to multipart/form-data, which the SEP-24 spec also allows.
 */
async function sep24Post(anchor: AnchorInfo, token: string, path: string, params: Record<string, string>) {
  const url = `${anchor.transferServer}${path}`;
  const auth = { Authorization: `Bearer ${token}` };

  let res = await fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  let body = (await res.json().catch(() => ({}))) as { type?: string; url?: string; id?: string; error?: string };

  if (!body.url && (res.status === 415 || /content-type/i.test(body.error ?? ""))) {
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    res = await fetch(url, { method: "POST", headers: auth, body: form }); // boundary set by fetch
    body = (await res.json().catch(() => ({}))) as typeof body;
  }

  if (!body.url || !body.id) throw new Error(`SEP-24 ${path} error: ${body.error ?? res.status}`);
  return { url: body.url, id: body.id };
}

export const startWithdraw = (anchor: AnchorInfo, token: string, p: { assetCode: string; account: string; amount?: string }) =>
  sep24Post(anchor, token, "/transactions/withdraw/interactive", {
    asset_code: p.assetCode,
    account: p.account,
    ...(p.amount ? { amount: p.amount } : {}),
    lang: "en",
  });

export const startDeposit = (anchor: AnchorInfo, token: string, p: { assetCode: string; account: string; amount?: string }) =>
  sep24Post(anchor, token, "/transactions/deposit/interactive", {
    asset_code: p.assetCode,
    account: p.account,
    ...(p.amount ? { amount: p.amount } : {}),
    lang: "en",
  });

export interface Sep24Tx {
  id: string;
  status: string;
  amount_in?: string;
  amount_out?: string;
  amount_fee?: string;
  withdraw_anchor_account?: string;
  withdraw_memo?: string;
  withdraw_memo_type?: "text" | "id" | "hash";
  stellar_transaction_id?: string;
  message?: string;
}

export async function getTx(anchor: AnchorInfo, token: string, id: string): Promise<Sep24Tx> {
  const res = await fetch(`${anchor.transferServer}/transaction?id=${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await res.json()) as { transaction?: Sep24Tx; error?: string };
  if (!body.transaction) throw new Error(`SEP-24 /transaction error: ${body.error ?? res.status}`);
  return body.transaction;
}

/** Poll until status ∈ targets (or a terminal error status). Logs each status change. */
export async function pollUntil(
  anchor: AnchorInfo,
  token: string,
  id: string,
  targets: string[],
  { intervalMs = 3000, timeoutMs = 15 * 60_000 } = {},
): Promise<Sep24Tx> {
  const terminalErrors = ["error", "expired", "refunded", "no_market", "too_small", "too_large"];
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    const t = await getTx(anchor, token, id);
    if (t.status !== last) {
      log("  anchor status", t.status);
      last = t.status;
    }
    if (targets.includes(t.status)) return t;
    if (terminalErrors.includes(t.status)) throw new Error(`anchor tx ${t.status}: ${t.message ?? ""}`);
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${targets.join("|")}`);
}

function base64ToHex(b64: string): string {
  const bin = atob(b64);
  return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
}

function memoFor(t: Sep24Tx): Memo {
  if (!t.withdraw_memo) return Memo.none();
  switch (t.withdraw_memo_type) {
    case "id":
      return Memo.id(t.withdraw_memo);
    case "hash": // SEP-24: hash memos are base64-encoded
      return Memo.hash(base64ToHex(t.withdraw_memo));
    default:
      return Memo.text(t.withdraw_memo);
  }
}

/** Inner payment tx to the anchor (user's account, signed by device key). Wrap in a sponsor fee-bump. */
export async function buildAnchorPaymentTx(
  accountId: string,
  signer: Keypair,
  asset: Asset,
  t: Sep24Tx,
): Promise<Transaction> {
  if (!t.withdraw_anchor_account || !t.amount_in) {
    throw new Error("anchor tx missing withdraw_anchor_account / amount_in");
  }
  const account = await server().loadAccount(accountId);
  const tx = new TransactionBuilder(account, { fee: FEE(), networkPassphrase: NETWORK() })
    .addOperation(Operation.payment({ destination: t.withdraw_anchor_account, asset, amount: t.amount_in }))
    .addMemo(memoFor(t))
    .setTimeout(180)
    .build();
  tx.sign(signer);
  return tx;
}
