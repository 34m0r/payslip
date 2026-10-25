/**
 * D-income: the off-chain protocol around circuits/disclose_income, modelled on the SDK's
 * D-recipient receiver protocol (src/disclosure/verify.ts).
 *
 *   verifier → holder   IncomeRequest  (P_R, ν, threshold, employer): binds the proof to this verifier
 *   holder   → verifier IncomeBundle   (holder, N event references, proof): nothing else
 *
 * Trust boundary: the verifier takes NO public input from the bundle. Every event field and
 * the holder's PVK are resolved on-chain, addr_f is recomputed from the token address, and
 * (P_R, ν, threshold, employer) come from the verifier's own request record.
 *
 * Shared by the Node scripts and the browser: no Node or DOM APIs here.
 */
import {
  DOMAIN,
  H,
  addressToField,
  bytesToHex,
  decryptWithDomain,
  ecdh,
  eventRef,
  fetchEvents,
  fromHex,
  hexToBytes,
  pointCoords,
  randomScalar,
  resolveEventRef,
  scalarMul,
  toHex32,
  type ChainClient,
  type CircuitProver,
  type ConfidentialEvent,
  type EventRef,
  type KeyPair,
  type TransferEvent,
} from "stellar-confidential-token-sdk";

export const INCOME_CIRCUIT_ID = "disclose_income";
/** Salary events per proof; fixed by the circuit (`global N`). */
export const N = 3;

export interface JsonPoint { x: string; y: string }

export interface IncomeRequest {
  /** Verifier's public key `P_R = r_R·H`. */
  pR: JsonPoint;
  /** Fresh per-request nonce. */
  nu: string;
  /** Claimed minimum of the N salaries' SUM, in token base units (decimal string). */
  threshold: string;
  /** Employer account the salaries must come from. */
  employer: string;
  /** Confidential token contract. */
  token: string;
}

export interface IncomeBundle {
  circuitId: typeof INCOME_CIRCUIT_ID;
  request: IncomeRequest;
  /** The holder's account: every event must pay it. */
  holder: string;
  refs: EventRef[];
  /** UltraHonk ZK proof, hex. */
  proof: string;
}

/** Verifier side: a fresh request. Keep `rR` (or at least the request) locally. */
export function newIncomeRequest(p: { threshold: bigint; employer: string; token: string }): { request: IncomeRequest; rR: bigint } {
  const rR = randomScalar();
  const pR = pointCoords(scalarMul(rR, H));
  let nu = 0n;
  while (nu === 0n) nu = randomScalar();
  return {
    rR,
    request: { pR: { x: toHex32(pR.x), y: toHex32(pR.y) }, nu: toHex32(nu), threshold: p.threshold.toString(), employer: p.employer, token: p.token },
  };
}

const isSalary = (ev: ConfidentialEvent, employer: string, holder: string): ev is TransferEvent =>
  ev.type === "transfer" && ev.from === employer && ev.to === holder;

/** Holder side: the holder's last N salary transfers from `employer`, oldest first. */
export async function findSalaryEvents(client: ChainClient, p: { employer: string; holder: string; fromLedger: number }): Promise<TransferEvent[]> {
  const { events } = await fetchEvents(client, { startLedger: p.fromLedger });
  const salaries = events.filter((ev) => isSalary(ev, p.employer, p.holder));
  return salaries.slice(-N);
}

/** Holder side: decrypt one salary with the holder's viewing key. */
export function decryptSalary(keys: KeyPair, ev: TransferEvent): bigint {
  return decryptWithDomain(ev.vTilde, DOMAIN.TRANSFER_AMOUNT, ecdh(keys.vk, ev.rE), ev.sigma);
}

/** Public inputs in the circuit's exact order (circuits/disclose_income/src/main.nr). */
function publicInputs(p: { addrF: bigint; pvk: { x: bigint; y: bigint }; events: TransferEvent[]; request: IncomeRequest }) {
  const rE = p.events.map((ev) => pointCoords(ev.rE));
  return {
    addr_f: toHex32(p.addrF),
    pvk_x: toHex32(p.pvk.x),
    pvk_y: toHex32(p.pvk.y),
    r_e_x: rE.map((r) => toHex32(r.x)),
    r_e_y: rE.map((r) => toHex32(r.y)),
    sigma: p.events.map((ev) => toHex32(ev.sigma)),
    v_tilde: p.events.map((ev) => toHex32(ev.vTilde)),
    threshold: toHex32(BigInt(p.request.threshold)),
    p_r_x: toHex32(fromHex(p.request.pR.x)),
    p_r_y: toHex32(fromHex(p.request.pR.y)),
    nu: toHex32(fromHex(p.request.nu)),
  };
}
const flatten = (pi: ReturnType<typeof publicInputs>): string[] =>
  [pi.addr_f, pi.pvk_x, pi.pvk_y, ...pi.r_e_x, ...pi.r_e_y, ...pi.sigma, ...pi.v_tilde, pi.threshold, pi.p_r_x, pi.p_r_y, pi.nu];

export type ProveStage = "decrypt" | "witness" | "prove" | "self-check";

/** Holder side: build the witness from real events and prove (ZK flavour). */
export async function proveIncome(p: {
  keys: KeyPair;
  holder: string;
  events: TransferEvent[];
  request: IncomeRequest;
  prover: CircuitProver;
  onStage?: (s: ProveStage) => void;
}): Promise<{ bundle: IncomeBundle; salaries: bigint[] }> {
  const { keys, events, request, prover } = p;
  if (!prover.zk) throw new Error("income proofs are ZK-flavour: construct the prover with { zk: true }");
  if (events.length !== N) throw new Error(`need exactly ${N} salary events, found ${events.length}`);
  if (addressToField(request.token) !== keys.addrF) throw new Error("keys are bound to another token contract");

  p.onStage?.("decrypt");
  const salaries = events.map((ev) => decryptSalary(keys, ev));
  const total = salaries.reduce((s, v) => s + v, 0n);
  if (total < BigInt(request.threshold)) throw new Error("these salaries sum below the requested threshold");

  p.onStage?.("witness");
  const pvk = pointCoords(keys.PVK);
  const inputs = { sk: toHex32(keys.sk), v: salaries.map(toHex32), ...publicInputs({ addrF: keys.addrF, pvk, events, request }) };

  p.onStage?.("prove");
  // noir_js takes arrays for array parameters; the SDK's NoirInputs type only models scalars.
  const result = await prover.prove(inputs as unknown as Parameters<CircuitProver["prove"]>[0]);

  p.onStage?.("self-check");
  if (!(await prover.verify(result))) throw new Error("the proof does not verify locally");

  return {
    salaries,
    bundle: { circuitId: INCOME_CIRCUIT_ID, request, holder: p.holder, refs: events.map(eventRef), proof: bytesToHex(result.proof) },
  };
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

export type VerifyStage = "request" | "vk-pinning" | "resolve-event" | "check-event" | "resolve-account" | "verify-proof";

export class IncomeVerifyError extends Error {
  readonly stage: VerifyStage;
  constructor(stage: VerifyStage, message: string) {
    super(message);
    this.stage = stage;
    this.name = "IncomeVerifyError";
  }
}

export interface VerifiedIncome {
  threshold: bigint;
  employer: string;
  holder: string;
  events: TransferEvent[];
  steps: string[];
}

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const sameRequest = (a: IncomeRequest, b: IncomeRequest) =>
  a.pR.x === b.pR.x && a.pR.y === b.pR.y && a.nu === b.nu && a.threshold === b.threshold && a.employer === b.employer && a.token === b.token;

export async function verifyIncome(p: {
  client: ChainClient;
  bundle: IncomeBundle;
  /** The verifier's OWN request record, never the bundle's copy. */
  request: IncomeRequest;
  prover: CircuitProver;
  /** Pinned VK bytes for disclose_income. */
  pinnedVk: Uint8Array;
}): Promise<VerifiedIncome> {
  const { client, bundle, request, prover, pinnedVk } = p;
  const steps: string[] = [];

  if (bundle.circuitId !== INCOME_CIRCUIT_ID) throw new IncomeVerifyError("request", `unknown circuit "${bundle.circuitId}"`);
  if (!sameRequest(bundle.request, request)) throw new IncomeVerifyError("request", "this attestation answers another request");
  if (request.token !== client.cfg.contracts.token) throw new IncomeVerifyError("request", "request names another token contract");
  steps.push("L'attestation répond à votre demande (clé P_R, nonce ν, seuil, employeur)");

  if (!prover.zk) throw new IncomeVerifyError("vk-pinning", "income proofs are ZK-flavour");
  const vk = await prover.verificationKey();
  if (vk.length !== pinnedVk.length || !vk.every((b, i) => b === pinnedVk[i])) {
    throw new IncomeVerifyError("vk-pinning", "le circuit chargé ne correspond pas à la clé de vérification épinglée");
  }
  steps.push(`Circuit D-income épinglé (clé de vérification de ${vk.length} octets)`);

  if (bundle.refs.length !== N) throw new IncomeVerifyError("resolve-event", `${N} virements attendus, ${bundle.refs.length} reçus`);
  const events: TransferEvent[] = [];
  for (const ref of bundle.refs) {
    const ev = await resolveEventRef(client, ref).catch(() => null);
    if (!ev) {
      throw new IncomeVerifyError("resolve-event", `virement introuvable on-chain (ledger ${ref.ledger}) : mauvaise référence, ou plus vieux que la rétention RPC (~7 jours)`);
    }
    if (!isSalary(ev, request.employer, bundle.holder)) {
      throw new IncomeVerifyError("check-event", `l'événement du ledger ${ref.ledger} n'est pas un virement de ${short(request.employer)} vers ${short(bundle.holder)}`);
    }
    events.push(ev);
  }
  if (new Set(events.map((ev) => ev.cursor)).size !== N) throw new IncomeVerifyError("check-event", "le même virement est compté deux fois");
  steps.push(`${N} virements confidentiels distincts relus on-chain, tous de l'employeur vers le salarié`);

  const account = await client.confidentialBalance(bundle.holder);
  if (!account) throw new IncomeVerifyError("resolve-account", "le salarié n'a pas de compte confidentiel");
  steps.push("Clé de lecture publique (PVK) du salarié relue on-chain");

  const addrF = addressToField(client.cfg.contracts.token);
  const inputs = flatten(publicInputs({ addrF, pvk: pointCoords(account.viewingPublicKey), events, request }));
  const ok = await prover.verify({ proof: hexToBytes(bundle.proof), publicInputs: inputs }).catch(() => false);
  if (!ok) throw new IncomeVerifyError("verify-proof", "la preuve ne vérifie pas contre les données on-chain");
  steps.push("Preuve UltraHonk (ZK) vérifiée contre les entrées publiques reconstruites depuis la chaîne");

  return { threshold: BigInt(request.threshold), employer: request.employer, holder: bundle.holder, events, steps };
}

// Links carry JSON as base64url in the URL fragment, which never reaches a server.
export function encodeLink(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function decodeLink<T>(s: string): T {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
}
