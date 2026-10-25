// Tops up the employer's public USDC (friendbot XLM → testnet DEX), so the globe's testnet
// mode can run payrolls from the browser. Each payroll deposits the period's total.
//
//   node scripts/testnet/fund.mjs [target USDC]     default: 5 payrolls
import { Keypair } from "@stellar/stellar-sdk";
import { ensureUsdc, loadDeployment, loadSecrets } from "./lib.mjs";

const d = loadDeployment();
const perRun = d.employees.reduce((s, e) => s + e.salary, 0);
const target = Number(process.argv[2] ?? perRun * 5);
const have = await ensureUsdc(Keypair.fromSecret(loadSecrets().employer.secret), target);
console.log(`trésorerie : ${have.toFixed(2)} USDC (${Math.floor(have / perRun)} paies)`);
process.exit(0);
