import { useEffect, useMemo, useState } from "react";
import { addressToField, deriveKeys, type TransferEvent } from "stellar-confidential-token-sdk";
import { N, decodeLink, decryptSalary, encodeLink, findSalaryEvents, proveIncome, type IncomeRequest, type ProveStage } from "./income/dincome";
import { chainClient, demoKeys, deployment, incomeProver, txLink, usdcOf } from "./testnet/env";
import { qrDataUrl, shareAttestation } from "./attestation";
import { LedgerDate } from "./LedgerDate";
import { usdc } from "./data";
import { Topbar } from "./Topbar";
import { Cashout } from "./Cashout";

const STAGES: { id: ProveStage; label: string }[] = [
  { id: "decrypt", label: "Decrypting your last 3 salaries, on this device" },
  { id: "witness", label: "Preparing the witness (key and amounts stay private)" },
  { id: "prove", label: "Generating the zero-knowledge proof" },
  { id: "self-check", label: "Checking the proof locally" },
];

type Salary = { ev: TransferEvent; amount: bigint };
type Phase = { kind: "idle" } | { kind: "proving"; stage: ProveStage; since: number } | { kind: "done"; link: string; qr: string | null; ms: number } | { kind: "error"; message: string };

function readRequest(): IncomeRequest | null {
  const m = location.hash.match(/req=([\w-]+)/);
  if (!m) return null;
  try { return decodeLink<IncomeRequest>(m[1]); } catch { return null; }
}

export function Employee() {
  const employees = deployment?.employees.filter((e) => demoKeys[e.id]) ?? [];
  const [employeeId, setEmployeeId] = useState(employees[0]?.id ?? "");
  const employee = employees.find((e) => e.id === employeeId);
  const keys = useMemo(
    () => (employee && deployment ? deriveKeys(BigInt(demoKeys[employee.id]), addressToField(deployment.contracts.token)) : null),
    [employee],
  );
  const [salaries, setSalaries] = useState<Salary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [request] = useState(readRequest);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!employee || !keys || !deployment) return;
    let live = true;
    setSalaries(null);
    setLoadError(null);
    findSalaryEvents(chainClient(), { employer: deployment.employer.address, holder: employee.address, fromLedger: deployment.fromLedger })
      .then((evs) => live && setSalaries(evs.map((ev) => ({ ev, amount: decryptSalary(keys, ev) }))))
      .catch((e) => live && setLoadError(String(e?.message ?? e)));
    return () => { live = false; };
  }, [employee, keys]);

  if (!deployment || !employee || !keys) {
    return (
      <div className="page">
        <Topbar current="employee" />
        <main className="sheet"><p className="muted">No demo employee account is available in this build (no testnet keys).</p></main>
      </div>
    );
  }

  const total = salaries?.reduce((s, x) => s + x.amount, 0n) ?? 0n;
  const enough = request ? total >= BigInt(request.threshold) : false;
  const wrongEmployer = request && request.employer !== deployment.employer.address;

  async function attest() {
    if (!request || !salaries || !keys || !employee) return;
    const start = performance.now();
    setPhase({ kind: "proving", stage: "decrypt", since: start });
    try {
      const { bundle } = await proveIncome({
        keys, holder: employee.address, events: salaries.map((s) => s.ev), request, prover: incomeProver(),
        onStage: (stage) => setPhase({ kind: "proving", stage, since: start }),
      });
      const ms = performance.now() - start;
      // A short link (and its QR code) when the server can store the attestation; else the full link.
      const short = await shareAttestation(bundle);
      const link = short ?? `${location.origin}/verifier#att=${encodeLink(bundle)}`;
      setPhase({ kind: "done", link, qr: short ? await qrDataUrl(short) : null, ms });
    } catch (e) {
      setPhase({ kind: "error", message: String((e as Error)?.message ?? e) });
    }
  }

  return (
    <div className="page">
      <Topbar current="employee" />
      <main className="sheet">
        <header className="sheet__head">
          <p className="eyebrow">Employee · testnet</p>
          <h1>{employee.name}</h1>
          <p className="muted">At {deployment.employer.name}, {employee.city}. Your salaries arrive encrypted: only your key reads them.</p>
          <p className="muted small">Demo accounts on Stellar testnet: fictitious salaries, real transactions.</p>
          {employees.length > 1 && (
            <label className="field field--inline">
              <span>Demo account</span>
              <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setPhase({ kind: "idle" }); }}>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
          )}
        </header>

        <section className="block" aria-labelledby="h-salaries">
          <h2 id="h-salaries">Your last {N} salaries</h2>
          {loadError && <p className="error">Could not read the chain: {loadError}</p>}
          {!salaries && !loadError && <p className="muted">Reading the transfers on Stellar testnet…</p>}
          {salaries && (
            <ul className="ledger">
              {salaries.map(({ ev, amount }) => (
                <li key={ev.cursor}>
                  <LedgerDate ledger={ev.ledger} />
                  <span className="amount">{usdc(usdcOf(amount))}</span>
                  <a className="hash" href={txLink(ev.txHash)} target="_blank" rel="noreferrer">{ev.txHash.slice(0, 8)}…</a>
                </li>
              ))}
              <li className="ledger__total"><span>Total</span><span className="amount">{usdc(usdcOf(total))}</span><span /></li>
            </ul>
          )}
          <p className="muted small">On the blockchain, each of these transfers shows the employer and you, never the amount.</p>
        </section>

        <section className="block" aria-labelledby="h-attest">
          <h2 id="h-attest">Income attestation</h2>
          {!request ? (
            <p className="muted">
              No request yet. Your landlord (or your bank) creates one on the{" "}
              <a href="/verifier">verification page</a> and sends you the link: it opens here.
            </p>
          ) : (
            <>
              <div className="request">
                <p>
                  <strong>You are asked to prove</strong> salaries of at least{" "}
                  <strong>{usdc(usdcOf(BigInt(request.threshold)) / N)}/month</strong> over {N} months
                  (at least {usdc(usdcOf(BigInt(request.threshold)))} in total), paid by {deployment.employer.name}.
                </p>
                <p className="muted small">The verifier will only learn whether it is true. Not your amounts, not their total.</p>
              </div>
              {wrongEmployer && <p className="error">This request names another employer than yours.</p>}
              {salaries && !enough && !wrongEmployer && <p className="error">Your last 3 salaries do not reach this threshold: no proof is possible.</p>}
              {phase.kind === "idle" || phase.kind === "error" ? (
                <button className="btn btn--primary" onClick={attest} disabled={!salaries || !enough || !!wrongEmployer}>Create the attestation</button>
              ) : null}
              {phase.kind === "error" && <p className="error">{phase.message}</p>}
              {phase.kind === "proving" && <Stages current={phase.stage} />}
              {phase.kind === "done" && (
                <div className="share">
                  <Stages current={null} />
                  <p>Proof generated in your browser in {(phase.ms / 1000).toFixed(1)} s. Send this link to your verifier, or show them the QR code:</p>
                  <div className="share__qr">
                    {phase.qr && <img src={phase.qr} alt="QR code of the attestation" width={180} height={180} />}
                    <div className="share">
                      <div className="share__row">
                        <input readOnly value={phase.link} aria-label="Attestation link" onFocus={(e) => e.currentTarget.select()} />
                        <button className="btn" onClick={() => navigator.clipboard?.writeText(phase.link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
                      </div>
                      <a className="muted small" href={phase.link} target="_blank" rel="noreferrer">Open the attestation (verifiable and printable) ↗</a>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <Cashout employeeId={employee.id} />
      </main>
    </div>
  );
}

function Stages({ current }: { current: ProveStage | null }) {
  const at = current ? STAGES.findIndex((s) => s.id === current) : STAGES.length;
  return (
    <ol className="stages" aria-live="polite">
      {STAGES.map((s, i) => (
        <li key={s.id} className={i < at ? "is-done" : i === at ? "is-active" : ""}>
          <span className="dot" aria-hidden="true" />{s.label}
        </li>
      ))}
    </ol>
  );
}
