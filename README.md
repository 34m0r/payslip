# Payslip

> Confidential payroll on Stellar, and a payslip that proves your income without revealing it.

**HackMeridian 2026 · Genesis · Stellar Composed.** Built on the OpenZeppelin Confidential Token
(stellar-contracts v0.8.0), the Confidential Token SDK (noir_js + bb.js), the Nethermind UltraHonk
Soroban verifier and Circle's testnet USDC. Everything below runs on **Stellar testnet**.

1. **The employer pays.** Atlântica Labs pays its employees in USDC through a confidential token. On the
   ledger anyone sees who pays whom, never how much. The employer, as auditor, can decrypt its payroll.
2. **The employee proves.** In their browser, an employee proves *"my last 3 salaries from Atlântica Labs
   add up to at least X"*, from the real on-chain events, without revealing any amount or the total.
3. **The verifier checks.** A landlord opens a link. The page re-reads the transfers on-chain, rebuilds
   every public input itself, verifies the proof, and shows ✓, with no amount anywhere.

## What is new here

Confidential payroll on Stellar already exists: credit to [Lucent](https://github.com/ToluLabs/Lucent) and
to the SDK's payroll walkthrough. Payslip's contribution is **D-income**, an aggregate-threshold
selective-disclosure circuit.

The disclosure circuits of the Confidential Token SDK (`disclose_recipient` / `disclose_sender`) reveal the
**exact** amount of **one** transfer. D-income proves a **threshold** over **several** transfers: the "finite set
of events + threshold" disclosure type described in OpenZeppelin's
[selective-disclosure specification](https://docs.openzeppelin.com/stellar-contracts/tokens/confidential/selective-disclosure),
and absent from the Confidential Token SDK and from the existing projects we reviewed (including Lucent).

## Live on testnet

Deployed by `scripts/testnet/deploy.mjs`. All ids and hashes are in [`deployments/testnet.json`](deployments/testnet.json).

| | |
|---|---|
| Confidential token (compliant, allowlist) | [`CBUHR3NB…RMT2I`](https://stellar.expert/explorer/testnet/contract/CBUHR3NBYP4NONOFGQ5BYIRSS7GWRIDGWNO4DYK32GJPWAN6TK4RMT2I) |
| Underlying asset: Circle testnet USDC (SAC) | [`CBIELTK6…DAMA`](https://stellar.expert/explorer/testnet/contract/CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) |
| UltraHonk verifier registry (6 circuit VKs) | [`CA2QVJTD…2X2H`](https://stellar.expert/explorer/testnet/contract/CA2QVJTD3SC5JEKK7EFGP4RTX7AFL77B2TQPY44HF3QUZEXSWKHJ2X2H) |
| Auditor registry (auditor 0 = the employer) | [`CCNRBMHN…RPR4S`](https://stellar.expert/explorer/testnet/contract/CCNRBMHND4ZLECGR4ZXBFV2JAYRGI5XM7I4GFSWO4X2SU7DJIM7RPR4S) |
| Factory · allowlist policy | [`CBGBFZ4X…C6VF`](https://stellar.expert/explorer/testnet/contract/CBGBFZ4XRV2YB4UQXJYZRM4INDSZGZKW2V3FJEDVKPRPNBUSAEHEC6VF) · [`CBOQKD5V…HWU7`](https://stellar.expert/explorer/testnet/contract/CBOQKD5VAL3HGYGHNMITQVSX6EBNU5R2D3FAOYCWTOZS7B4Q6EYEHWU7) |
| Employer, Atlântica Labs | [`GAPAKH3V…76MA`](https://stellar.expert/explorer/testnet/account/GAPAKH3VJTAMXZRZ66MHOZGZSTYPNDTIWEZI2EX6TC5YQARQMLIS76MA) |

First payroll: three `confidential_transfer` calls, each with an UltraHonk proof verified on-chain. Open any
of them: sender and recipient are visible, the amount is a ciphertext.

- Clara Duarte (Lisbon): [`c73e5b25…`](https://stellar.expert/explorer/testnet/tx/c73e5b253d3607fd9f26c7dbcee32b45aba39f0aa6f6df2432dbdc8e0596edbf)
- Rafael Oliveira (São Paulo): [`1ea93231…`](https://stellar.expert/explorer/testnet/tx/1ea93231ea1cc1b24ee09fe514661775afe8fa0fdd3056f4139437f436a0f60b)
- Adaeze Okafor (Lagos): [`787541ec…`](https://stellar.expert/explorer/testnet/tx/787541ec67f95d787de195ada485f950bcc7fca7844df5754e44f0a15e4677d0)

Each employee has since received three monthly salaries (payrolls 2 and 3 are in `deployments/testnet.json`).
These are the events D-income proofs are built from.

## The app

```bash
npm install
npm run dev        # http://localhost:5174, opens Brave (override: BROWSER="Google Chrome" npm run dev)
```

| Page | What it does |
|---|---|
| `/` **Employer** | The payroll globe. **Demo** mode runs a simulated 14-person payroll. **Testnet** mode (dev server only) pays the 3 testnet employees for real: the browser deposits the period's USDC, then proves and submits each `confidential_transfer` (~2 s per proof, ~40 s per payroll). A transfer is marked received only once its on-chain event decrypts to the salary under the employer's audit key. *Vue publique* shows the real ciphertexts; *Vue auditeur* shows the amounts. |
| `/salarie` **Employee** | Reads the employee's salary events from Soroban RPC and decrypts them on the device. It opens a verifier's request link, generates the D-income proof in the browser (noir_js + bb.js, ~2 s), and returns a share link. |
| `/verifier` **Verifier** | Creates a request (minimum monthly income), then verifies the attestation that answers it. |

### Cash-out to a bank account (SEP-10 + SEP-24)

On `/salarie`, **Retirer vers ma banque** withdraws part of the employee's salary through a SEP-24 anchor
(dev server only, it signs with the employee's testnet key). The anchor's window opens first. Only once the employee
confirms the amount there does the browser make the confidential `withdraw` of exactly that amount to their public
USDC (a proof verified on-chain), pay the anchor with its memo, and follow the withdrawal to `completed`. A
cash-out resumes after a reload and never pays the anchor twice: the payment's hash is recorded before it is sent.

The anchor is Payslip's own testnet anchor, served by the app on its own domain: `/.well-known/stellar.toml`,
`/auth` (SEP-10) and `/sep24/*` (SEP-24 withdraw for testnet USDC), by `api/anchor.js` on Vercel and by the dev
server locally (`server/anchor-core.js`, one handler for both). It keeps no state of its own: the confirmed amount
is a `manageData` entry on the anchor's account, the memo is derived from the withdrawal id, and the status is read
from Horizon on each request. The SDF test anchor caps withdrawals at 10 USDC; ours has no cap beyond the employee's
balance, and its **bank payout is simulated**. The client (`web/src/anchor/anchor.ts`) works with any SEP-24 anchor.

On Vercel the anchor needs three environment variables: `ANCHOR_SIGNING_SECRET`, `ANCHOR_DISTRIBUTION_SECRET` and
`ANCHOR_JWT_SECRET` (testnet keys, created in `.secrets/anchor.secret.json`).

```bash
node scripts/testnet/cashout.mjs e03 1500       # the same cash-out from Node, through the dev server's anchor
```

## D-income: circuit and protocol

**Circuit**, in `circuits/disclose_income`. It is built on `stellar_confidential_lib` (stellar-contracts
v0.8.0), with the same primitives as the audited circuits: contract-bound viewing key, and ECDH decryption of each
event's encrypted amount.
- Constraints: correct decryption of N = 3 events (I1–I6), events pairwise distinct (I7),
  `sum − threshold ∈ [0, 2^130)` (I8–I9), and verifier binding to `(P_R, ν)` (I10).
- 9 tests (plus a fixture printer), including adversarial ones: inflated salary, same event counted twice,
  wrong key, wrong nonce, negative-threshold wrap-around. **6 597 gates.**
- Public inputs: `addr_f, PVK, R_e[3], σ[3], ṽ[3], threshold, P_R, ν`. Private: `sk, v[3]`.

**Protocol**, in `web/src/income/dincome.ts`. One module serves both the Node scripts and the browser. It is
modelled on the SDK's D-recipient receiver protocol.
1. The verifier issues a request `(P_R, ν, threshold, employer)` and keeps it locally.
2. The employee finds their last 3 transfers from the employer, decrypts them, and proves in the ZK flavour
   (keccak transcript, `keccakZK`). The bundle carries only `(holder, 3 event references, proof)`.
3. The verifier takes **no public input from the bundle**. It resolves each event reference on-chain and checks
   that each one is a Transfer from the employer to the holder and that all three are distinct. It reads the holder's PVK
   from their on-chain account, recomputes `addr_f`, takes `(P_R, ν, threshold)` from its own request, pins the
   verification key (`web/src/income/disclose_income.vk.json`), then verifies with bb.js.

`node scripts/testnet/income.ts e03 3000` runs the whole flow in Node against the live events. It then checks
the rejections a verifier must make: a replay to another verifier, a threshold above the real income, the same
transfer counted twice, and a threshold raised after the fact.

## Reproduce

Toolchain (pinned by the confidential stack, and the on-chain verifier reads only this format): nargo
`1.0.0-beta.11`, bb / bb.js `0.87.0`, `stellar` CLI.

```bash
./scripts/prove-income.sh                       # circuit tests → compile → ZK proof → verify (bb CLI)
node scripts/income-artifacts.mjs               # pin the compiled circuit + VK used by prover and verifier

npm run testnet:deploy                          # deploy the suite over testnet USDC, onboard 4 accounts (resumable)
npm run testnet:payroll -- "Paie 1"             # one real payroll: deposit, merge, 3 confidential transfers, audit
node scripts/testnet/cashout.mjs e03 1500       # cash-out through Payslip's testnet anchor (needs npm run dev)
node scripts/testnet/fund.mjs                   # top up the employer's USDC (friendbot XLM → testnet DEX)
node scripts/testnet/income.ts e03 3000         # D-income end to end on testnet, plus the rejection cases
```

`contracts/wasm/` holds the five `examples/confidential` contracts built from stellar-contracts v0.8.0
(sha256 in `deployments/testnet.json`). Keys live in `.secrets/` (gitignored).

## Honest limits

- **On-chain amount privacy is not yet guaranteed by the library.** OpenZeppelin's on-chain verifier
  currently accepts non-ZK UltraHonk proofs; zero-knowledge on-chain verification is in progress upstream.
  Our income proof is verified off-chain, in the ZK flavour.
- **The deposit is public.** Funding the confidential treasury from public USDC reveals the payroll's total for
  that period. A treasury already holding confidential funds would not.
- **The verifier binding is per browser.** A request lives in the verifier's local storage. An attestation
  opened elsewhere still verifies, but the page warns that it was made for another request.
- **Withdrawing to public USDC reveals the withdrawn amount.** A confidential off-ramp, where the anchor holds a
  confidential account and receives a confidential_transfer, is on our roadmap. Our testnet anchor simulates the
  bank payout.
- **Retention.** Soroban RPC keeps about 7 days of events, so the demo's "months" are short periods.
  Production needs an indexer, which the SDK supports.
- **Demo keys.** The dev server hands the testnet demo keys to the browser so that one machine can play
  employer and employees. Production builds embed none. A real deployment would derive each `sk` from the
  holder's wallet signature (SDK §5).
- N = 3 is fixed by the circuit, and the threshold applies to the sum of the 3 salaries. Testnet only. The SDK is unaudited.
