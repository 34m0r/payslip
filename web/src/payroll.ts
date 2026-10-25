/**
 * Payroll engine. The UI only talks to `PayrollEngine`; this file ships the demo engine
 * (timings modelled on the real flow: one ZK proof per transfer in the employer's browser,
 * then submission). A testnet engine backed by the OpenZeppelin Confidential Token SDK
 * implements the same interface.
 */
import { EMPLOYEES, type Employee } from "./data";

export type TransferStatus = "waiting" | "proving" | "sending" | "received";
export interface Transfer {
  employeeId: string;
  status: TransferStatus;
  ciphertext: string;   // what the public sees in place of the amount
  hash?: string;        // tx hash (demo: simulated, never linked to an explorer)
  receivedAt?: number;
}

export interface PayrollEngine {
  readonly mode: "demo" | "testnet";
  /** `onPhase` narrates steps that belong to no single transfer (funding, current proof). */
  run(onUpdate: (t: Transfer) => void, signal: { cancelled: boolean }, onPhase?: (phase: string) => void): Promise<void>;
}

/** Deterministic pseudo-ciphertext: stable per employee and run, looks like the event's v_tilde. */
export function ciphertextFor(seed: string): string {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let out = "";
  for (let i = 0; i < 12; i++) {
    h = Math.imul(h ^ (h >>> 13), 0x5bd1e995);
    out += ((h >>> 0) % 16).toString(16);
  }
  return `${out.slice(0, 4)} ${out.slice(4, 8)} ${out.slice(8, 12)}`;
}

/** Treasury to wallet, at speed 1. The globe's packet animation is timed on it. */
export const FLIGHT_MS = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fakeHash = (seed: string) => (ciphertextFor(seed + "h") + ciphertextFor(seed + "x")).replace(/ /g, "");

export function initialTransfers(runId: number, employees: Employee[] = EMPLOYEES): Transfer[] {
  return employees.map((e) => ({ employeeId: e.id, status: "waiting", ciphertext: ciphertextFor(`${e.id}:${runId}`) }));
}

export class DemoPayrollEngine implements PayrollEngine {
  readonly mode = "demo" as const;
  constructor(private runId: number, private employees: Employee[] = EMPLOYEES, private speed = 1) {}

  async run(onUpdate: (t: Transfer) => void, signal: { cancelled: boolean }) {
    const flights: Promise<void>[] = [];
    for (const e of this.employees) {
      if (signal.cancelled) return;
      const base = { employeeId: e.id, ciphertext: ciphertextFor(`${e.id}:${this.runId}`) };
      onUpdate({ ...base, status: "proving" });
      await sleep((520 + Math.random() * 380) / this.speed); // proof generation, sequential like the real employer browser
      if (signal.cancelled) return;
      onUpdate({ ...base, status: "sending", hash: fakeHash(base.ciphertext) });
      // flight + ledger confirmation overlap with the next proof (pipelined)
      flights.push(sleep(FLIGHT_MS / this.speed).then(() => {
        if (!signal.cancelled) onUpdate({ ...base, status: "received", hash: fakeHash(base.ciphertext), receivedAt: Date.now() });
      }));
    }
    await Promise.all(flights);
  }
}
