import { useEffect, useState } from "react";
import { LocalStorageStore, StateEngine, addressToField, deriveKeys } from "stellar-confidential-token-sdk";
import { chainClient, demoKeys, deployment, testnetCapabilities, txLink, usdcOf } from "./testnet/env";
import { usdc } from "./data";

/**
 * Cash-out to a bank account through Payslip's own testnet anchor (SEP-10 + SEP-24, same domain).
 * The server signs (server/testnet.js via /api/cashout): no signing key reaches the browser. The
 * browser opens the anchor's page, where the employee confirms the amount, then asks the server to
 * settle it: confidential withdraw of exactly that amount to public USDC, payment to the anchor.
 */
type Step = "auth" | "form" | "settle" | "payout";
const STEPS: { id: Step; label: string }[] = [
  { id: "auth", label: "Ouverture du retrait chez l'anchor (SEP-10, SEP-24)" },
  { id: "form", label: "Confirmation du montant dans la fenêtre de l'anchor" },
  { id: "settle", label: "Retrait confidentiel vers l'USDC public (preuve on-chain), puis paiement à l'anchor" },
  { id: "payout", label: "Virement vers votre banque (simulé, testnet)" },
];

/** What survives a reload, so a cash-out resumes where it stopped (the server never pays twice). */
interface Saved {
  id: string;
  url: string;
  openedAt: number;
  withdrawTx?: string;
  paymentTx?: string;
  completed?: { amount: string; at: string };
}
const KEY = (id: string) => `payslip.cashout.${id}`;
const load = (id: string): Saved | null => { try { return JSON.parse(localStorage.getItem(KEY(id)) ?? "null"); } catch { return null; } };
const store = (id: string, s: Saved | null) => { try { s ? localStorage.setItem(KEY(id), JSON.stringify(s)) : localStorage.removeItem(KEY(id)); } catch { /* private mode: no resume */ } };

async function api<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/cashout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `erreur ${res.status}`);
  return json as T;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type AnchorTx = { status: string; amount_in?: string; amount_out?: string; stellar_transaction_id?: string };

export function Cashout({ employeeId }: { employeeId: string }) {
  const employee = deployment?.employees.find((e) => e.id === employeeId);
  const [max, setMax] = useState<number | null>(null); // server cap; null: cash-out unavailable
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [ack, setAck] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(() => load(employeeId));
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => { testnetCapabilities().then((c) => setMax(c?.cashout ? c.cashoutMax : null)); }, []);

  const readBalance = async () => {
    const keys = deriveKeys(BigInt(demoKeys[employeeId]), addressToField(deployment!.contracts.token));
    const engine = new StateEngine({ client: chainClient(), store: new LocalStorageStore("payslip:state:"), keys, address: employee!.address, fromLedger: deployment!.fromLedger });
    for (let i = 0; i < 4; i++) {
      const s = await engine.sync().catch(() => null);
      if (s) return s.spendable.v + s.receiving.v;
      await sleep(2500);
    }
    throw new Error("lecture du solde impossible");
  };

  useEffect(() => {
    setSaved(load(employeeId));
    setStep(null);
    setError(null);
    setBalance(null);
    if (!employee || !demoKeys[employeeId]) return;
    let live = true;
    readBalance().then((b) => live && setBalance(b)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!deployment || !employee || max === null) return null;

  const update = (s: Saved | null) => { store(employeeId, s); setSaved(s); };
  const unfinished = saved && !saved.completed;

  async function run(popup: Window | null) {
    setRunning(true);
    setError(null);
    try {
      setStep("auth");
      let s = load(employeeId);
      // A cash-out whose interactive link expired before the employee confirmed is reopened.
      if (s && !s.completed && Date.now() - s.openedAt > 50 * 60_000) {
        const t = await api<AnchorTx>({ action: "status", employeeId, id: s.id });
        if (t.status === "incomplete") s = null;
      }
      if (!s || s.completed) {
        const { id, url } = await api<{ id: string; url: string }>({ action: "start", employeeId, amount });
        s = { id, url, openedAt: Date.now() };
        update(s);
      }
      let t = await api<AnchorTx>({ action: "status", employeeId, id: s.id });
      if (t.status === "incomplete") {
        if (popup && !popup.closed) popup.location.href = s.url;
        else window.open(s.url, "payslip-anchor", "popup,width=480,height=640");
      } else popup?.close();

      setStep("form");
      while (t.status === "incomplete") { await sleep(2000); t = await api<AnchorTx>({ action: "status", employeeId, id: s.id }); }

      if (t.status === "pending_user_transfer_start") {
        setStep("settle");
        const r = await api<{ withdrawTx?: string; paymentTx?: string }>({ action: "settle", employeeId, id: s.id });
        s = { ...s, withdrawTx: r.withdrawTx ?? s.withdrawTx, paymentTx: r.paymentTx ?? s.paymentTx };
        update(s);
      }

      setStep("payout");
      while (t.status !== "completed") {
        if (["error", "expired", "refunded"].includes(t.status)) throw new Error(`l'anchor a répondu « ${t.status} »`);
        await sleep(2000);
        t = await api<AnchorTx>({ action: "status", employeeId, id: s.id });
      }
      update({ ...s, paymentTx: s.paymentTx ?? t.stellar_transaction_id, completed: { amount: t.amount_out ?? t.amount_in ?? "", at: new Date().toISOString() } });
      setStep(null);
      setAmount("");
      setAck(false);
      readBalance().then(setBalance).catch(() => {});
    } catch (e) {
      popup?.close();
      setError(String((e as Error)?.message ?? e).split("\n")[0]);
    }
    setRunning(false);
  }

  // The popup must open synchronously in the click handler, or Brave blocks it.
  const start = () => {
    const popup = window.open("", "payslip-anchor", "popup,width=480,height=640");
    popup?.document.write(`<p style="font:16px system-ui;padding:24px">Ouverture du retrait…</p>`);
    run(popup);
  };

  const cap = Math.min(max, balance !== null ? usdcOf(balance) : max);
  const valid = Number(amount) > 0 && Number(amount) <= cap;
  const at = step ? STEPS.findIndex((s) => s.id === step) : -1;

  return (
    <section className="block" aria-labelledby="h-cashout">
      <h2 id="h-cashout">Retirer vers ma banque</h2>
      <p className="muted small">
        Solde confidentiel : <strong>{balance === null ? "…" : usdc(usdcOf(balance))}</strong>. Retrait via l'anchor testnet de Payslip (SEP-24), virement bancaire simulé, {max} USDC maximum sur la démo publique.
      </p>
      <p className="request">Le montant retiré devient public sur la blockchain : votre salaire reste confidentiel tant qu'il reste dans Payslip.</p>

      {saved?.completed && !running && (
        <p className="small">
          Dernier retrait : <strong>{usdc(Number(saved.completed.amount))}</strong> versés sur votre banque (simulé).{" "}
          {saved.paymentTx && <a className="hash" href={txLink(saved.paymentTx)} target="_blank" rel="noreferrer">paiement ↗</a>}
        </p>
      )}

      {!running && !unfinished && (
        <>
          <label className="field">
            <span>Montant à retirer (USDC)</span>
            <input type="number" min={0} max={cap} step="any" placeholder={`jusqu'à ${max}`} value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>J'ai compris que ce montant sera visible publiquement.</span>
          </label>
          <button className="btn btn--primary" onClick={start} disabled={!valid || !ack}>Retirer vers ma banque</button>
        </>
      )}
      {!running && unfinished && (
        <>
          <p className="small">Un retrait est en cours{saved?.withdrawTx ? " (retrait confidentiel déjà effectué)" : ""}.</p>
          <button className="btn btn--primary" onClick={start}>Reprendre le retrait</button>
        </>
      )}

      {(running || step) && (
        <ol className="stages" aria-live="polite">
          {STEPS.map((s, i) => (
            <li key={s.id} className={i < at ? "is-done" : i === at ? "is-active" : ""}><span className="dot" aria-hidden="true" />{s.label}</li>
          ))}
        </ol>
      )}
      {saved?.withdrawTx && (running || unfinished) && (
        <p className="muted small">Retrait confidentiel : <a className="hash" href={txLink(saved.withdrawTx)} target="_blank" rel="noreferrer">{saved.withdrawTx.slice(0, 10)}… ↗</a></p>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
