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
  { id: "decrypt", label: "Déchiffrement de vos 3 derniers salaires, sur cet appareil" },
  { id: "witness", label: "Préparation du témoin (clé et montants restent privés)" },
  { id: "prove", label: "Génération de la preuve à divulgation nulle" },
  { id: "self-check", label: "Vérification locale de la preuve" },
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
        <main className="sheet"><p className="muted">Aucun compte salarié de démo n'est disponible dans ce build (clés testnet absentes).</p></main>
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
          <p className="eyebrow">Espace salarié · testnet</p>
          <h1>{employee.name}</h1>
          <p className="muted">Chez {deployment.employer.name}, {employee.city}. Vos salaires arrivent chiffrés : seule votre clé les lit.</p>
          <p className="muted small">Comptes de démonstration sur Stellar testnet : salaires fictifs, transactions réelles.</p>
          {employees.length > 1 && (
            <label className="field field--inline">
              <span>Compte de démo</span>
              <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setPhase({ kind: "idle" }); }}>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </label>
          )}
        </header>

        <section className="block" aria-labelledby="h-salaries">
          <h2 id="h-salaries">Vos {N} derniers salaires</h2>
          {loadError && <p className="error">Lecture on-chain impossible : {loadError}</p>}
          {!salaries && !loadError && <p className="muted">Lecture des virements sur Stellar testnet…</p>}
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
          <p className="muted small">Sur la blockchain, chacun de ces virements montre l'employeur et vous, jamais le montant.</p>
        </section>

        <section className="block" aria-labelledby="h-attest">
          <h2 id="h-attest">Attestation de revenus</h2>
          {!request ? (
            <p className="muted">
              Pas de demande en cours. Votre propriétaire (ou votre banque) crée une demande sur la{" "}
              <a href="/verifier">page de vérification</a> et vous envoie le lien : il s'ouvre ici.
            </p>
          ) : (
            <>
              <div className="request">
                <p>
                  <strong>On vous demande de prouver</strong> des salaires d'au moins{" "}
                  <strong>{usdc(usdcOf(BigInt(request.threshold)) / N)}/mois</strong> sur {N} mois
                  (au moins {usdc(usdcOf(BigInt(request.threshold)))} au total), versés par {deployment.employer.name}.
                </p>
                <p className="muted small">Le vérificateur saura seulement si c'est vrai. Ni vos montants, ni leur total.</p>
              </div>
              {wrongEmployer && <p className="error">Cette demande vise un autre employeur que le vôtre.</p>}
              {salaries && !enough && !wrongEmployer && <p className="error">Vos 3 derniers salaires n'atteignent pas ce seuil : aucune preuve possible.</p>}
              {phase.kind === "idle" || phase.kind === "error" ? (
                <button className="btn btn--primary" onClick={attest} disabled={!salaries || !enough || !!wrongEmployer}>Créer l'attestation</button>
              ) : null}
              {phase.kind === "error" && <p className="error">{phase.message}</p>}
              {phase.kind === "proving" && <Stages current={phase.stage} />}
              {phase.kind === "done" && (
                <div className="share">
                  <Stages current={null} />
                  <p>Preuve générée dans votre navigateur en {(phase.ms / 1000).toFixed(1)} s. Envoyez ce lien à votre vérificateur, ou montrez-lui le QR code :</p>
                  <div className="share__qr">
                    {phase.qr && <img src={phase.qr} alt="QR code de l'attestation" width={180} height={180} />}
                    <div className="share">
                      <div className="share__row">
                        <input readOnly value={phase.link} aria-label="Lien de l'attestation" onFocus={(e) => e.currentTarget.select()} />
                        <button className="btn" onClick={() => navigator.clipboard?.writeText(phase.link).then(() => setCopied(true))}>{copied ? "Copié" : "Copier"}</button>
                      </div>
                      <a className="muted small" href={phase.link} target="_blank" rel="noreferrer">Ouvrir l'attestation (vérifiable et imprimable) ↗</a>
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
