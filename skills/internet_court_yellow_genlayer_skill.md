---
name: judged-settlement-room
version: 2.0.0
description: >
  Bind an escrow's agreed rules on GenLayer, let validators rule on every rule if the parties
  disagree, and settle the resulting split through the Yellow session with the same id.
composes_with:
  - yellow-settlement-room   # npx skills add internet-court/internet-court-skill
requires_env: [ADJUDICATOR_ADDRESS, BUYER_PK, SELLER_PK, COURT_PK, YELLOW_CHAIN_ID, YELLOW_RPC_URL]
requires_bins: [node, npx]
---

# Judged Settlement Room (Internet Court × GenLayer × Yellow)

## Hard rules
1. Never move funds without the user confirming amount, asset, both parties and the rules.
2. The escrow id is the Yellow app session id. Never invent one for a live case.
3. Write rules as checkable statements, one per rule (max 8). Both parties must accept the identical text.
4. Deliverable URLs must be public; validators cannot open login-gated pages.
5. A case is ruled once. Do not retry `raise_dispute` after a ruling.
6. Report the ruling exactly as stored: rule results, `seller_percent`, source.
7. Yellow never funds accounts. Say so, and say when a run is simulated.

## Steps (GenLayer CLI)
```bash
genlayer network set studionet
# 1. buyer proposes (escrow id = Yellow session id)
genlayer write $ADJUDICATOR_ADDRESS open_escrow --args "$ESCROW_ID" "$SELLER_ADDRESS" "$RULES_JSON" "$AMOUNT" "$ASSET"
# 2. seller accepts the identical terms
genlayer write $ADJUDICATOR_ADDRESS accept_terms --args "$ESCROW_ID" "$RULES_JSON" "$AMOUNT" "$ASSET"
# 3. seller delivers
genlayer write $ADJUDICATOR_ADDRESS submit_deliverable --args "$ESCROW_ID" "$DELIVERABLE_URL"
# (GEN escrows) buyer locks the agreed amount, in wei, as the call value
genlayer write $ADJUDICATOR_ADDRESS fund_escrow --args "$ESCROW_ID" --value "$AMOUNT_WEI"
# 4a. buyer approves (seller 100%)   or   4b. buyer disputes (validators rule on every rule)
genlayer write $ADJUDICATOR_ADDRESS approve --args "$ESCROW_ID"
genlayer write $ADJUDICATOR_ADDRESS raise_dispute --args "$ESCROW_ID"
# 5. read the bound record and ruling
genlayer call $ADJUDICATOR_ADDRESS get_escrow --args "$ESCROW_ID"
```
Use the buyer's key for steps 1, 4a, 4b and the seller's key for steps 2 and 3. Wait for `ACCEPTED` after each (the dispute takes the longest).

`RULES_JSON` is a JSON list, for example `["Names the project","Lists 3 features","Links a live demo"]`.
`seller_percent = round(100 × rules_passed ÷ rules_total)` and is computed by the contract from the validator-agreed list.

## Settle
GEN escrows: anyone calls `genlayer write $ADJUDICATOR_ADDRESS settle --args "$ESCROW_ID"`; the contract pays the recorded seller and buyer in GEN, once. Other assets (Yellow rail):
```bash
npm run settle -- --escrow "$ESCROW_ID"
```
Reads the stored record, checks parties and amount, applies exactly the stored percentage, and closes the Yellow session with that id. Simulated unless wallet keys are set.

One command for the whole flow: `npm run demo`.

## Trust boundary (say this to the user)
- The court key is a relayer: it signs what GenLayer decided. With quorum 2 of 3, the court plus one party can settle without the other.
- Settlement reads accepted GenLayer state; wait for finality on production networks.
- The deposit is the most any depositor can lose.

## Errors
| Error | Meaning |
|---|---|
| `rules differ from the buyer's proposal` | Seller must resubmit the identical rules, amount and asset |
| `only the seller/buyer can …` | Wrong key for this step |
| `already ruled` | One ruling per escrow |
| `not RULED yet` | Settlement refuses until a ruling exists |
