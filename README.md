<p align="center">
  <img src="assets/logos/internet-court.svg" alt="Internet Court" height="56"/>&nbsp;&nbsp;
  <img src="assets/logos/genlayer.svg" alt="GenLayer" height="56"/>&nbsp;&nbsp;
  <img src="assets/logos/yellow.svg" alt="Yellow" height="56"/>
</p>

<h1 align="center">Judged Settlement Room</h1>

<p align="center">
  Agents pool funds in a <b>Yellow</b> settlement room. When they disagree, <b>GenLayer</b> validators
  read the deliverable and rule, and Yellow settles the split. An <b>Internet Court</b> flow.
</p>

> Replace the placeholder wordmarks in `assets/logos/` with the official brand SVGs before publishing.

**Live demo page:** _add your Vercel link here_ · **Demo video:** _add link here_

---

## The idea

Yellow's settlement room lets several agents hold funds together, reallocate off-chain, and settle one final split. What a room cannot do is judge whether the work was actually good. That is the missing piece Internet Court is built around, and GenLayer supplies it.

```
 Buyer ─┐                                   ┌────────────────────────┐
 Seller ├─ Yellow app session (3 signers) ──│ AgentCourtAdjudicator  │
 Court ─┘   funds pooled off-chain          │  web.get → LLM → split │
                  ▲                         │  validator consensus   │
                  └──── signed split ◀──────┴────────────────────────┘
```

1. Buyer, seller and a court key open a Yellow app session (weights 1/1/1, quorum 2). Buyer deposits.
2. Seller submits a public deliverable URL.
3. Buyer disputes. The GenLayer contract rules: `{"verdict", "seller_percent", "confidence", "reason"}`.
4. The court signs the ruling, the favoured party co-signs, and Yellow settles the split.

## Why GenLayer is central

- **Non-deterministic web parsing.** `gl.nondet.web.get` reads the live deliverable. The normalized evidence is wrapped in `gl.eq_principle.strict_eq`, so every validator must see identical proof.
- **LLM judgment by consensus.** The leader's verdict is re-run by validators and accepted through `gl.eq_principle.prompt_comparative` (Optimistic Democracy): the split may differ by at most 10 points.
- **Fail-safe.** Unreachable evidence or unusable output defaults to a full buyer refund.

Remove GenLayer and nothing decides the split.

## Why Yellow is central

The room is where the money lives. Funds are pooled and reallocated off-chain with no per-step gas, and the final split settles through Yellow's non-custodial clearing. The court never holds funds: no allocation changes without signatures that meet quorum.

## Repository

| Path | Purpose |
|------|---------|
| `contracts/agent_court_adjudicator.py` | GenLayer Intelligent Contract (`resolve_dispute` → split) |
| `scripts/yellow_settlement.ts` | End-to-end demo: Yellow room + GenLayer ruling + settlement |
| `scripts/settle.ts` | `npm run settle -- --case N`: settle one GenLayer ruling through a Yellow room |
| `scripts/lib/yellow_room.ts` | Shared Yellow room helpers (live or simulated) |
| `web/index.html` | Public interface (deploys as a static page on Vercel) |
| `skills/internet_court_yellow_genlayer_skill.md` | Agent skill; composes with Yellow's settlement-room skill |
| `demo/deliverable.md` | Sample deliverable the demo adjudicates |

## Run it

**1. Deploy the contract** in [GenLayer Studio](https://studio.genlayer.com): paste `contracts/agent_court_adjudicator.py`, deploy with no arguments, copy the address into `.env` as `ADJUDICATOR_ADDRESS`.

**2. Install and run (dry mode, no Yellow funds needed):**

```bash
npm install && cp .env.example .env
```

```bash
npm run demo:dry
```

Dry mode runs the real GenLayer ruling and simulates the Yellow steps, and says so on screen.

**3. Live mode:** fill `BUYER_PK`, `SELLER_PK`, `COURT_PK`, `YELLOW_CHAIN_ID`, `YELLOW_RPC_URL` in `.env`, then:

```bash
npm run demo
```

Funding: Yellow's skill never funds accounts, so the buyer must already hold `ESCROW_AMOUNT` of `YELLOW_ASSET` at Yellow. Follow Yellow's quickstart at `docs.yellow.org` for the one-time deposit.

**4. Web page:** put your contract address in `DEFAULT_CONTRACT` inside `web/index.html` (or open the page with `?contract=0x…`), upload the repo to GitHub, and import it in Vercel with the root directory set to `web`.

## Settle a ruling with Yellow

Every ruling on the page shows a settle command with its case number:

```bash
npm run settle -- --case 1
```

It reads that case from GenLayer (always real) and settles the seller/buyer split through a Yellow app session.

- **Simulated (default):** with no wallet keys in `.env`, the Yellow steps are simulated and the output says so on every line.
- **Live:** set `BUYER_PK`, `SELLER_PK`, `COURT_PK`, `YELLOW_CHAIN_ID` and `YELLOW_RPC_URL`, and fund the buyer at Yellow. Then the same command settles for real.

## Trust boundary (read this)

- No participant can change another's allocation without signatures meeting quorum.
- The **court key is a relayer**: it signs what GenLayer decided. Yellow does not read GenLayer natively. With quorum 2 of 3, the court plus one party can settle without the other, so set quorum 3 if you want unanimity.
- The Yellow node is trusted for liveness; funds are not an on-chain escrow while inside the session.
- All three keys run in one process in this demo for readability. A real deployment signs from separate processes.
- Testnet only. Rulings are LLM-generated and unaudited.

## License

MIT
