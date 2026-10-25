// Server-side testnet actions, so visitors (the jury) can run a real payroll and a real cash-out
// without any signing key reaching the browser. The keys live in the environment
// (PAYSLIP_TESTNET_KEYS: the JSON of .secrets/testnet.secret.json). A visitor can only trigger
// these fixed actions: the payroll always pays the three demo employees their salaries, a cash-out
// always goes from an employee to Payslip's own anchor, capped at CASHOUT_MAX_USDC.
//
// Used by api/payroll.js and api/cashout.js on Vercel, and by the dev server (vite.config.ts).
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  ChainClient,
  CircuitProver,
  H,
  MemoryStore,
  StateEngine,
  addressToField,
  auditTransfer,
  buildTransferWitness,
  buildWithdrawWitness,
  deriveKeys,
  fetchEvents,
  keypairSigner,
  scalarMul,
  submitDeposit,
  submitMerge,
  submitTransfer,
  submitWithdraw,
} from "stellar-confidential-token-sdk";
import { loadCircuit } from "stellar-confidential-token-sdk/proving/artifacts";
import deployment from "../deployments/testnet.json" with { type: "json" };
import { handle as anchorHandle } from "./anchor-core.js";

export const CASHOUT_MAX_USDC = 50;
// Each demo employee is paid out in their city's currency by default (simulated rates, see anchor-core).
const PAYOUT_CURRENCY = { "Lisbonne": "EUR", "São Paulo": "BRL", "Lagos": "NGN" };
export const PAYROLL_COOLDOWN_S = 180;
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const units = (usdc) => BigInt(Math.round(Number(usdc) * 1e7));
const fromUnits = (u) => Number(u) / 1e7;

export class ActionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function secrets() {
  const raw = process.env.PAYSLIP_TESTNET_KEYS;
  if (!raw) throw new ActionError(503, "testnet actions are not configured on this server");
  return JSON.parse(raw);
}
const client = () => new ChainClient({
  rpcUrl: RPC_URL,
  networkPassphrase: NETWORK,
  contracts: { token: deployment.contracts.token, verifier: deployment.contracts.verifier, auditor: deployment.contracts.auditor },
});
const addrF = () => addressToField(deployment.contracts.token);
const employeeOf = (id) => {
  const e = deployment.employees.find((x) => x.id === id);
  if (!e) throw new ActionError(400, `unknown employee ${id}`);
  return e;
};

/** What this server can do, for the UI to decide what to offer. */
export function capabilities() {
  return { payroll: !!process.env.PAYSLIP_TESTNET_KEYS, cashout: !!process.env.PAYSLIP_TESTNET_KEYS, cashoutMax: CASHOUT_MAX_USDC, cooldown: PAYROLL_COOLDOWN_S };
}

// ---------------------------------------------------------------------------
// Treasury: public USDC for the next deposit (friendbot XLM → testnet DEX)
// ---------------------------------------------------------------------------

async function submitClassic(kp, ops) {
  const account = await horizon.loadAccount(kp.publicKey());
  const b = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: NETWORK });
  ops.forEach((op) => b.addOperation(op));
  const tx = b.setTimeout(120).build();
  tx.sign(kp);
  return horizon.submitTransaction(tx);
}
async function usdcBalance(publicKey) {
  const a = await horizon.loadAccount(publicKey);
  const line = a.balances.find((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  return line ? Number(line.balance) : 0;
}
async function topUp(kp, target) {
  for (let round = 0; round < 8; round++) {
    if ((await usdcBalance(kp.publicKey())) >= target) return;
    const xlm = Number((await horizon.loadAccount(kp.publicKey())).balances.find((b) => b.asset_type === "native").balance);
    if (xlm - 200 < 1000) {
      const helper = Keypair.random();
      const r = await fetch(`https://friendbot.stellar.org?addr=${helper.publicKey()}`);
      if (!r.ok) throw new Error(`friendbot ${r.status}`);
      await submitClassic(helper, [Operation.accountMerge({ destination: kp.publicKey() })]);
      continue;
    }
    const sendAmount = String(Math.min(Math.floor(xlm - 200), 9000));
    const best = (await horizon.strictSendPaths(Asset.native(), sendAmount, [USDC]).call()).records[0];
    if (!best) throw new Error("no XLM→USDC path on the testnet DEX");
    await submitClassic(kp, [Operation.pathPaymentStrictSend({
      sendAsset: Asset.native(), sendAmount, destination: kp.publicKey(), destAsset: USDC,
      destMin: (Number(best.destination_amount) * 0.98).toFixed(7),
      path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
    })]);
  }
}

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

let payrollRunning = false;

/** Seconds since the employer's last confidential transfer (null: none in the last ~15 min). */
async function lastPayrollAge(c) {
  const latest = await c.latestLedger();
  const { events } = await fetchEvents(c, { startLedger: latest - 200 });
  const last = events.filter((e) => e.type === "transfer" && e.from === deployment.employer.address).at(-1);
  return last ? (latest - last.ledger) * 5 : null;
}

const cipherOf = (vTilde) => {
  const h = vTilde.toString(16).padStart(64, "0").slice(-12);
  return `${h.slice(0, 4)} ${h.slice(4, 8)} ${h.slice(8, 12)}`;
};

/**
 * One payroll: deposit the period's USDC, then one proven confidential_transfer per employee.
 * `emit` receives { type: "phase", text } and { type: "update", transfer } as the run progresses;
 * a transfer is reported received only once its on-chain event audits to the salary.
 */
export async function runPayroll(emit) {
  const s = secrets();
  const c = client();
  if (payrollRunning) throw new ActionError(429, "Une paie est déjà en cours.");
  const age = await lastPayrollAge(c);
  if (age !== null && age < PAYROLL_COOLDOWN_S) {
    throw new ActionError(429, `Une paie vient d'être lancée : réessayez dans ${Math.ceil((PAYROLL_COOLDOWN_S - age) / 60)} min.`);
  }
  payrollRunning = true;
  try {
    const employerKp = Keypair.fromSecret(s.employer.secret);
    const employer = employerKp.publicKey();
    const signer = keypairSigner(s.employer.secret, NETWORK);
    const keys = deriveKeys(BigInt(s.employer.sk), addrF());
    const auditorSecret = BigInt(s.employer.auditorSecret);
    const kAud = scalarMul(auditorSecret, H);
    const total = deployment.employees.reduce((sum, e) => sum + e.salary, 0);

    if ((await usdcBalance(employer)) < total) {
      emit({ type: "phase", text: "Recharge de la trésorerie testnet (friendbot + DEX)" });
      await topUp(employerKp, total);
    }
    emit({ type: "phase", text: "Dépôt de la paie dans la trésorerie confidentielle" });
    await submitDeposit(c, signer, employer, employer, units(total));
    await submitMerge(c, signer, employer);

    const state = new StateEngine({ client: c, store: new MemoryStore(), keys, address: employer, fromLedger: deployment.fromLedger });
    const prover = new CircuitProver(loadCircuit("transfer"));
    for (const e of deployment.employees) {
      emit({ type: "update", transfer: { employeeId: e.id, status: "proving", ciphertext: "···· ···· ····" } });
      emit({ type: "phase", text: `Preuve du virement à ${e.name}` });
      await state.sync();
      const { v, r } = await state.spendableForProof();
      const recipient = await c.confidentialBalance(e.address);
      const w = buildTransferWitness({ keys, v, r, amount: units(e.salary), pvkB: recipient.viewingPublicKey, kAudR: kAud, kAudS: kAud });
      const { proof } = await prover.prove(w.inputs);
      emit({ type: "update", transfer: { employeeId: e.id, status: "sending", ciphertext: cipherOf(w.payload.vTilde) } });
      emit({ type: "phase", text: `Virement confidentiel à ${e.name}` });
      const startLedger = await c.latestLedger();
      const res = await submitTransfer(c, signer, employer, e.address, w, proof);
      const { events } = await fetchEvents(c, { startLedger });
      const ev = events.find((x) => x.type === "transfer" && x.txHash === res.hash);
      const audit = ev && auditTransfer(auditorSecret, ev);
      if (!audit?.channelsAgree || audit.amount !== units(e.salary)) throw new Error(`audit mismatch on ${res.hash}`);
      emit({ type: "update", transfer: { employeeId: e.id, status: "received", ciphertext: cipherOf(ev.vTilde), hash: res.hash, receivedAt: Date.now() } });
    }
    await prover.destroy();
    emit({ type: "done" });
    // Refill for the next visitor, after the result is out.
    if ((await usdcBalance(employer)) < total) await topUp(employerKp, total * 2).catch(() => {});
  } finally {
    payrollRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Cash-out through Payslip's anchor (same deployment, called in-process)
// ---------------------------------------------------------------------------

async function anchorCall(origin, method, path, { query = {}, body = {}, token } = {}) {
  const out = await anchorHandle({ method, path, query, body, origin, headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = JSON.parse(out.body || "{}");
  if (out.status >= 400) throw new ActionError(502, `anchor ${path}: ${json.error ?? out.status}`);
  return json;
}
async function sep10(origin, kp) {
  const { transaction } = await anchorCall(origin, "GET", "/auth", { query: { account: kp.publicKey() } });
  const { Transaction } = await import("@stellar/stellar-sdk");
  const tx = new Transaction(transaction, NETWORK);
  tx.sign(kp);
  return (await anchorCall(origin, "POST", "/auth", { body: { transaction: tx.toXDR() } })).token;
}
const employeeKp = (id) => {
  employeeOf(id);
  return Keypair.fromSecret(secrets().employees[id].secret);
};

/** Open an interactive withdrawal at the anchor; the browser shows its page in a popup. */
export async function cashoutStart(origin, { employeeId, amount }) {
  const n = Number(amount);
  if (!(n > 0) || n > CASHOUT_MAX_USDC) throw new ActionError(400, `montant entre 0 et ${CASHOUT_MAX_USDC} USDC sur la démo publique`);
  const kp = employeeKp(employeeId);
  const token = await sep10(origin, kp);
  const payout_currency = PAYOUT_CURRENCY[employeeOf(employeeId).city] ?? "USD";
  const { id, url } = await anchorCall(origin, "POST", "/sep24/transactions/withdraw/interactive", { body: { asset_code: "USDC", account: kp.publicKey(), amount: String(n), payout_currency }, token });
  return { id, url };
}

export async function cashoutStatus(origin, { employeeId, id }) {
  const kp = employeeKp(employeeId);
  const { transaction } = await anchorCall(origin, "GET", "/sep24/transaction", { query: { id }, token: await sep10(origin, kp) });
  return transaction;
}

/**
 * Settle a confirmed withdrawal: confidential withdraw of exactly what the anchor asks for (minus
 * public USDC already there), then pay the anchor with its memo. Idempotent: an existing payment
 * with that memo is found on-chain and never repeated.
 */
export async function cashoutSettle(origin, { employeeId, id }) {
  const kp = employeeKp(employeeId);
  const account = kp.publicKey();
  const t = await cashoutStatus(origin, { employeeId, id });
  if (t.status !== "pending_user_transfer_start") return { status: t.status };
  if (Number(t.amount_in) > CASHOUT_MAX_USDC) throw new ActionError(400, `montant au-delà de ${CASHOUT_MAX_USDC} USDC`);

  const paid = (await horizon.payments().forAccount(account).order("desc").limit(50).join("transactions").call()).records.find(
    (p) => p.type === "payment" && p.from === account && p.to === t.withdraw_anchor_account && p.transaction_attr?.memo === t.withdraw_memo,
  );
  if (paid) return { status: "pending_anchor", paymentTx: paid.transaction_hash };

  const need = units(t.amount_in);
  const acct = await horizon.loadAccount(account);
  const line = acct.balances.find((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  const have = line ? units(line.balance) : 0n;
  let withdrawTx;
  if (have < need) {
    if (!line) await submitClassic(kp, [Operation.changeTrust({ asset: USDC })]);
    const s = secrets();
    const c = client();
    const signer = keypairSigner(s.employees[employeeId].secret, NETWORK);
    const keys = deriveKeys(BigInt(s.employees[employeeId].sk), addrF());
    const engine = new StateEngine({ client: c, store: new MemoryStore(), keys, address: account, fromLedger: deployment.fromLedger });
    let state = await engine.sync();
    if (state.receiving.v > 0n) { await submitMerge(c, signer, account); state = await engine.sync(); }
    const { v, r } = await engine.spendableForProof();
    if (v < need - have) throw new ActionError(400, `solde confidentiel insuffisant (${fromUnits(v)} USDC)`);
    const w = buildWithdrawWitness({ keys, v, r, amount: need - have, kAudS: await c.auditorKey(0) });
    const prover = new CircuitProver(loadCircuit("withdraw"));
    const { proof } = await prover.prove(w.inputs);
    await prover.destroy();
    withdrawTx = (await submitWithdraw(c, signer, account, account, need - have, w, proof)).hash;
  }

  const { Memo } = await import("@stellar/stellar-sdk");
  const payTx = new TransactionBuilder(await horizon.loadAccount(account), { fee: String(Number(BASE_FEE) * 10), networkPassphrase: NETWORK })
    .addOperation(Operation.payment({ destination: t.withdraw_anchor_account, asset: USDC, amount: t.amount_in }))
    .addMemo(Memo.id(t.withdraw_memo))
    .setTimeout(120)
    .build();
  payTx.sign(kp);
  const sent = await horizon.submitTransaction(payTx);
  return { status: "pending_anchor", withdrawTx, paymentTx: sent.hash };
}
