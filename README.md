<p align="center">
  <img src="assets/logos/internet-court.svg" alt="Internet Court" height="56"/>&nbsp;&nbsp;
  <img src="assets/logos/genlayer.svg" alt="GenLayer" height="56"/>&nbsp;&nbsp;
  <img src="assets/logos/yellow.svg" alt="Yellow" height="56"/>
</p>

<h1 align="center">Judged Settlement Room</h1>

<p align="center">
  Two parties agree on rules for an escrow. If they disagree about the work, <b>GenLayer</b> validators
  rule on every agreed rule and the split is paid out: <b>in GEN by the contract itself</b>, or <b>through Yellow</b>
  for other assets. An <b>Internet Court</b> flow.
</p>

**Live page:** _add your Vercel link_ · **Contract (GenLayer Studio):** _add your v3 address_ · **Demo video:** _add link_

> Replace the placeholder wordmarks in `assets/logos/` and `web/assets/` with the official brand SVGs before publishing.

---

## How a case works

| # | Who | Call (on `contracts/agent_court_adjudicator.py`) | What it does |
|---|-----|---|---|
| 1 | Buyer | `open_escrow(escrow_id, seller, rules_json, amount, asset)` | Case keyed by the **escrow id**; records buyer, seller, **agreed rules**, amount, asset |
| 2 | Seller | `accept_terms(escrow_id, rules_json, amount, asset)` | Succeeds only with the **identical** rules, amount and asset |
| 3 | Buyer | `fund_escrow(escrow_id)` payable, **GEN only** | Locks exactly the agreed amount of GEN in the contract |
| 4 | Seller | `submit_deliverable(escrow_id, url)` | Only the seller; for GEN only after funding |
| 5a | Buyer | `approve(escrow_id)` | Buyer is satisfied: seller gets 100% |
| 5b | Buyer | `raise_dispute(escrow_id)` | Validators rule on **every agreed rule**; one ruling per escrow |
| 6 | Anyone | `settle(escrow_id)`, **GEN only** | The contract pays the recorded seller and buyer in GEN, once |
| – | Buyer / Seller | `cancel(escrow_id)` | Buyer before anything is locked; once locked, only the seller can release the GEN back |

### Two payment rails, one ruling

- **GEN (default on the page):** the buyer locks GEN in the contract; after the ruling `settle()` pays `seller = amount × seller_percent ÷ 100` (rounded down) and the buyer gets the remainder, using exact integer wei. The sum always equals the locked amount.
- **Other assets (for example usdc):** the funds sit in the Yellow app session whose id is the escrow id; `scripts/settle.ts` applies the same stored percentage through Yellow.

## The split is consensus-bound

1. Validators fetch the deliverable with `gl.nondet.web.get`; the normalized evidence goes through `gl.eq_principle.strict_eq`, so all of them must see identical proof.
2. Each validator judges **each agreed rule** separately. `gl.eq_principle.prompt_comparative` accepts a result only if the pass/fail list is identical element by element (Optimistic Democracy).
3. The contract computes `seller_percent = round(100 × rules_passed ÷ rules_total)` from that agreed list. There is no free-form LLM number. An unreachable deliverable fails every rule with no LLM call; unusable validator output fails every rule (fail-safe: refund).
4. Whatever pays out (the contract in GEN, or the script through Yellow) applies exactly that stored percentage.

## Why GenLayer and Yellow are both here

- **GenLayer** reads the live web page, judges it against the agreed rules with validator consensus, and for GEN also holds and pays the money. Remove it and nothing decides or pays.
- **Yellow** is the non-custodial off-chain room for agent funds in other assets: pooled and reallocated off-chain, only final balances settle, the court key never holds funds.

## Repository

| Path | Purpose |
|------|---------|
| `contracts/agent_court_adjudicator.py` | The Intelligent Contract (source of truth for every method the page and scripts call) |
| `tests/test_adjudicator.py` | Local tests of the contract logic (`npm test`) |
| `scripts/gen_settlement.ts` | Whole flow paid in GEN (`npm run demo:gen`) |
| `scripts/yellow_settlement.ts` | Whole flow through Yellow (`npm run demo`) |
| `scripts/settle.ts` | Settle one ruled escrow (`npm run settle -- --escrow <id>`) |
| `scripts/lib/*.ts` | GenLayer and Yellow helpers |
| `web/index.html` | Public page (static; deploy `web/` on Vercel) |
| `skills/internet_court_yellow_genlayer_skill.md` | Agent skill |
| `VERIFY.md` | Step-by-step verification of the whole flow |

## Run it

```bash
npm install && cp .env.example .env
```

1. Deploy `contracts/agent_court_adjudicator.py` in [GenLayer Studio](https://studio.genlayer.com) with no arguments. Put the address in `.env` as `ADJUDICATOR_ADDRESS` and in `DEFAULT_CONTRACT` in `web/index.html`.
2. Check the contract logic locally:

```bash
npm test
```

3. Paid in GEN. Set `BUYER_PK` to a key that holds GEN (Studio and Studionet: the 💧 faucet in the account selector; testnet: the GenLayer testnet faucet), then:

```bash
npm run demo:gen
```

4. Through Yellow (simulated unless funded Yellow wallet keys are set; the output says so):

```bash
npm run demo
```

See `VERIFY.md` for what each step should show and how to read the stored case.

## Trust boundary

- Each case is bound to its escrow id, both parties' addresses, and the rules, amount and asset both parties accepted. Rules cannot be supplied at dispute time and a case is ruled once.
- GEN is held by the contract and can only be paid to the recorded seller and buyer, once, in the stored proportion. Anyone may trigger `settle()`.
- There is no deadline. If the seller never delivers, the locked GEN stays until the seller releases it with `cancel()`. A production version needs a timeout path.
- Yellow rail: the **court key is a relayer** that signs what GenLayer decided; with quorum 2 of 3 the court plus one party can settle without the other. Settlement scripts read accepted GenLayer state; wait for finality on production networks.
- `tests/test_adjudicator.py` exercises the contract logic against a stand-in for the SDK (including the GEN payouts). It does not test GenLayer consensus; use Studio for that.
- The Yellow steps are simulated unless funded wallet keys are set. The web page uses throwaway demo keys; the contract, not the page, enforces who may do what.
- Testnet only. Rulings are LLM-assisted and unaudited.

## License

MIT
