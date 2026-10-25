// Pins the D-income artifacts shared by the prover (employee) and the verifier: the compiled
// circuit and its verification key. The verifier re-derives the VK from the circuit it loads
// and refuses any result unless it matches the pinned one byte for byte.
//
//   (cd circuits/disclose_income && nargo compile) && node scripts/income-artifacts.mjs
import { createHash } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { proverFromArtifact } from "stellar-confidential-token-sdk";
import { ROOT } from "./testnet/lib.mjs";

const src = join(ROOT, "circuits/disclose_income/target/disclose_income.json");
const out = join(ROOT, "web/src/income");
copyFileSync(src, join(out, "disclose_income.json"));

const prover = proverFromArtifact(JSON.parse(readFileSync(src, "utf8")), { zk: true });
const vk = await prover.verificationKey();
await prover.destroy();
const sha256 = createHash("sha256").update(vk).digest("hex");
writeFileSync(
  join(out, "disclose_income.vk.json"),
  JSON.stringify({ circuit: "disclose_income", zk: true, oracleHash: "keccak", nargo: "1.0.0-beta.11", bbJs: "0.87.0", sha256, vkBase64: Buffer.from(vk).toString("base64") }, null, 2) + "\n",
);
console.log(`pinned disclose_income VK (${vk.length} B, sha256 ${sha256.slice(0, 16)}…)`);
process.exit(0);
