import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobeView } from "./GlobeView";
import { Decrypt } from "./Decrypt";
import { COMPANY, EMPLOYEES, HUBS, hubOf, usdc } from "./data";
import { DemoPayrollEngine, ciphertextFor, initialTransfers, type Transfer, type TransferStatus } from "./payroll";

type View = "public" | "auditor";

const STATUS: Record<TransferStatus, string> = {
  waiting: "En attente",
  proving: "Preuve en cours",
  sending: "En route",
  received: "Reçu",
};

export function App() {
  const [view, setView] = useState<View>("public");
  const [runId, setRunId] = useState(1);
  const [transfers, setTransfers] = useState<Transfer[]>(() => initialTransfers(1));
  const [running, setRunning] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  const revealed = view === "auditor";
  const received = transfers.filter((t) => t.status === "received").length;
  const done = received === EMPLOYEES.length;
  const total = useMemo(() => EMPLOYEES.reduce((s, e) => s + e.salary, 0), []);

  const run = useCallback(async () => {
    const id = done ? runId + 1 : runId;
    if (done) setRunId(id);
    setTransfers(initialTransfers(id));
    setSelectedId(null);
    setRunning(true);
    signal.current = { cancelled: false };
    const engine = new DemoPayrollEngine(id);
    await engine.run((t) => {
      setTransfers((prev) => prev.map((p) => (p.employeeId === t.employeeId ? t : p)));
      if (t.status === "sending") setFocusId(t.employeeId);
    }, signal.current);
    setRunning(false);
    setFocusId(null);
  }, [done, runId]);

  useEffect(() => () => { signal.current.cancelled = true; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelectedId(null); if (!running) setFocusId(null); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [running]);

  const select = (id: string) => { setSelectedId(id); if (!running) setFocusId(id); };
  const selected = EMPLOYEES.find((e) => e.id === selectedId);
  const selectedTransfer = transfers.find((t) => t.employeeId === selectedId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Payslip</span>
          <span className="brand__company">{COMPANY.name}</span>
        </div>
        <div className="viewswitch" role="radiogroup" aria-label="Point de vue">
          <button role="radio" aria-checked={view === "public"} onClick={() => setView("public")}>Vue publique</button>
          <button role="radio" aria-checked={view === "auditor"} onClick={() => setView("auditor")}>Vue auditeur</button>
        </div>
        <span className="demo" title="Les virements, preuves et hashes de cet écran sont simulés. Le mode testnet utilise le SDK Confidential Token d'OpenZeppelin.">
          Démo, données simulées
        </span>
      </header>

      <main className="stage">
        <section className="stage__globe">
          <GlobeView transfers={transfers} focusId={focusId} selectedId={selectedId} onSelect={select} running={running} />

          <div className="overlay">
            {selected && selectedTransfer ? (
              <article className="card" aria-live="polite">
                <button className="card__close" onClick={() => setSelectedId(null)} aria-label="Fermer la fiche">×</button>
                <h2>{selected.name}</h2>
                <p className="muted">{selected.role}, {selected.city}</p>
                <dl>
                  <div><dt>Salaire du mois</dt><dd><Decrypt revealed={revealed} cipher={selectedTransfer.ciphertext} plain={usdc(selected.salary)} /></dd></div>
                  <div><dt>Statut</dt><dd>{STATUS[selectedTransfer.status]}</dd></div>
                  {selectedTransfer.hash && <div><dt>Transaction</dt><dd className="hash">{selectedTransfer.hash.slice(0, 10)}…{selectedTransfer.hash.slice(-6)}</dd></div>}
                </dl>
              </article>
            ) : (
              <p className="caption">
                {revealed
                  ? `Montants déchiffrés sur cet appareil avec la clé d'audit d'${COMPANY.name}.`
                  : "Tout le monde voit qui paie qui. Personne ne voit combien."}
              </p>
            )}
          </div>
        </section>

        <aside className="panel">
          <div className="panel__head">
            <h1>Paie d'octobre 2026</h1>
            <p className="muted">{EMPLOYEES.length} salariés dans {HUBS.length} pays, payés en USDC depuis la trésorerie de Lisbonne.</p>
          </div>

          <div className="summary">
            <div>
              <span className="summary__label">Total de la paie</span>
              <Decrypt revealed={revealed} cipher={ciphertextFor(`total:${runId}`)} plain={usdc(total)} />
            </div>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={EMPLOYEES.length} aria-valuenow={received} aria-label="Virements reçus">
              <span style={{ transform: `scaleX(${received / EMPLOYEES.length})` }} />
            </div>
            <p className="muted small">{received} virement{received > 1 ? "s" : ""} reçu{received > 1 ? "s" : ""} sur {EMPLOYEES.length}</p>
          </div>

          <button className="btn btn--primary" onClick={run} disabled={running}>
            {running ? "Paie en cours…" : done ? "Relancer la paie" : "Lancer la paie"}
          </button>

          <div className="roster">
            {HUBS.map((hub) => (
              <section key={hub.id} className="roster__group" aria-labelledby={`hub-${hub.id}`}>
                <h3 id={`hub-${hub.id}`}>{hub.city}, {hub.country}{hub.isHQ ? <span className="tag">Siège</span> : null}</h3>
                <ul>
                  {EMPLOYEES.filter((e) => e.hub === hub.id).map((e, i) => {
                    const t = transfers.find((x) => x.employeeId === e.id)!;
                    return (
                      <li key={e.id}>
                        <button className={`row is-${t.status}${selectedId === e.id ? " is-selected" : ""}`} onClick={() => select(e.id)}>
                          <span className="row__who">
                            <strong>{e.name}</strong>
                            <span>{e.role}{e.city !== hubOf(e.hub).city ? `, ${e.city}` : ""}</span>
                          </span>
                          <span className="row__amount"><Decrypt revealed={revealed} cipher={t.ciphertext} plain={usdc(e.salary)} delay={i * 40} /></span>
                          <span className="row__status"><span className="dot" aria-hidden="true" />{STATUS[t.status]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </aside>
      </main>
    </div>
  );
}
