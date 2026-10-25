#!/usr/bin/env bash
# Real UltraHonk ZK proof for the D-income circuit, same flavour as the SDK's
# off-chain disclosures (keccak transcript, --zk). Needs nargo 1.0.0-beta.11 + bb 0.87.0:
#   curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash && noirup -v 1.0.0-beta.11
#   curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash && bbup -v 0.87.0
#   brew install jq   (bb needs it)
set -euo pipefail
cd "$(dirname "$0")/../circuits/disclose_income"
echo "== tests";   nargo test
echo "== compile"; nargo compile && nargo execute
echo "== gates";   bb gates -b target/disclose_income.json | grep -E "circuit_size"
echo "== vk";      bb write_vk -b target/disclose_income.json -o target --oracle_hash keccak
start=$(date +%s)
echo "== prove";   bb prove -b target/disclose_income.json -w target/disclose_income.gz -o target --oracle_hash keccak --zk
echo "   proving time: $(( $(date +%s) - start ))s"
echo "== verify";  bb verify -k target/vk -p target/proof -i target/public_inputs --oracle_hash keccak --zk && echo "✅ income >= threshold proven, no amount revealed"
