// Runs one Atlântica Labs payroll on testnet: the employer deposits the period's total
// from public USDC into its confidential balance, merges it, then pays each employee with
// a confidential_transfer (a real UltraHonk proof, verified on-chain). Amounts never
// appear on the ledger; the employer, as auditor 0, decrypts them back from the events.
//
//   node scripts/testnet/payroll.mjs [period label]     e.g. "Paie 1"
import { Keypair } from "@stellar/stellar-sdk";
import {
  CircuitProver,
  H,
  StateEngine,
  addressToField,
  auditTransfer,
  buildTransferWitness,
  deriveKeys,
  fetchEvents,
  scalarMul,
  submitDeposit,
  submitMerge,
  submitTransfer,
} from "stellar-confidential-token-sdk";
import { loadCircuit } from "stellar-confidential-token-sdk/proving/artifacts";
import { JsonFileStore } from "stellar-confidential-token-sdk/state/json-store";
import {
  STATE_PATH,
  big,
  chainClient,
  ensureUsdc,
  fromUnits,
  loadDeployment,
  loadSecrets,
  retry,
  saveDeployment,
  signerOf,
  toUnits,
  txLink,
} from "./lib.mjs";

const d = loadDeployment();
const secrets = loadSecrets();
if (!d.contracts?.token || !d.steps?.register) throw new Error("run scripts/testnet/deploy.mjs first");

const period = process.argv[2] ?? `Paie ${(d.payrolls?.length ?? 0) + 1}`;
const client = chainClient({ token: d.contracts.token, verifier: d.contracts.verifier, auditor: d.contracts.auditor });
const addrF = addressToField(d.contracts.token);

const employerKp = Keypair.fromSecret(secrets.employer.secret);
const EMPLOYER = employerKp.publicKey();
const signer = signerOf(employerKp);
const keys = deriveKeys(big(secrets.employer.sk), addrF);
const auditorSecret = big(secrets.employer.auditorSecret);
const kAud = scalarMul(auditorSecret, H);
const engine = new StateEngine({ client, store: new JsonFileStore(STATE_PATH), keys, address: EMPLOYER, fromLedger: d.fromLedger });

const total = d.employees.reduce((s, e) => s + e.salary, 0);
console.log(`${period}: ${d.employees.length} salaires, ${total} USDC\n`);

// 1. Fund: public USDC → the employer's confidential balance.
await ensureUsdc(employerKp, total);
const startLedger = await client.latestLedger();
const deposit = await retry("deposit", () => submitDeposit(client, signer, EMPLOYER, EMPLOYER, toUnits(total)));
console.log(`deposit ${total} USDC (public, by design): ${txLink(deposit.hash)}`);
const merge = await retry("merge", () => submitMerge(client, signer, EMPLOYER));
console.log(`merge: ${txLink(merge.hash)}\n`);

// 2. Pay: one confidential transfer per employee, each proven from the verified opening.
const prover = new CircuitProver(loadCircuit("transfer"));
const transfers = [];
for (const e of d.employees) {
  await engine.sync();
  const { v, r } = await engine.spendableForProof();
  const recipient = await client.confidentialBalance(e.address);
  if (!recipient) throw new Error(`${e.name} has no confidential account`);
  const w = buildTransferWitness({ keys, v, r, amount: toUnits(e.salary), pvkB: recipient.viewingPublicKey, kAudR: kAud, kAudS: kAud });
  const t0 = Date.now();
  const { proof } = await prover.prove(w.inputs);
  const provingMs = Date.now() - t0;
  const res = await retry(`transfer ${e.id}`, () => submitTransfer(client, signer, EMPLOYER, e.address, w, proof));
  transfers.push({ employeeId: e.id, to: e.address, tx: res.hash, provingMs });
  console.log(`→ ${e.name.padEnd(16)} ${txLink(res.hash)}  (preuve ${(provingMs / 1000).toFixed(1)} s)`);
}

// 3. Audit: find the emitted events and decrypt each amount with the employer's audit key.
const { events } = await fetchEvents(client, { startLedger });
console.log(`\nauditeur (clé de l'employeur) :`);
for (const t of transfers) {
  const ev = events.find((x) => x.type === "transfer" && x.txHash === t.tx);
  if (!ev) throw new Error(`transfer event for ${t.tx} not found`);
  const audit = auditTransfer(auditorSecret, ev);
  const salary = d.employees.find((e) => e.id === t.employeeId).salary;
  if (!audit.channelsAgree || audit.amount !== toUnits(salary)) throw new Error(`audit mismatch on ${t.tx}`);
  Object.assign(t, { ledger: ev.ledger, eventId: ev.cursor, vTilde: "0x" + ev.vTilde.toString(16) });
  console.log(`  ${t.employeeId}: ${fromUnits(audit.amount)} USDC ✓  (on-chain: v_tilde ${t.vTilde.slice(0, 18)}…)`);
}

d.payrolls = [...(d.payrolls ?? []), { period, at: new Date().toISOString(), total, deposit: deposit.hash, merge: merge.hash, transfers }];
saveDeployment(d);
console.log(`\nenregistré dans deployments/testnet.json`);
process.exit(0);
