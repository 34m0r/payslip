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
  waiting: "Waiting",
  proving: "Proving",
  sending: "Sending",
  received: "Received",
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
        <div className="viewswitch" role="radiogroup" aria-label="View">
          <button role="radio" aria-checked={view === "public"} onClick={() => setView("public")}>Public view</button>
          <button role="radio" aria-checked={view === "auditor"} onClick={() => setView("auditor")}>Auditor view</button>
        </div>
        {testnetAvailable ? (
          <div className="viewswitch" role="radiogroup" aria-label="Data">
            <button role="radio" aria-checked={mode === "demo"} onClick={() => switchMode("demo")} disabled={running}>Demo</button>
            <button role="radio" aria-checked={mode === "testnet"} onClick={() => switchMode("testnet")} disabled={running}>Testnet</button>
          </div>
        ) : (
          <span className="demo" title="The transfers, proofs and hashes on this screen are simulated. Testnet mode uses OpenZeppelin's Confidential Token SDK.">
            Demo, simulated data
          </span>
        )}
      </Topbar>

      <main className="stage">
        <section className="stage__globe">
          <GlobeView employees={employees} transfers={transfers} focusId={focusId} selectedId={selectedId} onSelect={select} running={running} openFlights={mode === "testnet"} />

          <div className="overlay">
            {selected && selectedTransfer ? (
              <article className="card" aria-live="polite">
                <button className="card__close" onClick={() => setSelectedId(null)} aria-label="Close">×</button>
                <h2>{selected.name}</h2>
                <p className="muted">{selected.role}, {selected.city}</p>
                <dl>
                  <div><dt>Salary this month</dt><dd><Decrypt revealed={revealed} cipher={selectedTransfer.ciphertext} plain={usdc(selected.salary)} /></dd></div>
                  <div><dt>Status</dt><dd>{STATUS[selectedTransfer.status]}</dd></div>
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
                  ? `Amounts decrypted on this device with ${COMPANY.name}'s audit key.`
                  : "Everyone sees who pays whom. No one sees how much."}
              </p>
            )}
          </div>
        </section>

        <aside className="panel">
          <div className="panel__head">
            <h1>October 2026 payroll</h1>
            <p className="muted">{mode === "testnet"
              ? `${employees.length} employees paid for real on Stellar testnet, in USDC, from ${COMPANY.name}'s confidential treasury.`
              : `${employees.length} employees in ${HUBS.length} countries, paid in USDC from the Lisbon treasury.`}</p>
          </div>

          <div className="summary">
            <div>
              <span className="summary__label">Payroll total</span>
              <Decrypt revealed={revealed} cipher={ciphertextFor(`total:${runId}`)} plain={usdc(total)} />
            </div>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={employees.length} aria-valuenow={received} aria-label="Transfers received">
              <span style={{ transform: `scaleX(${received / employees.length})` }} />
            </div>
            <p className="muted small">{received} of {employees.length} transfers received</p>
          </div>

          <button className="btn btn--primary" onClick={run} disabled={running}>
            {running ? "Payroll running…" : done ? "Run payroll again" : "Run payroll"}
          </button>
          {phase && <p className="muted small" aria-live="polite">{phase}…</p>}
          {error && <p className="error small">{error}</p>}

          <div className="roster">
            {HUBS.filter((hub) => employees.some((e) => e.hub === hub.id)).map((hub) => (
              <section key={hub.id} className="roster__group" aria-labelledby={`hub-${hub.id}`}>
                <h3 id={`hub-${hub.id}`}>{hub.city}, {hub.country}{hub.isHQ ? <span className="tag">HQ</span> : null}</h3>
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
