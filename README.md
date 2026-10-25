# Payslip

> Confidential payroll on Stellar — and a payslip that proves your income without revealing it.

**HackMeridian 2026 · Genesis · Stellar Composed** — OpenZeppelin Confidential Token (v0.8.0)
+ Confidential Token SDK (bb.js / noir_js) + Nethermind UltraHonk verifier (+ Stellar anchor, stretch).

## What is new here
Confidential payroll already exists on Stellar (prior art: Lucent, and the SDK's payroll walkthrough).
Payslip's contribution is **D-income**, an aggregate-threshold selective-disclosure circuit:

> "The last N salary transfers I received from employer E sum to **at least X**" —
> proven to one verifier, revealing no individual amount and not the total.

Existing disclosure circuits (SDK `disclose_recipient`) reveal the *exact* amount of *one* transfer.
D-income implements the "finite set of events + threshold" disclosure type described in
OpenZeppelin's selective-disclosure specification.

## Run the app (opens in Brave)

```bash
npm install
npm run dev        # http://localhost:5174, opens Brave (override: BROWSER="Google Chrome" npm run dev)
```

**Employer view: the payroll globe.** Subsidiaries and employees on a 3D globe; "Lancer la paie" sends one
confidential transfer per employee, and each payment travels from the Lisbon treasury as a flow on the globe,
with the camera following the money.
- **Vue publique** (default): what anyone reading the ledger sees. Who pays whom is public, every amount is
  ciphertext.
- **Vue auditeur**: amounts decrypted on this device with the employer's audit key.

The current screen runs on a **demo engine** (simulated transfers, proofs and hashes, labelled in the UI).
`web/src/payroll.ts` defines the `PayrollEngine` interface the testnet engine (OpenZeppelin Confidential Token
SDK) implements, so the UI does not change when it is wired in.

## Circuit — `circuits/disclose_income`
- Built on `stellar_confidential_lib` (OpenZeppelin stellar-contracts v0.8.0), same primitives as the
  audited circuits: contract-bound viewing key, ECDH decryption of each event's encrypted amount.
- Constraints: correct decryption of N=3 events (I1–I6), events pairwise distinct (I7),
  `sum − threshold ∈ [0, 2^130)` (I8–I9), verifier binding (P_R, nu) (I10).
- 9 tests incl. adversarial: inflated salary, same event counted twice, wrong key, wrong nonce,
  negative-threshold wrap-around. **6 597 gates.**
- Verified off-chain with bb.js in the ZK flavour (keccak transcript, `--zk`), like the SDK's disclosures.
  The verifier sources every public input from the on-chain events (Soroban RPC), and checks off-chain
  that each event is a Transfer from the employer to the holder.

```bash
./scripts/prove-income.sh    # tests → compile → real ZK proof → verify
```

## Honest limits
- OpenZeppelin's on-chain verifier currently accepts non-ZK UltraHonk proofs, so the library does not yet
  guarantee on-chain amount privacy (zero-knowledge verification in progress). Our off-chain income
  proof uses the ZK flavour.
- Soroban RPC keeps ~7 days of events: the demo uses short pay periods; production needs an indexer.
- Testnet only.
