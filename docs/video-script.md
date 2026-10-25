# Demo video script (≈ 3 min)

Narration in English; the UI is in French. Record on the public site, https://payslip-five-theta.vercel.app, in a
fresh Brave window. Before recording: open the verifier page once (the first proof downloads the proving
parameters, so it is slower), and check that no payroll ran in the last 3 minutes (the public demo allows one
every 3 minutes). Keep stellar.expert open in a second tab.

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Globe, Demo mode, slowly rotating | "Salaries are the most sensitive payments a company makes. Put payroll on a public blockchain and every salary becomes public. Payslip fixes that, and adds what's missing: a way to prove your income without revealing it." |
| 0:15 | Switch to **Testnet**: Lisbon, São Paulo, Lagos | "This is Atlântica Labs, paying people on three continents in USDC on Stellar. Testnet, real transactions, from the public site." |
| 0:22 | **Lancer la paie**; the camera follows each flow, the phase line reads "Preuve du virement…" | "For each employee, a zero-knowledge proof is generated and a confidential transfer submitted: OpenZeppelin's confidential token, with every proof checked on-chain by the UltraHonk verifier." |
| 0:50 | All three **Reçu**; click a row, open its stellar.expert link | "On the explorer anyone sees Atlântica Labs paid Clara. The amount is a ciphertext." |
| 1:00 | Toggle **Vue auditeur** | "The employer is its own auditor: its audit key decrypts the payroll, read back from the chain." |
| 1:08 | `/verifier`: 3 000, **Créer la demande**, open the link | "Now Clara wants to rent a flat. Her landlord asks for proof of at least 3 000 USDC a month. His request carries his key and a fresh nonce, so the answer is bound to him." |
| 1:20 | `/salarie`: three salaries with their dates, decrypted locally | "Clara opens it. Her browser reads her last three salaries from the chain and decrypts them with her key." |
| 1:30 | **Créer l'attestation**: the four steps tick; the QR code appears | "She proves her last three salaries from Atlântica Labs add up to at least 9 000, revealing neither the amounts nor their total. This is our circuit, D-income. The SDK's disclosure circuits reveal the exact amount of one transfer; D-income proves a threshold over several." |
| 1:52 | Open the attestation: green ✓, then scroll to the certificate | "The landlord scans the QR code. The page trusts nothing in the link: it re-reads the three transfers on Stellar, checks they go from Atlântica Labs to Clara, rebuilds every public input, and verifies the proof. Income of at least 3 000 a month. No amount anywhere." |
| 2:12 | **Imprimer l'attestation**: the certificate | "And a certificate for the rental file, with a QR code anyone can scan to re-verify it against the chain." |
| 2:22 | Back on `/salarie`: **Retirer vers ma banque**, 20 USDC, tick the warning; the anchor's window quotes it in euros | "Finally, getting paid has to end in a bank account, in your own currency. Clara keeps her salary in USDC and cashes out what she needs through Payslip's own SEP-24 anchor, which quotes it in euros. The app warns her: the amount she withdraws becomes public; her salary stays private while it stays in Payslip." |
| 2:40 | The steps reach the bank transfer; the receipt shows USDC → € | "A confidential withdraw with its proof, a payment to the anchor, and the bank transfer in euros, simulated on testnet at a demo rate. In São Paulo it would be reais, in Lagos nairas." |
| 2:50 | README, "Honest limits" | "Honest limits: zero-knowledge on-chain verification is still in progress upstream, and RPC keeps a week of events. Payslip: confidential payroll, and a payslip that proves without revealing." |

**Fallback.** If testnet is slow on the day, record the payroll and the cash-out separately and cut. If the
payroll shows "réessayez dans … min", someone just ran one: wait, or record the proof part first.
