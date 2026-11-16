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

## Example run on GenLayer Studio (paid in GEN)

A complete case run through the live page, with a split result.

- Contract: `0xa4CA829658fdF8Ece71d760d0E918bd649A48dae`
- Escrow id: `demo-9df87bd7`
- Buyer: `0xC10c1DE780F2f9553a35019de2439b2d937ec2Be`
- Seller: `0x712E5228A0814DD1351ea44825e3d6893BbE43d5`
- Deliverable: `https://raw.githubusercontent.com/Perorworld/agent-court/main/demo/deliverable.md`
- Agreed rules (both parties accepted these 3 exactly), amount 10 GEN:
  1. The page names the project 'Agent Court Demo'. (met)
  2. The page lists at least three working features. (met)
  3. The page says it accepts payment in Bitcoin. (not met: the page mentions GEN, not Bitcoin)
- Ruling: 2 of 3 rules met, so `seller_percent = round(100 × 2 / 3) = 67`.
- Paid by the contract: seller 6.7 GEN, buyer 3.3 GEN (together 10 GEN, the locked amount).

| Step | Transaction hash |
|---|---|
| `open_escrow` (buyer) | `0x2ab747d61f5ba2c857ef6aab956e3b0b6639a60727168a1262998b2ae1ba86d1` |
| `accept_terms` (seller) | `0xdd0aeb46909956ae37cd62a45fad4f5884712700678cf2fc781815cf1118671b` |
| `fund_escrow` (buyer, 10 GEN) | `0xfa270edc71b98fffb1c45cc2cf57e19d3e823a1f9faac5ca9ab0de24e13e03be` |
| `submit_deliverable` (seller) | `0xbd3ea4ec13f27f0495cbf0efee072744e51494be54ff6b494ffb76b8ab9cdf09` |
| `raise_dispute` (buyer) | `0xb98f30fbcce557918efa31c4be8e82e9cccea58d1a30ec381c1fc5bb38f3241f` |
| `settle` (buyer) | `0xdc1fe99f2bfbfd8828cb46cc860922ee985bcfacd4f5ff1dd796c3ec8f03da1f` |

Read the stored case yourself:

```bash
genlayer call 0xa4CA829658fdF8Ece71d760d0E918bd649A48dae get_escrow --args demo-9df87bd7
```

Expect `state: SETTLED`, `funded_wei: 10000000000000000000`, `ruling.seller_percent: 67`,
`ruling.rule_results: [true, true, false]`, and `payout.seller_wei + payout.buyer_wei == funded_wei`
(`6700000000000000000` and `3300000000000000000`).

A second case, `demo-8837429b` (1 rule, 5 GEN), ruled 100% and paid the seller 5 GEN and the buyer 0.

## Links

- Source (this repository): https://github.com/Perorworld/agent-court
- Contract on GenLayer Studio: `0xa4CA829658fdF8Ece71d760d0E918bd649A48dae`
- Live page: https://agent-court-mauve.vercel.app
