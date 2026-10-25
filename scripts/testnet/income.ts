// D-income end to end on testnet, in Node: a landlord issues a request, the employee proves
// "my last 3 salaries from Atlântica Labs sum to at least the threshold" from the REAL
// on-chain events, and the landlord verifies it against chain state. Then the attacks a
// verifier must catch: a threshold above the real income, a replayed request, a forged event.
//
//   node scripts/testnet/income.ts [employeeId] [monthly threshold in USDC]     e.g. e03 3000
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { addressToField, deriveKeys, proverFromArtifact } from "stellar-confidential-token-sdk";
import { N, findSalaryEvents, newIncomeRequest, proveIncome, verifyIncome, type IncomeBundle } from "../../web/src/income/dincome.ts";
import { ROOT, chainClient, fromUnits, loadDeployment, loadSecrets, toUnits, txLink } from "./lib.mjs";

const [id = "e03", monthly = "3000"] = process.argv.slice(2);
const d = loadDeployment();
const secrets = loadSecrets();
const employee = d.employees.find((e: { id: string }) => e.id === id);
if (!employee) throw new Error(`unknown employee ${id}`);

const client = chainClient({ token: d.contracts.token, verifier: d.contracts.verifier, auditor: d.contracts.auditor });
const artifact = JSON.parse(readFileSync(join(ROOT, "web/src/income/disclose_income.json"), "utf8"));
const pinnedVk = Buffer.from(JSON.parse(readFileSync(join(ROOT, "web/src/income/disclose_income.vk.json"), "utf8")).vkBase64, "base64");
const prover = proverFromArtifact(artifact, { zk: true });

// Landlord: "show me at least `monthly` USDC a month over 3 months, paid by Atlântica Labs".
const threshold = toUnits(Number(monthly) * N);
const { request } = newIncomeRequest({ threshold, employer: d.employer.address, token: d.contracts.token });
console.log(`demande : au moins ${monthly} USDC/mois sur ${N} mois, versés par ${d.employer.name}`);

// Employee: find and decrypt their salaries, prove.
const keys = deriveKeys(BigInt(secrets.employees[id].sk), addressToField(d.contracts.token));
Keypair.fromSecret(secrets.employees[id].secret); // the account key stays unused: proving needs only sk
const events = await findSalaryEvents(client, { employer: d.employer.address, holder: employee.address, fromLedger: d.fromLedger });
const t0 = Date.now();
const { bundle, salaries } = await proveIncome({ keys, holder: employee.address, events, request, prover, onStage: (s) => console.log(`  · ${s}`) });
console.log(`${employee.name} : salaires déchiffrés localement ${salaries.map(fromUnits).join(" + ")} USDC`);
console.log(`preuve ZK en ${((Date.now() - t0) / 1000).toFixed(1)} s, ${bundle.proof.length / 2 - 1} octets`);
events.forEach((ev) => console.log(`  ${txLink(ev.txHash)}`));

// Landlord: verify against chain state, with their own request record.
const verified = await verifyIncome({ client, bundle, request, prover, pinnedVk });
verified.steps.forEach((s) => console.log(`  ✓ ${s}`));
console.log(`✅ revenus d'au moins ${monthly} USDC/mois sur ${N} mois, versés par ${d.employer.name}\n`);

// What a verifier must reject.
async function expectReject(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`  ✗ ${name}: ACCEPTED`);
    process.exitCode = 1;
  } catch (e) {
    console.log(`  ✓ rejeté, ${name} : ${(e as Error).message.split("\n")[0]}`);
  }
}
const other = newIncomeRequest({ threshold, employer: d.employer.address, token: d.contracts.token }).request;
await expectReject("attestation rejouée vers un autre vérificateur", () => verifyIncome({ client, bundle, request: other, prover, pinnedVk }));
const greedy = newIncomeRequest({ threshold: toUnits(fromUnits(salaries.reduce((s, v) => s + v, 0n)) + 1), employer: d.employer.address, token: d.contracts.token }).request;
await expectReject("seuil supérieur au revenu réel", () => proveIncome({ keys, holder: employee.address, events, request: greedy, prover }));
const forged: IncomeBundle = { ...bundle, refs: [bundle.refs[0], bundle.refs[0], bundle.refs[2]] };
await expectReject("même virement compté deux fois", () => verifyIncome({ client, bundle: forged, request, prover, pinnedVk }));
const raised: IncomeBundle = { ...bundle, request: { ...request, threshold: (threshold * 2n).toString() } };
await expectReject("seuil gonflé après coup", () => verifyIncome({ client, bundle: raised, request: raised.request, prover, pinnedVk }));

await prover.destroy();
process.exit(process.exitCode ?? 0);
