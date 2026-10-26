/**
 * Testnet payroll engine: the same interface as the demo engine, backed by real transactions that
 * the SERVER signs and proves (server/testnet.js via /api/payroll), so no signing key reaches the
 * browser. The server streams its progress as NDJSON lines, replayed here as engine updates; a
 * transfer is reported received only once its on-chain event audits to the salary.
 */
import type { PayrollEngine, Transfer } from "../payroll";

type Line =
  | { type: "phase"; text: string }
  | { type: "update"; transfer: Transfer }
  | { type: "done" }
  | { type: "error"; status: number; message: string };

export class TestnetPayrollEngine implements PayrollEngine {
  readonly mode = "testnet" as const;

  async run(onUpdate: (t: Transfer) => void, signal: { cancelled: boolean }, onPhase?: (p: string) => void) {
    const res = await fetch("/api/payroll", { method: "POST" });
    if (!res.ok || !res.body) throw new Error(`the server refused the payroll (${res.status})`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines.filter(Boolean)) {
        const line = JSON.parse(raw) as Line;
        if (signal.cancelled) return;
        if (line.type === "phase") onPhase?.(line.text);
        else if (line.type === "update") onUpdate(line.transfer);
        else if (line.type === "error") throw new Error(line.message);
        else if (line.type === "done") { onPhase?.(""); return; }
      }
    }
  }
}
