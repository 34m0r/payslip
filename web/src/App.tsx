import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobeView } from "./GlobeView";
import { Decrypt } from "./Decrypt";
import { Topbar } from "./Topbar";
import { COMPANY, EMPLOYEES, HUBS, hubOf, usdc } from "./data";
import { DemoPayrollEngine, ciphertextFor, initialTransfers, type PayrollEngine, type Transfer, type TransferStatus } from "./payroll";
import { deployment } from "virtual:payslip-testnet";
import { testnetCapabilities } from "./testnet/env";

type Mode = "demo" | "testnet";
const TESTNET_IDS = new Set(deployment?.employees.map((e) => e.id) ?? []);
const rosterFor = (mode: Mode) => (mode === "testnet" ? EMPLOYEES.filter((e) => TESTNET_IDS.has(e.id)) : EMPLOYEES);

type View = "public" | "auditor";

const STATUS: Record<TransferStatus, string> = {
  waiting: "En attente",
  proving: "Preuve en cours",
  sending: "En route",
  received: "Reçu",
};

export function App() {
  const [view, setView] = useState<View>("public");
  const [mode, setMode] = useState<Mode>("demo");
  // Testnet mode is offered when the server can sign payrolls (its keys are configured).
  const [testnetAvailable, setTestnetAvailable] = useState(false);
  useEffect(() => { if (deployment) testnetCapabilities().then((c) => setTestnetAvailable(!!c?.payroll)); }, []);
  const employees = useMemo(() => rosterFor(mode), [mode]);
  const [runId, setRunId] = useState(1);
  const [transfers, setTransfers] = useState<Transfer[]>(() => initialTransfers(1));
  const [phase, setPhase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const signal = useRef({ cancelled: false });

  const revealed = view === "auditor";
  const received = transfers.filter((t) => t.status === "received").length;
  const done = received === employees.length;
  const total = useMemo(() => employees.reduce((s, e) => s + e.salary, 0), [employees]);

  const switchMode = (m: Mode) => {
    if (running || m === mode) return;
    setMode(m);
    setTransfers(initialTransfers(runId, rosterFor(m)));
    setSelectedId(null);
    setFocusId(null);
    setError(null);
  };

  const run = useCallback(async () => {
    const id = done ? runId + 1 : runId;
    if (done) setRunId(id);
    setTransfers(initialTransfers(id, employees));
    setSelectedId(null);
    setError(null);
    setRunning(true);
    signal.current = { cancelled: false };
    try {
      const engine: PayrollEngine = mode === "testnet"
        ? new (await import("./testnet/engine")).TestnetPayrollEngine()
        : new DemoPayrollEngine(id, employees);
      await engine.run((t) => {
        setTransfers((prev) => prev.map((p) => (p.employeeId === t.employeeId ? t : p)));
        if (t.status === "sending") setFocusId(t.employeeId);
      }, signal.current, setPhase);
    } catch (e) {
      setError(String((e as Error)?.message ?? e).split("\n")[0]);
    }
    setPhase("");
    setRunning(false);
    setFocusId(null);
  }, [done, runId, mode, employees]);

  useEffect(() => () => { signal.current.cancelled = true; }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setSelectedId(null); if (!running) setFocusId(null); } };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [running]);

  const select = (id: string) => { setSelectedId(id); if (!running) setFocusId(id); };
  const selected = employees.find((e) => e.id === selectedId);
  const selectedTransfer = transfers.find((t) => t.employeeId === selectedId);

  return (
    <div className="app">
      <Topbar current="employer">
        <div className="viewswitch" role="radiogroup" aria-label="Point de vue">
          <button role="radio" aria-checked={view === "public"} onClick={() => setView("public")}>Vue publique</button>
          <button role="radio" aria-checked={view === "auditor"} onClick={() => setView("auditor")}>Vue auditeur</button>
        </div>
        {testnetAvailable ? (
          <div className="viewswitch" role="radiogroup" aria-label="Données">
            <button role="radio" aria-checked={mode === "demo"} onClick={() => switchMode("demo")} disabled={running}>Démo</button>
            <button role="radio" aria-checked={mode === "testnet"} onClick={() => switchMode("testnet")} disabled={running}>Testnet</button>
          </div>
        ) : (
          <span className="demo" title="Les virements, preuves et hashes de cet écran sont simulés. Le mode testnet utilise le SDK Confidential Token d'OpenZeppelin.">
            Démo, données simulées
          </span>
        )}
      </Topbar>

      <main className="stage">
        <section className="stage__globe">
          <GlobeView employees={employees} transfers={transfers} focusId={focusId} selectedId={selectedId} onSelect={select} running={running} openFlights={mode === "testnet"} />

          <div className="overlay">
            {selected && selectedTransfer ? (
              <article className="card" aria-live="polite">
                <button className="card__close" onClick={() => setSelectedId(null)} aria-label="Fermer la fiche">×</button>
                <h2>{selected.name}</h2>
                <p className="muted">{selected.role}, {selected.city}</p>
                <dl>
                  <div><dt>Salaire du mois</dt><dd><Decrypt revealed={revealed} cipher={selectedTransfer.ciphertext} plain={usdc(selected.salary)} /></dd></div>
                  <div><dt>Statut</dt><dd>{STATUS[selectedTransfer.status]}</dd></div>
                  {selectedTransfer.hash && (
                    <div><dt>Transaction</dt><dd className="hash">{mode === "testnet"
                      ? <a href={`https://stellar.expert/explorer/testnet/tx/${selectedTransfer.hash}`} target="_blank" rel="noreferrer">{selectedTransfer.hash.slice(0, 10)}…{selectedTransfer.hash.slice(-6)} ↗</a>
                      : <>{selectedTransfer.hash.slice(0, 10)}…{selectedTransfer.hash.slice(-6)}</>}</dd></div>
                  )}
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
            <p className="muted">{mode === "testnet"
              ? `${employees.length} salariés payés en vrai sur Stellar testnet, en USDC, depuis la trésorerie confidentielle d'${COMPANY.name}.`
              : `${employees.length} salariés dans ${HUBS.length} pays, payés en USDC depuis la trésorerie de Lisbonne.`}</p>
          </div>

          <div className="summary">
            <div>
              <span className="summary__label">Total de la paie</span>
              <Decrypt revealed={revealed} cipher={ciphertextFor(`total:${runId}`)} plain={usdc(total)} />
            </div>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={employees.length} aria-valuenow={received} aria-label="Virements reçus">
              <span style={{ transform: `scaleX(${received / employees.length})` }} />
            </div>
            <p className="muted small">{received} virement{received > 1 ? "s" : ""} reçu{received > 1 ? "s" : ""} sur {employees.length}</p>
          </div>

          <button className="btn btn--primary" onClick={run} disabled={running}>
            {running ? "Paie en cours…" : done ? "Relancer la paie" : "Lancer la paie"}
          </button>
          {phase && <p className="muted small" aria-live="polite">{phase}…</p>}
          {error && <p className="error small">{error}</p>}

          <div className="roster">
            {HUBS.filter((hub) => employees.some((e) => e.hub === hub.id)).map((hub) => (
              <section key={hub.id} className="roster__group" aria-labelledby={`hub-${hub.id}`}>
                <h3 id={`hub-${hub.id}`}>{hub.city}, {hub.country}{hub.isHQ ? <span className="tag">Siège</span> : null}</h3>
                <ul>
                  {employees.filter((e) => e.hub === hub.id).map((e, i) => {
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
