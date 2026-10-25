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
  if (error) return <section className="verdict verdict--bad"><p className="verdict__title">✕ Attestation refusée</p><p>{error}</p></section>;
  return bundle ? <Check bundle={bundle} shortLink={location.href} /> : <p className="muted">Chargement de l'attestation…</p>;
}

function NewRequest() {
  const [monthly, setMonthly] = useState(3000);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!deployment) return <p className="error">Pas de déploiement testnet dans ce build.</p>;

  function create() {
    if (!deployment) return;
    const { request } = newIncomeRequest({ threshold: unitsOf(monthly * N), employer: deployment.employer.address, token: deployment.contracts.token });
    saveRequest(request);
    setLink(`${location.origin}/salarie#req=${encodeLink(request)}`);
    setCopied(false);
  }

  return (
    <>
      <header className="sheet__head">
        <p className="eyebrow">Vérification de revenus · testnet</p>
        <h1>Demander une attestation</h1>
        <p className="muted">Vous louez un logement ou accordez un prêt ? Demandez une preuve de revenus. Vous saurez si le seuil est atteint, rien de plus.</p>
      </header>
      <section className="block">
        <label className="field">
          <span>Revenu mensuel minimum (USDC)</span>
          <input type="number" min={1} step={100} value={monthly} onChange={(e) => setMonthly(Math.max(1, Number(e.target.value) || 0))} />
        </label>
        <p className="muted small">Sur les {N} derniers salaires, versés par {deployment.employer.name}. Soit au moins {usdc(monthly * N)} au total.</p>
        <button className="btn btn--primary" onClick={create}>Créer la demande</button>
        {link && (
          <div className="share">
            <p>Envoyez ce lien au salarié. Son attestation ne sera valable que pour vous et pour cette demande.</p>
            <div className="share__row">
              <input readOnly value={link} aria-label="Lien de la demande" onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? "Copié" : "Copier"}</button>
            </div>
            <a className="muted small" href={link} target="_blank" rel="noreferrer">Ouvrir comme le salarié ↗</a>
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
      .then(([a, b]) => a && b && setPeriod(`du ${formatDate(a)} au ${formatDate(b)}`));
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
        <p className="eyebrow">Attestation de revenus · testnet</p>
        <h1>Vérification</h1>
      </header>
      {result.kind === "checking" && (
        <section className="verdict verdict--pending" aria-live="polite">
          <p className="verdict__title">Vérification en cours…</p>
          <p className="muted">Lecture des virements sur Stellar, reconstruction des entrées publiques, vérification de la preuve.</p>
        </section>
      )}
      {result.kind === "error" && (
        <section className="verdict verdict--bad" aria-live="polite">
          <p className="verdict__title">✕ Attestation refusée</p>
          <p>{result.message}</p>
        </section>
      )}
      {result.kind === "ok" && (
        <>
          <section className={`verdict ${result.bound ? "verdict--ok" : "verdict--warn"}`} aria-live="polite">
            <p className="verdict__title">✓ Revenus d'au moins {monthly}/mois sur {N} mois</p>
            <p>versés par <strong>{deployment?.employer.name ?? "l'employeur"}</strong>, prouvés sans révéler aucun montant.</p>
            {!result.bound && (
              <p className="small">Attention : cette attestation répond à une demande créée depuis un autre navigateur. La preuve est valide, mais elle n'a pas été faite pour vous.</p>
            )}
          </section>
          <section className="block">
            <h2>Ce qui a été vérifié</h2>
            <ol className="stages">
              {result.verified.steps.map((s) => <li key={s} className="is-done"><span className="dot" aria-hidden="true" />{s}</li>)}
            </ol>
            <h2>Les {N} virements, sur la blockchain</h2>
            <ul className="ledger">
              {result.verified.events.map((ev) => (
                <li key={ev.cursor}>
                  <LedgerDate ledger={ev.ledger} />
                  <span className="amount amount--cipher">montant chiffré</span>
                  <a className="hash" href={txLink(ev.txHash)} target="_blank" rel="noreferrer">{ev.txHash.slice(0, 8)}…</a>
                </li>
              ))}
            </ul>
          </section>
          <section className="certificate" aria-labelledby="h-cert">
            <div className="certificate__body">
              <p className="eyebrow">Payslip · attestation vérifiable</p>
              <h2 id="h-cert">Attestation de revenus</h2>
              <dl>
                <div><dt>Revenus prouvés</dt><dd>au moins {monthly}/mois sur {N} mois</dd></div>
                <div><dt>Employeur</dt><dd>{deployment?.employer.name ?? "—"}</dd></div>
                {period && <div><dt>Période</dt><dd>{period}</dd></div>}
                <div><dt>Vérifiée le</dt><dd>{formatDate(checkedAt)}, contre Stellar testnet</dd></div>
              </dl>
              <p className="muted small">Aucun montant n'est révélé. {qr ? "Scannez le QR code pour revérifier la preuve sur la blockchain." : ""}</p>
            </div>
            {qr && <img className="certificate__qr" src={qr} alt="QR code pour revérifier l'attestation" width={160} height={160} />}
          </section>
          <button className="btn no-print" onClick={() => window.print()}>Imprimer l'attestation</button>
        </>
      )}
    </>
  );
}
