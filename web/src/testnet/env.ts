/** Browser side of the testnet deployment: chain client, bb.js loader, the pinned D-income prover. */
import { ChainClient, proverFromArtifact, setUltraHonkBackendLoader, type CircuitProver } from "stellar-confidential-token-sdk";
import { deployment, demoKeys } from "virtual:payslip-testnet";
import artifact from "../income/disclose_income.json";
import vkPin from "../income/disclose_income.vk.json";

export { deployment, demoKeys };

export interface TestnetCapabilities { payroll: boolean; cashout: boolean; cashoutMax: number; cooldown: number }
let caps: Promise<TestnetCapabilities | null> | null = null;
/** What the server can run (payroll, cash-out): null when its testnet keys are not configured. */
export function testnetCapabilities(): Promise<TestnetCapabilities | null> {
  caps ??= fetch("/api/testnet").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return caps;
}
export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
export const EXPERT = "https://stellar.expert/explorer/testnet";
export const txLink = (hash: string) => `${EXPERT}/tx/${hash}`;
export const accountLink = (a: string) => `${EXPERT}/account/${a}`;

export const USDC_UNIT = 10_000_000n;
export const usdcOf = (units: bigint) => Number(units) / Number(USDC_UNIT);
export const unitsOf = (usdc: number) => BigInt(Math.round(usdc * 100)) * (USDC_UNIT / 100n);

// bb.js is served intact under /bb (see vite.config.ts) and imported as native ESM at runtime.
setUltraHonkBackendLoader(async () => {
  const url = `${location.origin}/bb/index.js`;
  return (await import(/* @vite-ignore */ url)).UltraHonkBackend;
});

export function chainClient(): ChainClient {
  if (!deployment) throw new Error("no testnet deployment: run scripts/testnet/deploy.mjs");
  const { token, verifier, auditor } = deployment.contracts;
  return new ChainClient({ rpcUrl: RPC_URL, networkPassphrase: NETWORK_PASSPHRASE, contracts: { token, verifier, auditor } });
}

let prover: CircuitProver | null = null;
/** One ZK prover per page: its backend loads the wasm and the CRS once. */
export function incomeProver(): CircuitProver {
  prover ??= proverFromArtifact(artifact as unknown as { bytecode: string }, { zk: true });
  return prover;
}
export const pinnedVk = (): Uint8Array => Uint8Array.from(atob(vkPin.vkBase64), (c) => c.charCodeAt(0));

/** The period label of a payroll transfer, from deployments/testnet.json. */
export function periodOf(txHash: string): string | null {
  return deployment?.payrolls?.find((p) => p.transfers.some((t) => t.tx === txHash))?.period ?? null;
}
