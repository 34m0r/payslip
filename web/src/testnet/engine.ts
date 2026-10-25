/**
 * Testnet payroll engine: the same interface as the demo engine, backed by real
 * transactions. The employer's browser deposits the period's total into its confidential
 * balance, then proves (UltraHonk, verified on-chain) and submits one confidential_transfer
 * per employee. Each emitted event is decrypted back with the employer's audit key before
 * the transfer is reported received, so the auditor view shows chain data, not local data.
 */
import {
  CircuitProver,
  H,
  LocalStorageStore,
  StateEngine,
  addressToField,
  auditTransfer,
  buildTransferWitness,
  deriveKeys,
  fetchEvents,
  keypairSigner,
  scalarMul,
  submitDeposit,
  submitMerge,
  submitTransfer,
  type TransferEvent,
} from "stellar-confidential-token-sdk";
import transferCircuit from "stellar-confidential-token-sdk/circuits/transfer.json";
import type { PayrollEngine, Transfer } from "../payroll";
import { NETWORK_PASSPHRASE, chainClient, deployment, employerKeys, unitsOf } from "./env";

export const testnetAvailable = !!(deployment && employerKeys);
export const TESTNET_EMPLOYEE_IDS = deployment?.employees.map((e) => e.id) ?? [];

/** The event's encrypted amount, shown in place of the salary in the public view (its low
 *  digits: a field element below 2^254 always starts with 0-3, which reads as a pattern). */
const cipherOf = (vTilde: bigint) => {
  const h = vTilde.toString(16).padStart(64, "0").slice(-12);
  return `${h.slice(0, 4)} ${h.slice(4, 8)} ${h.slice(8, 12)}`;
};

let prover: CircuitProver | null = null;

export class TestnetPayrollEngine implements PayrollEngine {
  readonly mode = "testnet" as const;

  async run(onUpdate: (t: Transfer) => void, signal: { cancelled: boolean }, onPhase?: (p: string) => void) {
    if (!deployment || !employerKeys) throw new Error("testnet keys are only available on the dev server");
    const client = chainClient();
    const employer = deployment.employer.address;
    const signer = keypairSigner(employerKeys.secret, NETWORK_PASSPHRASE);
    const keys = deriveKeys(BigInt(employerKeys.sk), addressToField(deployment.contracts.token));
    const auditorSecret = BigInt(employerKeys.auditorSecret);
    const kAud = scalarMul(auditorSecret, H);
    const state = new StateEngine({ client, store: new LocalStorageStore("payslip:state:"), keys, address: employer, fromLedger: deployment.fromLedger });
    prover ??= new CircuitProver(transferCircuit as never);

    // Fund the period: public USDC → confidential. The deposit amount is public by design.
    const total = deployment.employees.reduce((s, e) => s + e.salary, 0);
    onPhase?.("Dépôt de la paie dans la trésorerie confidentielle");
    await submitDeposit(client, signer, employer, employer, unitsOf(total));
    await submitMerge(client, signer, employer);

    for (const e of deployment.employees) {
      if (signal.cancelled) return;
      onUpdate({ employeeId: e.id, status: "proving", ciphertext: "···· ···· ····" });
      onPhase?.(`Preuve du virement à ${e.name}`);
      await state.sync();
      const { v, r } = await state.spendableForProof();
      const recipient = await client.confidentialBalance(e.address);
      if (!recipient) throw new Error(`${e.name} has no confidential account`);
      const w = buildTransferWitness({ keys, v, r, amount: unitsOf(e.salary), pvkB: recipient.viewingPublicKey, kAudR: kAud, kAudS: kAud });
      const { proof } = await prover.prove(w.inputs);
      if (signal.cancelled) return;

      const ciphertext = cipherOf(w.payload.vTilde);
      onUpdate({ employeeId: e.id, status: "sending", ciphertext });
      onPhase?.(`Virement confidentiel à ${e.name}`);
      const startLedger = await client.latestLedger();
      const res = await submitTransfer(client, signer, employer, e.address, w, proof);

      // Received = confirmed on-chain AND the emitted event audits to this salary.
      const { events } = await fetchEvents(client, { startLedger });
      const ev = events.find((x): x is TransferEvent => x.type === "transfer" && x.txHash === res.hash);
      if (!ev) throw new Error(`no transfer event for ${res.hash}`);
      const audit = auditTransfer(auditorSecret, ev);
      if (!audit.channelsAgree || audit.amount !== unitsOf(e.salary)) throw new Error(`audit mismatch on ${res.hash}`);
      onUpdate({ employeeId: e.id, status: "received", ciphertext: cipherOf(ev.vTilde), hash: res.hash, receivedAt: Date.now() });
    }
    onPhase?.("");
  }
}
