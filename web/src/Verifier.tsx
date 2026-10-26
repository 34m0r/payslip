import { useEffect, useState } from "react";
import { N, IncomeVerifyError, decodeLink, encodeLink, newIncomeRequest, verifyIncome, type IncomeBundle, type IncomeRequest, type VerifiedIncome } from "./income/dincome";
import { chainClient, deployment, incomeProver, pinnedVk, txLink, unitsOf, usdcOf } from "./testnet/env";
import { usdc } from "./data";
import { fetchAttestation, formatDate, ledgerTime, qrDataUrl } from "./attestation";
import { LedgerDate } from "./LedgerDate";
import { Topbar } from "./Topbar";

// The verifier's own request records. Per-browser by nature: a request is what binds an
// attestation to THIS verifier, so it must not come from the attestation itself.
const KEY = "payslip.requests";
function loadRequests(): IncomeRequest[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
}
function saveRequest(r: IncomeRequest) {
  try { localStorage.setItem(KEY, JSON.stringify([...loadRequests(), r].slice(-20))); } catch { /* private mode: the link still works */ }
}

/** An attestation in the URL fragment: a short id (#a=…, stored server-side) or the full bundle (#att=…). */
function readSource(): { id: string } | { bundle: IncomeBundle } | null {
  const short = location.hash.match(/(?:^#|&)a=([\w-]+)/);
  if (short) return { id: short[1] };
  const m = location.hash.match(/att=([\w-]+)/);
  if (!m) return null;
  try { return { bundle: decodeLink<IncomeBundle>(m[1]) }; } catch { return null; }
}

type Result =
  | { kind: "checking"; steps: string[] }
  | { kind: "ok"; verified: VerifiedIncome; bound: boolean }
  | { kind: "error"; message: string; stage?: string };

export function Verifier() {
  const [source] = useState(readSource);
  return (
    <div className="page">
      <Topbar current="verifier" />
      <main className="sheet">
        {!source ? <NewRequest /> : "bundle" in source ? <Check bundle={source.bundle} /> : <Fetch id={source.id} />}
      </main>
    </div>
  );
}

function Fetch({ id }: { id: string }) {
  const [bundle, setBundle] = useState<IncomeBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { fetchAttestation(id).then(setBundle).catch((e) => setError(e.message)); }, [id]);
  if (error) return <section className="verdict verdict--bad"><p className="verdict__title">✕ Attestation rejected</p><p>{error}</p></section>;
  return bundle ? <Check bundle={bundle} shortLink={location.href} /> : <p className="muted">Loading the attestation…</p>;
}

function NewRequest() {
  const [monthly, setMonthly] = useState(3000);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!deployment) return <p className="error">No testnet deployment in this build.</p>;

  function create() {
    if (!deployment) return;
    const { request } = newIncomeRequest({ threshold: unitsOf(monthly * N), employer: deployment.employer.address, token: deployment.contracts.token });
    saveRequest(request);
    setLink(`${location.origin}/employee#req=${encodeLink(request)}`);
    setCopied(false);
  }

  return (
    <>
      <header className="sheet__head">
        <p className="eyebrow">Income verification · testnet</p>
        <h1>Request an attestation</h1>
        <p className="muted">Renting out a flat or granting a loan? Ask for proof of income. You will learn whether the threshold is met, nothing more.</p>
      </header>
      <section className="block">
        <label className="field">
          <span>Minimum monthly income (USDC)</span>
          <input type="number" min={1} step={100} value={monthly} onChange={(e) => setMonthly(Math.max(1, Number(e.target.value) || 0))} />
        </label>
        <p className="muted small">Over the last {N} salaries, paid by {deployment.employer.name}: at least {usdc(monthly * N)} in total.</p>
        <button className="btn btn--primary" onClick={create}>Create the request</button>
        {link && (
          <div className="share">
            <p>Send this link to the employee. Their attestation will be valid only for you and this request.</p>
            <div className="share__row">
              <input readOnly value={link} aria-label="Request link" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
            </div>
            <a className="muted small" href={link} target="_blank" rel="noreferrer">Open as the employee ↗</a>
          </div>
        )}
      </section>
    </>
  );
}

function Check({ bundle, shortLink }: { bundle: IncomeBundle; shortLink?: string }) {
  const [result, setResult] = useState<Result>({ kind: "checking", steps: [] });
  const [qr, setQr] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const [checkedAt] = useState(() => new Date());
  useEffect(() => { if (shortLink) qrDataUrl(shortLink).then(setQr); }, [shortLink]);
  useEffect(() => {
    if (result.kind !== "ok") return;
    const evs = result.verified.events;
    Promise.all([ledgerTime(evs[0].ledger), ledgerTime(evs[evs.length - 1].ledger)])
      .then(([a, b]) => a && b && setPeriod(`${formatDate(a)} to ${formatDate(b)}`));
  }, [result]);

  useEffect(() => {
    let live = true;
    (async () => {
      // Our own record of the request, matched by nonce. Without one the proof can still be
      // checked, but it was made for someone else's request and proves nothing about us.
      const own = loadRequests().find((r) => r.nu === bundle.request?.nu) ?? null;
      try {
        const verified = await verifyIncome({ client: chainClient(), bundle, request: own ?? bundle.request, prover: incomeProver(), pinnedVk: pinnedVk() });
        if (live) setResult({ kind: "ok", verified, bound: !!own });
      } catch (e) {
        if (live) setResult({ kind: "error", message: String((e as Error)?.message ?? e), stage: e instanceof IncomeVerifyError ? e.stage : undefined });
      }
    })();
    return () => { live = false; };
  }, [bundle]);

  const monthly = bundle.request ? usdc(usdcOf(BigInt(bundle.request.threshold)) / N) : "";
  return (
    <>
      <header className="sheet__head">
        <p className="eyebrow">Income attestation · testnet</p>
        <h1>Verification</h1>
      </header>
      {result.kind === "checking" && (
        <section className="verdict verdict--pending" aria-live="polite">
          <p className="verdict__title">Verifying…</p>
          <p className="muted">Reading the transfers on Stellar, rebuilding the public inputs, verifying the proof.</p>
        </section>
      )}
      {result.kind === "error" && (
        <section className="verdict verdict--bad" aria-live="polite">
          <p className="verdict__title">✕ Attestation rejected</p>
          <p>{result.message}</p>
        </section>
      )}
      {result.kind === "ok" && (
        <>
          <section className={`verdict ${result.bound ? "verdict--ok" : "verdict--warn"}`} aria-live="polite">
            <p className="verdict__title">✓ Income of at least {monthly}/month over {N} months</p>
            <p>paid by <strong>{deployment?.employer.name ?? "the employer"}</strong>, proven without revealing any amount.</p>
            {!result.bound && (
              <p className="small">Note: this attestation answers a request created in another browser. The proof is valid, but it was not made for you.</p>
            )}
          </section>
          <section className="block">
            <h2>What was verified</h2>
            <ol className="stages">
              {result.verified.steps.map((s) => <li key={s} className="is-done"><span className="dot" aria-hidden="true" />{s}</li>)}
            </ol>
            <h2>The {N} transfers, on the blockchain</h2>
            <ul className="ledger">
              {result.verified.events.map((ev) => (
                <li key={ev.cursor}>
                  <LedgerDate ledger={ev.ledger} />
                  <span className="amount amount--cipher">encrypted amount</span>
                  <a className="hash" href={txLink(ev.txHash)} target="_blank" rel="noreferrer">{ev.txHash.slice(0, 8)}…</a>
                </li>
              ))}
            </ul>
          </section>
          <section className="certificate" aria-labelledby="h-cert">
            <div className="certificate__body">
              <p className="eyebrow">Payslip · verifiable attestation</p>
              <h2 id="h-cert">Income attestation</h2>
              <dl>
                <div><dt>Proven income</dt><dd>at least {monthly}/month over {N} months</dd></div>
                <div><dt>Employeur</dt><dd>{deployment?.employer.name ?? "—"}</dd></div>
                {period && <div><dt>Period</dt><dd>{period}</dd></div>}
                <div><dt>Verified on</dt><dd>{formatDate(checkedAt)}, against Stellar testnet</dd></div>
              </dl>
              <p className="muted small">No amount is revealed. {qr ? "Scan the QR code to re-verify the proof against the blockchain." : ""}</p>
            </div>
            {qr && <img className="certificate__qr" src={qr} alt="QR code to re-verify the attestation" width={160} height={160} />}
          </section>
          <button className="btn no-print" onClick={() => window.print()}>Print the attestation</button>
        </>
      )}
    </>
  );
}
