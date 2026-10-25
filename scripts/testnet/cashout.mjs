// An employee cashes out part of their salary to a bank account through a SEP-24 anchor:
// by default Payslip's testnet anchor (scripts/anchor/server.mjs, no withdrawal cap, simulated
// bank payout); ANCHOR_DOMAIN=testanchor.stellar.org uses the SDF test anchor (1–10 USDC).
//   1. merge received salaries into the spendable balance (if any are pending);
//   2. confidential `withdraw` (UltraHonk proof, verified on-chain) to their own public USDC:
//      the withdrawn amount becomes PUBLIC at this step;
//   3. SEP-10 with the employee's Stellar key, SEP-24 interactive withdraw: open the printed URL
//      and complete the anchor's form; the script waits for `pending_user_transfer_start`;
//   4. pay the anchor with its memo, then poll until `completed`.
// Resumable: each finished step is recorded in deployments/testnet.json (`cashouts`). A rerun
// continues the last unfinished cash-out of that employee and never pays the anchor twice.
//
//   node scripts/anchor/server.mjs &                                  (once)
//   node scripts/testnet/cashout.mjs [employeeId] [amount USDC]     e.g. e03 1500
import { Keypair, Operation } from "@stellar/stellar-sdk";
import {
  StateEngine,
  CircuitProver,
  addressToField,
  buildWithdrawWitness,
  deriveKeys,
  submitMerge,
  submitWithdraw,
} from "stellar-confidential-token-sdk";
import { loadCircuit } from "stellar-confidential-token-sdk/proving/artifacts";
import { JsonFileStore } from "stellar-confidential-token-sdk/state/json-store";
import { buildAnchorPaymentTx, discover, getTx, pollUntil, sep10, startWithdraw } from "../../web/src/anchor/anchor.ts";
import {
  STATE_PATH,
  USDC,
  big,
  chainClient,
  fromUnits,
  horizon,
  loadDeployment,
  loadSecrets,
  retry,
  saveDeployment,
  signerOf,
  submitClassic,
  toUnits,
  txLink,
  usdcBalance,
} from "./lib.mjs";

const ANCHOR_DOMAIN = process.env.ANCHOR_DOMAIN ?? "localhost:8790";
const [id = "e03", amountArg = "5"] = process.argv.slice(2);
const d = loadDeployment();
const secrets = loadSecrets();
const employee = d.employees.find((e) => e.id === id);
if (!employee) throw new Error(`unknown employee ${id}`);

const kp = Keypair.fromSecret(secrets.employees[id].secret);
const ACCOUNT = kp.publicKey();
const client = chainClient({ token: d.contracts.token, verifier: d.contracts.verifier, auditor: d.contracts.auditor });

// Resume the employee's last unfinished cash-out, or start a new one.
d.cashouts ??= [];
let c = d.cashouts.findLast((x) => x.employeeId === id && x.status !== "completed");
if (!c) {
  c = { employeeId: id, account: ACCOUNT, amount: amountArg, startedAt: new Date().toISOString(), status: "started" };
  d.cashouts.push(c);
  saveDeployment(d);
} else {
  console.log(`reprise du retrait commencé le ${c.startedAt} (${c.amount} USDC, étape « ${c.status} »)`);
}
const save = (patch) => { Object.assign(c, patch); saveDeployment(d); };
// A cash-out left open at another anchor, never paid: keep its withdraw (the USDC is on the
// employee's public account) and reopen the withdrawal at this anchor.
if (c.anchorTxId && (c.anchorDomain ?? "testanchor.stellar.org") !== ANCHOR_DOMAIN && !c.paymentTx) {
  console.log(`retrait ouvert chez ${c.anchorDomain ?? "testanchor.stellar.org"} abandonné, reprise chez ${ANCHOR_DOMAIN}`);
  save({ abandonedAnchor: { domain: c.anchorDomain ?? "testanchor.stellar.org", id: c.anchorTxId }, anchorTxId: undefined, interactiveUrl: undefined, status: c.withdrawTx ? "withdrawn" : c.status });
}
const units = toUnits(Number(c.amount));

// --- 1-2. Confidential balance → public USDC (the amount becomes public here) -----------------
if (!c.withdrawTx) {
  const keys = deriveKeys(big(secrets.employees[id].sk), addressToField(d.contracts.token));
  const engine = new StateEngine({ client, store: new JsonFileStore(STATE_PATH), keys, address: ACCOUNT, fromLedger: d.fromLedger });
  let state = await engine.sync();
  if (state.receiving.v > 0n) {
    const m = await retry("merge", () => submitMerge(client, signerOf(kp), ACCOUNT));
    console.log(`merge des salaires reçus : ${txLink(m.hash)}`);
    save({ mergeTx: m.hash });
    state = await engine.sync();
  }
  const { v, r } = await engine.spendableForProof();
  if (v < units) throw new Error(`solde confidentiel ${fromUnits(v)} USDC < ${c.amount} USDC`);

  // The public account needs a USDC trustline to receive the withdrawal.
  const account = await horizon.loadAccount(ACCOUNT);
  if (!account.balances.some((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer)) {
    await submitClassic(kp, [Operation.changeTrust({ asset: USDC })]);
    console.log("trustline USDC ajoutée au compte public");
  }

  const w = buildWithdrawWitness({ keys, v, r, amount: units, kAudS: await client.auditorKey(0) });
  const { proof } = await new CircuitProver(loadCircuit("withdraw")).prove(w.inputs);
  const res = await retry("withdraw", () => submitWithdraw(client, signerOf(kp), ACCOUNT, ACCOUNT, units, w, proof));
  console.log(`withdraw confidentiel → USDC public (${c.amount} USDC, montant PUBLIC) : ${txLink(res.hash)}`);
  save({ withdrawTx: res.hash, status: "withdrawn" });
}

// --- 3. SEP-10 + SEP-24 interactive withdraw ---------------------------------------------------
const anchor = await discover(ANCHOR_DOMAIN);
const token = await sep10(anchor, ACCOUNT, kp);
// The interactive URL carries a short-lived token: an unfinished one older than 50 min is reopened.
const stale = c.anchorTxId && !c.paymentTx && Date.now() - Date.parse(c.interactiveAt ?? 0) > 50 * 60_000
  && (await getTx(anchor, token, c.anchorTxId)).status === "incomplete";
if (!c.anchorTxId || stale) {
  const { url, id: anchorTxId } = await startWithdraw(anchor, token, { assetCode: "USDC", account: ACCOUNT, amount: c.amount });
  save({ anchorTxId, anchorDomain: ANCHOR_DOMAIN, interactiveUrl: url, interactiveAt: new Date().toISOString(), status: "interactive" });
}
let t = await getTx(anchor, token, c.anchorTxId);
if (t.status === "incomplete") {
  console.log(`\nOuvrez cette page et remplissez le formulaire de retrait de l'anchor :\n${c.interactiveUrl}\n`);
  t = await pollUntil(anchor, token, c.anchorTxId, ["pending_user_transfer_start"], { timeoutMs: 30 * 60_000 });
}

// --- 4. Pay the anchor, once -------------------------------------------------------------------
// Pay only when the anchor waits for funds AND no payment is recorded: a rerun after a crash
// between submit and save finds the anchor past `pending_user_transfer_start` and skips.
if (!c.paymentTx && t.status === "pending_user_transfer_start") {
  const have = await usdcBalance(ACCOUNT);
  if (have < Number(t.amount_in)) throw new Error(`USDC public ${have} < montant demandé par l'anchor ${t.amount_in}`);
  const tx = await buildAnchorPaymentTx(ACCOUNT, kp, USDC, t);
  const sent = await horizon.submitTransaction(tx);
  console.log(`paiement de ${t.amount_in} USDC à l'anchor (memo ${t.withdraw_memo_type ?? "none"}) : ${txLink(sent.hash)}`);
  save({ paymentTx: sent.hash, amountIn: t.amount_in, status: "paid" });
}

const done = await pollUntil(anchor, token, c.anchorTxId, ["completed"], { timeoutMs: 30 * 60_000 });
save({ status: "completed", amountOut: done.amount_out, completedAt: new Date().toISOString() });
console.log(`\n✅ retrait terminé : ${done.amount_out ?? c.amount} USDC versés sur le compte bancaire (virement simulé, testnet)`);
process.exit(0);
