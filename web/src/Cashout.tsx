import { useEffect, useState } from "react";
import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  CircuitProver,
  LocalStorageStore,
  StateEngine,
  addressToField,
  deriveKeys,
  submitMerge,
  submitWithdraw,
  buildWithdrawWitness,
  keypairSigner,
} from "stellar-confidential-token-sdk";
import withdrawCircuit from "stellar-confidential-token-sdk/circuits/withdraw.json";
import { buildAnchorPaymentTx, discover, getTx, pollUntil, sep10, startWithdraw } from "./anchor/anchor";
import { NETWORK_PASSPHRASE, chainClient, demoAccounts, demoKeys, deployment, txLink, usdcOf } from "./testnet/env";
import { usdc } from "./data";

/** Payslip's testnet anchor, served by the app itself (api/anchor.js; the dev server in dev):
 *  no withdrawal cap, bank payout simulated. */
const ANCHOR_DOMAIN = location.host;
const HORIZON = new Horizon.Server("https://horizon-testnet.stellar.org");
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC = new Asset("USDC", USDC_ISSUER);
const toUnits = (amount: string) => BigInt(Math.round(Number(amount) * 1e7));

type Step = "auth" | "form" | "withdraw" | "pay" | "payout";
const STEPS: { id: Step; label: string }[] = [
  { id: "auth", label: "Connexion à l'anchor (SEP-10, signée par votre clé)" },
  { id: "form", label: "Confirmation du montant dans la fenêtre de l'anchor" },
  { id: "withdraw", label: "Retrait confidentiel vers votre USDC public (preuve vérifiée on-chain)" },
  { id: "pay", label: "Paiement à l'anchor, avec son mémo" },
  { id: "payout", label: "Virement vers votre banque (simulé, testnet)" },
];

/** What survives a reload, so a cash-out resumes where it stopped and never pays twice. */
interface Saved {
  anchorTxId: string;
  url: string;
  openedAt: number;
  withdrawTx?: string;
  /** Recorded BEFORE submitting: its hash and expiry decide, on resume, whether it already went through. */
  payment?: { hash: string; maxTime: number };
  paymentTx?: string;
  completed?: { amount: string; at: string };
}
const KEY = (id: string) => `payslip.cashout.${id}`;
const load = (id: string): Saved | null => { try { return JSON.parse(localStorage.getItem(KEY(id)) ?? "null"); } catch { return null; } };
const store = (id: string, s: Saved | null) => { try { s ? localStorage.setItem(KEY(id), JSON.stringify(s)) : localStorage.removeItem(KEY(id)); } catch { /* private mode: no resume */ } };

let withdrawProver: CircuitProver | null = null;

export function Cashout({ employeeId, onDone }: { employeeId: string; onDone?: () => void }) {
  const employee = deployment?.employees.find((e) => e.id === employeeId);
  const secret = demoAccounts[employeeId];
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState("");
  const [ack, setAck] = useState(false);
  const [saved, setSaved] = useState<Saved | null>(() => load(employeeId));
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const engine = () => {
    const keys = deriveKeys(BigInt(demoKeys[employeeId]), addressToField(deployment!.contracts.token));
    return new StateEngine({ client: chainClient(), store: new LocalStorageStore("payslip:state:"), keys, address: employee!.address, fromLedger: deployment!.fromLedger });
  };

  useEffect(() => {
    setSaved(load(employeeId));
    setStep(null);
    setError(null);
    setBalance(null);
    if (!employee || !secret) return;
    let live = true;
    engine().sync()
      .then((s) => live && setBalance(s.spendable.v + s.receiving.v))
      .catch((e) => live && setError(`Lecture du solde impossible : ${e.message}`));
    return () => { live = false; };
  }, [employeeId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!deployment || !employee || !secret) return null;

  const update = (s: Saved | null) => { store(employeeId, s); setSaved(s); };
  const unfinished = saved && !saved.completed;

  async function run(popup: Window | null) {
    setRunning(true);
    setError(null);
    try {
      const kp = Keypair.fromSecret(secret);
      const account = kp.publicKey();
      setStep("auth");
      const anchor = await discover(ANCHOR_DOMAIN).catch(() => {
        throw new Error(`L'anchor testnet ne répond pas sur ${ANCHOR_DOMAIN} (clés de l'anchor absentes ?)`);
      });
      const token = await sep10(anchor, account, kp);

      // Open (or reopen, if its short-lived link expired unused) the anchor's interactive withdrawal.
      let s = load(employeeId);
      const stale = s && !s.payment && Date.now() - s.openedAt > 50 * 60_000 && (await getTx(anchor, token, s.anchorTxId)).status === "incomplete";
      if (!s || s.completed || stale) {
        const { url, id } = await startWithdraw(anchor, token, { assetCode: "USDC", account, amount });
        s = { anchorTxId: id, url, openedAt: Date.now() };
        update(s);
      }
      let t = await getTx(anchor, token, s.anchorTxId);
      if (t.status === "incomplete") {
        if (popup && !popup.closed) popup.location.href = s.url;
        else window.open(s.url, "payslip-anchor", "popup,width=480,height=640");
      } else popup?.close();

      setStep("form");
      t = await pollUntil(anchor, token, s.anchorTxId, ["pending_user_transfer_start", "pending_anchor", "completed"], { intervalMs: 2000, timeoutMs: 30 * 60_000 });

      if (t.status === "pending_user_transfer_start" && !s.paymentTx) {
        // Withdraw exactly what the anchor asks for, minus any public USDC already there (a
        // withdraw that went through before a reload). Only now does an amount become public.
        setStep("withdraw");
        const need = toUnits(t.amount_in!);
        const acct = await HORIZON.loadAccount(account);
        const line = acct.balances.find((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER);
        const have = line ? toUnits(line.balance) : 0n;
        if (have < need) {
          if (!line) {
            const tx = new TransactionBuilder(acct, { fee: "10000", networkPassphrase: NETWORK_PASSPHRASE })
              .addOperation(Operation.changeTrust({ asset: USDC }))
              .setTimeout(120).build();
            tx.sign(kp);
            await HORIZON.submitTransaction(tx);
          }
          const e = engine();
          let state = await e.sync();
          const client = chainClient();
          const signer = keypairSigner(secret, NETWORK_PASSPHRASE);
          if (state.receiving.v > 0n) { await submitMerge(client, signer, account); state = await e.sync(); }
          const { v, r } = await e.spendableForProof();
          const amountUnits = need - have;
          if (v < amountUnits) throw new Error(`Solde confidentiel insuffisant : ${usdc(usdcOf(v))}`);
          const w = buildWithdrawWitness({ keys: deriveKeys(BigInt(demoKeys[employeeId]), addressToField(deployment!.contracts.token)), v, r, amount: amountUnits, kAudS: await client.auditorKey(0) });
          withdrawProver ??= new CircuitProver(withdrawCircuit as never);
          const { proof } = await withdrawProver.prove(w.inputs);
          const res = await submitWithdraw(client, signer, account, account, amountUnits, w, proof);
          s = { ...s, withdrawTx: res.hash };
          update(s);
        }

        // Pay the anchor once. A payment recorded before a reload is looked up first: found → done;
        // not found but still valid → wait for it; expired unseen → it can never land, pay anew.
        setStep("pay");
        if (s.payment) {
          for (;;) {
            const seen = await HORIZON.transactions().transaction(s.payment.hash).call().catch(() => null);
            if (seen?.successful) { s = { ...s, paymentTx: s.payment.hash }; update(s); break; }
            if (Date.now() / 1000 > s.payment.maxTime + 10) { s = { ...s, payment: undefined }; update(s); break; }
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        if (!s.paymentTx) {
          const tx = await buildAnchorPaymentTx(account, kp, USDC, t);
          s = { ...s, payment: { hash: tx.hash().toString("hex"), maxTime: Number(tx.timeBounds?.maxTime ?? 0) } };
          update(s);
          await HORIZON.submitTransaction(tx);
          s = { ...s, paymentTx: s.payment!.hash };
          update(s);
        }
      }

      setStep("payout");
      const done = await pollUntil(anchor, token, s.anchorTxId, ["completed"], { intervalMs: 2000, timeoutMs: 30 * 60_000 });
      update({ ...s, completed: { amount: done.amount_out ?? done.amount_in ?? "", at: new Date().toISOString() } });
      setStep(null);
      setAmount("");
      setAck(false);
      onDone?.();
      // The RPC can lag the withdraw event by a few seconds: retry the balance read.
      for (let i = 0; i < 4; i++) {
        const st = await engine().sync().catch(() => null);
        if (st) { setBalance(st.spendable.v + st.receiving.v); break; }
        await new Promise((r) => setTimeout(r, 2500));
      }
    } catch (e) {
      popup?.close();
      setError(String((e as Error)?.message ?? e).split("\n")[0]);
    }
    setRunning(false);
  }

  // The popup must open synchronously in the click handler, or Brave blocks it.
  const start = () => {
    const popup = window.open("", "payslip-anchor", "popup,width=480,height=640");
    popup?.document.write(`<p style="font:16px system-ui;padding:24px">Connexion à l'anchor…</p>`);
    run(popup);
  };

  const max = balance !== null ? usdcOf(balance) : null;
  const valid = Number(amount) > 0 && (max === null || Number(amount) <= max);
  const at = step ? STEPS.findIndex((s) => s.id === step) : -1;

  return (
    <section className="block" aria-labelledby="h-cashout">
      <h2 id="h-cashout">Retirer vers ma banque</h2>
      <p className="muted small">
        Solde confidentiel : <strong>{balance === null ? "…" : usdc(usdcOf(balance))}</strong>. Retrait via l'anchor testnet de Payslip (SEP-24), virement bancaire simulé.
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
            <input type="number" min={0} step="any" placeholder="ex. 500" value={amount} onChange={(e) => setAmount(e.target.value)} />
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
