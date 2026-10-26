# Demo video script (3:00, plus a 1:30 cut)

Narration and UI in English. Record on the public site, https://payslip-five-theta.vercel.app. Story: pay → prove →
check → cash out. The one idea the jury must leave with: on Stellar, a company can pay salaries privately, and an
employee can prove "I earn at least X" to anyone, verified against the chain, without revealing a single amount.

**Before you record**
- Fresh Brave window, 1920×1080, zoom 110 %, bookmarks and extensions hidden. Tabs: `/`, stellar.expert (testnet), `/verifier`.
- Warm up the prover with one full proof: the first one downloads the proving parameters (~8 s), then ~2–4 s.
- No payroll in the last 3 minutes (the public demo allows one every 3 min).
- Record the narration separately, and each scene as its own clip. A payroll takes ~40 s and a cash-out ~30 s:
  keep the first transfer in real time, then speed up 3–4× or cut to the result. Never fake a step.

## Full cut

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Globe in Demo mode, rotating; title card "Payslip" | "Salaries are the most sensitive payments a company makes. Put payroll on a public blockchain, and every salary becomes public. Payslip fixes that, and adds what was missing: a way to prove your income without revealing it." |
| 0:14 | **Testnet**; **Run payroll**; the camera follows each flow ("Proving the transfer to…") | "This is a company paying people on three continents, in USDC, on Stellar testnet. Real transactions, from the public site. For each employee, a zero-knowledge proof is generated and a confidential transfer is submitted, using OpenZeppelin's confidential token, with every proof checked on-chain by the UltraHonk verifier." |
| 0:42 | All three **Received**; Clara's transaction on stellar.expert | "On the explorer, anyone can see the company paid Clara. Nobody can see how much." |
| 0:52 | **Auditor view** | "The employer is its own auditor: with its audit key, it decrypts its payroll straight from the chain. Private to the world, accountable to the company." |
| 1:04 | `/verifier`: 3000, **Create the request**, open the link | "Now Clara wants to rent a flat. Her landlord asks for proof of at least three thousand a month. His request carries his key and a fresh nonce, so the answer will be bound to him and to this request." |
| 1:18 | `/employee`: three dated salaries; **Create the attestation**; the QR code | "Clara's browser reads her last three salaries from the chain and decrypts them with her key. Then it proves that they add up to at least nine thousand, revealing neither the amounts nor their total. This is our circuit, D-income. The SDK's disclosure circuits reveal the exact amount of one transfer; D-income proves a threshold over several." |
| 1:48 | The attestation: green ✓, "What was verified", the encrypted transfers | "The landlord scans the code. His page trusts nothing in it: it re-reads the three transfers on Stellar, checks that each one goes from the employer to Clara, rebuilds every public input, and verifies the proof. Income of at least three thousand a month. No amount, anywhere." |
| 2:12 | The certificate; **Print the attestation** | "And for the rental file, a certificate, with a QR code anyone can scan to re-verify it against the chain." |
| 2:22 | **Cash out to my bank**, 20 USDC, the warning, the anchor quotes euros; the receipt | "Getting paid has to end in a bank account, in your own currency. Clara keeps her salary in USDC and cashes out only what she needs, through Payslip's own SEP-24 anchor, which quotes it in euros. The app is honest with her: the amount she withdraws becomes public; her salary stays private while it stays in Payslip." |
| 2:44 | "Stellar Composed" slide, README "Honest limits", closing card | "Six pieces of the Stellar ecosystem, one product, live on testnet. On-chain zero-knowledge verification is still in progress upstream, and we say so in the README. Payslip: get paid on-chain, prove what you earn, reveal nothing else." |

## Short cut (1:30)

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Globe | "Put payroll on a public blockchain and every salary becomes public. Payslip pays salaries privately on Stellar, and lets employees prove their income without revealing it." |
| 0:12 | Run payroll (sped up), explorer | "Three real confidential transfers: each proof checked on-chain. Anyone sees who was paid, nobody sees how much." |
| 0:30 | Request → proof → QR | "A landlord asks for at least three thousand a month. Clara's browser proves her last three salaries reach it, without revealing them. That is our circuit, D-income." |
| 0:55 | Green ✓, certificate | "The landlord's page re-reads everything from the chain and verifies the proof: a yes, a printable certificate, no amount anywhere." |
| 1:12 | Cash out in euros | "And Clara cashes out only what she needs, in her own currency, through our SEP-24 anchor." |
| 1:22 | Closing card | "Payslip: get paid on-chain, prove what you earn, reveal nothing else. Live on testnet." |

**If something goes wrong.** "Try again in … min": a visitor just ran a payroll; record the proof scenes first.
A slow first proof: warm up the prover. A blocked popup when cashing out: allow pop-ups for the site in Brave.
