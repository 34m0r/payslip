// Shared testnet plumbing for the Payslip scripts: network constants, the public
// deployment file (deployments/testnet.json, committed) and the secrets file
// (.secrets/testnet.secret.json, gitignored), accounts, and the SDK client.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import { ChainClient, keypairSigner } from "stellar-confidential-token-sdk";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT = "https://friendbot.stellar.org";
export const PASSPHRASE = Networks.TESTNET;

// Circle's testnet USDC and its Stellar Asset Contract.
export const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
export const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
export const USDC_DECIMALS = 7n;
export const toUnits = (usdc) => BigInt(Math.round(usdc * 100)) * 10n ** (USDC_DECIMALS - 2n);
export const fromUnits = (units) => Number(units) / 10 ** Number(USDC_DECIMALS);

export const EXPERT = "https://stellar.expert/explorer/testnet";
export const txLink = (hash) => `${EXPERT}/tx/${hash}`;

// The three demo employees paid on testnet: ids, names and salaries from web/src/data.ts.
export const TESTNET_EMPLOYEES = [
  { id: "e03", name: "Clara Duarte", city: "Lisbonne", salary: 3300 },
  { id: "e04", name: "Rafael Oliveira", city: "São Paulo", salary: 3900 },
  { id: "e07", name: "Adaeze Okafor", city: "Lagos", salary: 3700 },
];

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const DEPLOYMENT_PATH = join(ROOT, "deployments/testnet.json");
export const SECRETS_PATH = join(ROOT, ".secrets/testnet.secret.json");
export const STATE_PATH = join(ROOT, ".secrets/testnet.state.json");

const bigintJson = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
}
function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, bigintJson, 2) + "\n");
}

export const loadDeployment = () => readJson(DEPLOYMENT_PATH, { network: "testnet", steps: {} });
export const saveDeployment = (d) => writeJson(DEPLOYMENT_PATH, d);
export const loadSecrets = () => readJson(SECRETS_PATH, {});
export const saveSecrets = (s) => writeJson(SECRETS_PATH, s);

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export const server = new rpc.Server(RPC_URL);
export const horizon = new Horizon.Server(HORIZON_URL);

export function chainClient(contracts) {
  return new ChainClient({ rpcUrl: RPC_URL, networkPassphrase: PASSPHRASE, contracts });
}
export const signerOf = (kp) => keypairSigner(kp.secret(), PASSPHRASE);

/** Retry `fn` on transient network failures (testnet RPC and friendbot are flaky). */
export async function retry(label, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts) throw e;
      console.warn(`  ↻ ${label}: ${String(e?.message ?? e).split("\n")[0]} (retry ${i})`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

export async function friendbot(kp) {
  await retry(`friendbot ${kp.publicKey().slice(0, 6)}`, async () => {
    const r = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
    if (!r.ok && !(await r.text()).includes("createAccountAlreadyExist")) throw new Error(`friendbot ${r.status}`);
  });
}

/** Submit classic operations through Horizon (trustlines, swaps, merges). */
export async function submitClassic(kp, ops) {
  const account = await horizon.loadAccount(kp.publicKey());
  const builder = new TransactionBuilder(account, { fee: String(Number(BASE_FEE) * 10), networkPassphrase: PASSPHRASE });
  ops.forEach((op) => builder.addOperation(op));
  const tx = builder.setTimeout(180).build();
  tx.sign(kp);
  try {
    return await horizon.submitTransaction(tx);
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    throw new Error(`classic tx failed: ${JSON.stringify(codes ?? e?.message)}`);
  }
}

/** Submit one non-invoke Soroban operation (wasm upload, contract create). */
export async function submitSoroban(kp, op) {
  const source = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(op)
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`send rejected: ${JSON.stringify(sent.errorResult)}`);
  const res = await server.pollTransaction(sent.hash, { attempts: 90 });
  if (res.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ${res.status}`);
  return { hash: sent.hash, returnValue: res.returnValue };
}

export async function usdcBalance(publicKey) {
  const account = await horizon.loadAccount(publicKey);
  const line = account.balances.find((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer);
  return line ? Number(line.balance) : 0;
}

/**
 * Bring `kp`'s USDC balance to at least `target`: fund helper accounts with friendbot,
 * merge their XLM into `kp`, and swap XLM for USDC on the testnet DEX.
 */
export async function ensureUsdc(kp, target) {
  const account = await horizon.loadAccount(kp.publicKey());
  if (!account.balances.some((b) => b.asset_code === USDC.code && b.asset_issuer === USDC.issuer)) {
    await submitClassic(kp, [Operation.changeTrust({ asset: USDC })]);
  }
  for (;;) {
    const have = await usdcBalance(kp.publicKey());
    if (have >= target) return have;
    const xlm = Number((await horizon.loadAccount(kp.publicKey())).balances.find((b) => b.asset_type === "native").balance);
    const spendable = Math.floor(xlm - 200); // keep fees and reserves
    if (spendable < 1000) {
      const helper = Keypair.random();
      await friendbot(helper);
      await submitClassic(helper, [Operation.accountMerge({ destination: kp.publicKey() })]);
      console.log(`  + 10 000 XLM from a friendbot helper`);
      continue;
    }
    const sendAmount = String(Math.min(spendable, 9000));
    const paths = await horizon.strictSendPaths(Asset.native(), sendAmount, [USDC]).call();
    const best = paths.records[0];
    if (!best) throw new Error("no XLM→USDC path on the testnet DEX");
    const destMin = (Number(best.destination_amount) * 0.98).toFixed(7);
    await submitClassic(kp, [
      Operation.pathPaymentStrictSend({
        sendAsset: Asset.native(),
        sendAmount,
        destination: kp.publicKey(),
        destAsset: USDC,
        destMin,
        path: best.path.map((p) => (p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer))),
      }),
    ]);
    console.log(`  swapped ${sendAmount} XLM → ~${Number(best.destination_amount).toFixed(2)} USDC`);
  }
}

export const hex = (n) => "0x" + n.toString(16);
export const big = (s) => BigInt(s);
