# Verify the complete flow

## Reviewer concerns and where they are addressed

| Concern | Where |
|---|---|
| Each case is bound to both parties' agreed rules and an escrow identifier | `open_escrow` / `accept_terms` in `contracts/agent_court_adjudicator.py`: the case is keyed by `escrow_id`; the seller must submit the identical rules, amount and asset; `submit_deliverable` and `raise_dispute` take no rules, only the escrow id |
| Contract and settlement agree on outcomes | The contract stores `seller_percent` computed from validator-agreed per-rule results. For GEN the contract itself pays that split (`settle`, exact integer wei). For other assets `scripts/settle.ts` and `scripts/yellow_settlement.ts` read the stored record and apply exactly that percentage (`splitAmounts` in `scripts/lib/court.ts`) |
| The split is consensus-bound | Validators must agree on every rule's pass/fail (`prompt_comparative`); the percentage is arithmetic on that list |
| Corrected source is linked | `contracts/`, `scripts/`, `web/`, `tests/` in this repository |

## 1. Contract logic (no network)

```bash
python3 tests/test_adjudicator.py
```

Expect `20 checks passed`. It covers GEN locking (exact amount, buyer only), the on-chain 67/33 payout with no double payment, approval and refund payouts, cancel rules, and: escrow binding, seller must accept identical rules/amount/asset, role checks, one ruling per escrow, 2 of 3 rules met gives 67%, unreachable deliverable gives 0% with no LLM call, buyer approval gives 100%, unparseable validator output gives a refund.

## 2. Consensus on GenLayer Studio

1. Deploy `contracts/agent_court_adjudicator.py` (no constructor arguments) and set `ADJUDICATOR_ADDRESS`.
2. Run `npm run demo`. Four GenLayer transactions are sent: `open_escrow`, `accept_terms`, `submit_deliverable`, `raise_dispute`. The summary prints the contract address, the escrow id and every transaction hash.
3. Read the stored case yourself:

```bash
genlayer call $ADJUDICATOR_ADDRESS get_escrow --args <escrow id>
```

Check that `buyer`, `seller`, `rules`, `amount`, `asset` and `escrow_id` are what the demo printed, `state` is `RULED`, and `ruling.seller_percent == round(100 * rules_passed / rules_total)`.

## 2b. Paid in GEN

Set `BUYER_PK` to a key with GEN, then `npm run demo:gen`. It locks the amount, rules, and calls `settle`; it prints the payout read back from the contract and checks `seller + buyer = locked amount`. Verify yourself:

```bash
genlayer call $ADJUDICATOR_ADDRESS get_escrow --args <escrow id>
```

`state` is `SETTLED`, `funded_wei` is the locked amount, and `payout.seller_wei + payout.buyer_wei == funded_wei` with `seller_wei == funded_wei * seller_percent // 100`.

## 3. Settlement agrees with the ruling (other assets, through Yellow)

```bash
npm run settle -- --escrow <escrow id>
```

It prints the bound parties, each rule result, the percentage, and `seller + buyer = amount`. It refuses to run if the escrow is not `RULED`, or (live mode) if your wallet keys are not the recorded buyer and seller.

## 4. Web page

Open the live page, run a case, and compare the escrow id, rules and split it shows with `get_escrow`.

## Links (fill in before sending)

- Repository (this source): `<repo URL>`
- Contract on GenLayer Studio: `0x4153658F4d825bAd5a58B09CFAF6139eFe4090dF`
- Example escrow id and transaction hashes: `<from the npm run demo summary>`
- Live page: `<Vercel URL>`
