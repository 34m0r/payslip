// Deploys the OpenZeppelin confidential suite (stellar-contracts v0.8.0, examples/confidential)
// on testnet over Circle's testnet USDC, and onboards Atlântica Labs and three employees:
//   verifier + auditor registries + factory → allowlist + compliant token (underlying: USDC SAC)
//   → register the 6 circuit VKs → the employer's audit key as auditor 0
//   → allowlist employer and employees → register their confidential accounts.
// Resumable: every finished step is recorded in deployments/testnet.json and skipped on rerun.
//
//   node scripts/testnet/deploy.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Address, Keypair, Operation, xdr } from "@stellar/stellar-sdk";
import {
  CIRCUIT_TYPE,
  CircuitProver,
  H,
  addressToField,
  allowUser,
  buildRegisterWitness,
  deployAllowlistAndToken,
  deriveKeys,
  isAllowed,
  pointToBytes,
  randomScalar,
  scalarMul,
  submitRegister,
} from "stellar-confidential-token-sdk";
import { loadCircuit } from "stellar-confidential-token-sdk/proving/artifacts";
import {
  ROOT,
  TESTNET_EMPLOYEES,
  USDC_SAC,
  big,
  chainClient,
  friendbot,
  hex,
  loadDeployment,
  loadSecrets,
  retry,
  saveDeployment,
  saveSecrets,
  signerOf,
  submitSoroban,
  txLink,
} from "./lib.mjs";

const SDK_DIR = join(ROOT, "node_modules/stellar-confidential-token-sdk");
const WASM_DIR = join(ROOT, "contracts/wasm");
const wasm = (name) => readFileSync(join(WASM_DIR, `confidential_${name}_example.wasm`));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const addr = (a) => new Address(a).toScVal();

const d = loadDeployment();
const secrets = loadSecrets();

/** Run a step once; its return value is stored under `d.steps[name]`. */
async function step(name, fn) {
  if (d.steps[name]) return d.steps[name];
  console.log(`• ${name}`);
  const out = await fn();
  d.steps[name] = out ?? true;
  saveDeployment(d);
  return d.steps[name];
}

// ---------------------------------------------------------------------------
// Accounts and keys
// ---------------------------------------------------------------------------

await step("accounts", async () => {
  const mk = () => ({ secret: Keypair.random().secret(), sk: hex(randomScalar()) });
  secrets.employer = secrets.employer ?? { ...mk(), auditorSecret: hex(randomScalar()) };
  secrets.employees = secrets.employees ?? Object.fromEntries(TESTNET_EMPLOYEES.map((e) => [e.id, mk()]));
  saveSecrets(secrets);
  const all = [secrets.employer, ...Object.values(secrets.employees)].map((a) => Keypair.fromSecret(a.secret));
  for (const kp of all) await friendbot(kp);
  return {
    employer: all[0].publicKey(),
    employees: Object.fromEntries(TESTNET_EMPLOYEES.map((e) => [e.id, Keypair.fromSecret(secrets.employees[e.id].secret).publicKey()])),
  };
});

const employerKp = Keypair.fromSecret(secrets.employer.secret);
const EMPLOYER = employerKp.publicKey();
const employerSigner = signerOf(employerKp);
d.employer = { name: "Atlântica Labs", address: EMPLOYER };
d.employees = TESTNET_EMPLOYEES.map((e) => ({ ...e, address: d.steps.accounts.employees[e.id] }));

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

d.wasm = Object.fromEntries(
  ["verifier", "auditor", "factory", "compliant_token", "allowlist_policy"].map((n) => [n, sha256(wasm(n))]),
);

async function uploadAndCreate(name, ctorArgs) {
  const { returnValue } = await retry(`upload ${name}`, () =>
    submitSoroban(employerKp, Operation.uploadContractWasm({ wasm: wasm(name) })),
  );
  const hash = returnValue.bytes();
  const created = await retry(`create ${name}`, () =>
    submitSoroban(
      employerKp,
      Operation.createCustomContract({
        address: new Address(EMPLOYER),
        wasmHash: hash,
        constructorArgs: ctorArgs,
        salt: Buffer.from(Keypair.random().rawPublicKey()),
      }),
    ),
  );
  return Address.fromScVal(created.returnValue).toString();
}

const verifier = await step("verifier", () => uploadAndCreate("verifier", [addr(EMPLOYER), addr(EMPLOYER)]));
const auditor = await step("auditor", () => uploadAndCreate("auditor", [addr(EMPLOYER), addr(EMPLOYER)]));
const factory = await step("factory", async () => {
  const upload = async (n) =>
    (await retry(`upload ${n}`, () => submitSoroban(employerKp, Operation.uploadContractWasm({ wasm: wasm(n) })))).returnValue.bytes();
  return uploadAndCreate("factory", [xdr.ScVal.scvBytes(await upload("compliant_token")), xdr.ScVal.scvBytes(await upload("allowlist_policy"))]);
});

const client = chainClient({ token: "", verifier, auditor });
const fromLedger = await step("fromLedger", () => client.latestLedger());

const { policy, token } = await step("token", () =>
  deployAllowlistAndToken(
    client,
    employerSigner,
    { factory, underlying: USDC_SAC, verifier, auditor },
    { policyAdmin: EMPLOYER, policyManager: EMPLOYER, tokenAdmin: EMPLOYER, sacPassthrough: false },
  ),
);
client.cfg.contracts.token = token;
d.contracts = { verifier, auditor, factory, policy, token, underlying: USDC_SAC };
d.fromLedger = fromLedger;
saveDeployment(d);

await step("vks", async () => {
  const hashes = {};
  for (const [name, type] of [
    ["register", CIRCUIT_TYPE.Register],
    ["withdraw", CIRCUIT_TYPE.Withdraw],
    ["transfer", CIRCUIT_TYPE.Transfer],
    ["spender_transfer", CIRCUIT_TYPE.SpenderTransfer],
    ["set_spender", CIRCUIT_TYPE.SetSpender],
    ["clawback", CIRCUIT_TYPE.Clawback],
  ]) {
    const vk = readFileSync(join(SDK_DIR, `circuits/vks/${name}.vk.bin`));
    const r = await retry(`vk ${name}`, () =>
      client.invoke(verifier, "register_verification_key", [xdr.ScVal.scvU32(type), xdr.ScVal.scvBytes(vk), addr(EMPLOYER)], employerSigner),
    );
    hashes[name] = r.hash;
  }
  return hashes;
});

// The employer is the auditor of its own payroll: auditor id 0 is its key.
await step("auditorKey", async () => {
  const kAud = scalarMul(big(secrets.employer.auditorSecret), H);
  const r = await client.invoke(
    auditor,
    "register_key",
    [xdr.ScVal.scvU32(0), xdr.ScVal.scvBytes(Buffer.from(pointToBytes(kAud))), addr(EMPLOYER)],
    employerSigner,
  );
  return { auditorId: 0, tx: r.hash };
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

const people = [
  { id: "employer", address: EMPLOYER, secret: secrets.employer },
  ...TESTNET_EMPLOYEES.map((e) => ({ id: e.id, address: d.steps.accounts.employees[e.id], secret: secrets.employees[e.id] })),
];

await step("allowlist", async () => {
  const out = {};
  for (const p of people) {
    if (await isAllowed(client, policy, p.address)) continue;
    out[p.id] = (await retry(`allow ${p.id}`, () => allowUser(client, employerSigner, policy, p.address, EMPLOYER))).hash;
  }
  return out;
});

await step("register", async () => {
  const prover = new CircuitProver(loadCircuit("register"));
  const addrF = addressToField(token);
  const out = {};
  for (const p of people) {
    if (await client.isRegistered(p.address)) continue;
    const kp = Keypair.fromSecret(p.secret.secret);
    const w = buildRegisterWitness(deriveKeys(big(p.secret.sk), addrF), p.address);
    const { proof } = await prover.prove(w.inputs);
    out[p.id] = (await retry(`register ${p.id}`, () => submitRegister(client, signerOf(kp), p.address, 0, w, proof))).hash;
    console.log(`  registered ${p.id}: ${txLink(out[p.id])}`);
  }
  return out;
});

saveDeployment(d);
console.log(`\nDeployed. Token ${token}\n  ${"https://stellar.expert/explorer/testnet/contract/" + token}`);
process.exit(0);
