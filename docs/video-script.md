# Demo video script (≈ 3 min)

Narration in English; the UI is in French. Record on the dev server (`npm run dev`) so the Testnet switch
and the employee keys are available. Before recording: run `node scripts/testnet/fund.mjs` (the employer
needs 10 900 USDC per payroll), open three tabs (`/`, `/verifier`, stellar.expert), and clear the verifier's
local storage so the request you create on camera is the only one.

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Globe, Demo mode, slowly rotating | "Salaries are the most sensitive payments a company makes. Put payroll on a public blockchain and every salary becomes public. Payslip fixes that, and adds what's missing: a way to prove your income without revealing it." |
| 0:15 | Switch to **Testnet**. Three employees: Lisbon, São Paulo, Lagos | "This is Atlântica Labs, paying people on three continents in USDC on Stellar. Testnet, real transactions." |
| 0:22 | Click **Lancer la paie**. Camera follows each flow; the phase line reads "Preuve du virement…" | "The employer's browser deposits the payroll into a confidential balance, then for each employee generates a zero-knowledge proof (about two seconds) and submits a confidential transfer. This runs on OpenZeppelin's confidential token, and the proof is checked on-chain by the UltraHonk verifier." |
| 0:50 | All three **Reçu**. Click a row, open the tx link on stellar.expert | "On the explorer anyone sees Atlântica Labs paid Clara. The amount is a ciphertext." |
| 1:02 | Back, toggle **Vue auditeur** | "The employer is its own auditor: with its audit key it decrypts the payroll it just sent, read back from the chain." |
| 1:12 | `/verifier`: set 3 000, **Créer la demande**, copy link | "Now Clara wants to rent a flat. Her landlord asks for proof of at least 3 000 USDC a month. The request carries the landlord's key and a fresh nonce, so the answer is bound to him." |
| 1:28 | Open the link: `/salarie`, three salaries decrypted locally | "Clara opens it. Her browser reads her last three salaries from the chain and decrypts them with her key. Nothing leaves the device." |
| 1:40 | **Créer l'attestation**: the four steps tick, ~2 s | "She proves that her last three salaries from Atlântica Labs add up to at least 9 000, without revealing them or their total. This is our circuit, D-income. The SDK's disclosure circuits reveal the exact amount of one transfer; D-income proves a threshold over several, a disclosure type described in OpenZeppelin's specification and absent from the SDK and from the existing projects we reviewed." |
| 2:00 | Open the attestation link: green ✓ verdict | "The landlord opens the link. The page trusts nothing in it: it re-reads the three transfers on Stellar, checks that each is from Atlântica Labs to Clara, reads her public key on-chain, rebuilds every public input, and verifies the proof. Income of at least 3 000 a month. No amount anywhere." |
| 2:25 | Scroll "Ce qui a été vérifié" and the three ciphertext rows | "Even the landlord only ever sees ciphertexts." |
| 2:35 | Terminal: `node scripts/testnet/income.ts e03 3000`, the four rejections | "And what a verifier must refuse, it refuses: a proof replayed to someone else, a threshold above the real income, the same salary counted twice, a threshold raised after the fact." |
| 2:48 | README "Honest limits" | "Honest limits: the on-chain verifier doesn't yet enforce zero-knowledge upstream, and RPC keeps a week of events. Payslip: confidential payroll, and a payslip that proves without revealing." |

**Fallback.** If testnet is slow on the day, record the payroll separately and cut. Every hash shown
is also listed in `deployments/testnet.json`.
