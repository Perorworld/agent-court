/**
 * Judged Settlement Room — Internet Court x GenLayer x Yellow
 * The complete, verifiable flow in one command:
 *
 *  1. Buyer, seller and a court key open a Yellow app session; the buyer deposits.
 *     The session id becomes the ESCROW ID.
 *  2. The terms are bound on GenLayer to that escrow id: the buyer proposes the rules, amount and
 *     asset, the seller accepts the exact same terms (open_escrow -> accept_terms).
 *  3. The seller submits the deliverable; the buyer disputes. GenLayer validators rule on every
 *     agreed rule; seller_percent is computed from the agreed per-rule results.
 *  4. The stored ruling is applied through Yellow (operate -> close) and checked for conservation.
 *
 * Modes
 *   live : BUYER_PK, SELLER_PK, COURT_PK set -> real Yellow Nitronode calls.
 *   dry  : otherwise (or YELLOW_MODE=dry)    -> the Yellow steps are simulated (said on screen);
 *          every GenLayer step is still real.
 *
 * LOCAL DEMO NOTE: the three keys run in one process for readability.
 *
 * Run:  npm run demo
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal } from "decimal.js";
import { privateKeyToAddress, generatePrivateKey as evmKey } from "viem/accounts";
import { TransactionStatus } from "genlayer-js/types";
import { LIVE, WS_URL, ASSET, AMOUNT, QUORUM, liveRoom, dryRoom } from "./lib/yellow_room.js";
import { glClient, send, readEscrow, splitAmounts, requireRuling, adjudicatorAddress, NETWORK, type Hex } from "./lib/court.js";

const env = process.env;
const DELIVERABLE_URL =
  env.DELIVERABLE_URL ??
  "https://raw.githubusercontent.com/perorworld/internet-court-partner-demo-lab/main/demo/deliverable.md";
const RULES: string[] = env.RULES_JSON
  ? JSON.parse(env.RULES_JSON)
  : [
      "The page names the project 'Agent Court Demo'.",
      "The page lists at least three working features.",
      "The page includes a link to a live demo.",
    ];

// ---------------------------------------------------------------------------
// Terminal styling
// ---------------------------------------------------------------------------
const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", blue: "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m" };
const ts = () => `${c.gray}[${new Date().toISOString().slice(11, 23)}]${c.reset}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const log = (tag: string, color: string, msg: string) =>
  console.log(`${ts()} ${color}${c.bold}${tag.padEnd(10)}${c.reset} ${msg}`);

function step(n: number, title: string): void {
  console.log(`\n${c.bold}${c.yellow}▶ STEP ${n}${c.reset} ${c.bold}${title}${c.reset}`);
  console.log(`${c.gray}${"─".repeat(66)}${c.reset}`);
}

async function spin<T>(label: string, work: Promise<T>): Promise<T> {
  const f = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r${c.magenta}${f[i++ % f.length]}${c.reset} ${label}   `), 90);
  try { return await work; } finally { clearInterval(t); process.stdout.write("\r\x1b[K"); }
}

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`Verification failed: ${what}`);
  log("VERIFY", c.green, `✔ ${what}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const line = "═".repeat(66);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}  ⚖️  INTERNET COURT ${c.dim}×${c.reset}${c.bold}${c.magenta} GENLAYER ${c.dim}×${c.reset}${c.bold}${c.yellow} YELLOW${c.reset}`);
  console.log(`${c.gray}  Judged Settlement Room · terms bound to an escrow id · split from agreed rule results${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);

  const pk = {
    buyer: (env.BUYER_PK ?? evmKey()) as Hex,
    seller: (env.SELLER_PK ?? evmKey()) as Hex,
    court: (env.COURT_PK ?? evmKey()) as Hex,
  };
  const who = { buyer: privateKeyToAddress(pk.buyer), seller: privateKeyToAddress(pk.seller), court: privateKeyToAddress(pk.court) };
  log("MODE", c.cyan, LIVE ? `${c.bold}LIVE${c.reset} Yellow @ ${WS_URL}` : `${c.bold}${c.yellow}SIMULATED${c.reset} Yellow (GenLayer steps are real) — set BUYER_PK, SELLER_PK, COURT_PK for live`);
  log("PARTIES", c.cyan, `buyer ${short(who.buyer)}  seller ${short(who.seller)}  court ${short(who.court)}  weights 1/1/1 quorum ${QUORUM}`);

  const buyer = await glClient(pk.buyer);
  const seller = await glClient(pk.seller);

  // Contract: use the deployed one, or deploy a fresh copy.
  let adjudicator = adjudicatorAddress();
  if (!adjudicator) {
    log("DEPLOY", c.magenta, "No ADJUDICATOR_ADDRESS set — deploying AgentCourtAdjudicator…");
    const code = readFileSync(resolve("contracts/agent_court_adjudicator.py"), "utf-8");
    const h = await buyer.deployContract({ code, args: [] });
    const r: any = await spin("Waiting for deployment consensus", buyer.waitForTransactionReceipt({ hash: h as any, status: TransactionStatus.ACCEPTED, retries: 60, interval: 3000 }));
    adjudicator = r.data?.contract_address as Hex;
  }
  log("GENLAYER", c.magenta, `Adjudicator ${c.bold}${adjudicator}${c.reset} on ${NETWORK}`);

  // STEP 1 — Yellow room; the session id is the escrow id
  step(1, "Open the Yellow settlement room (its session id is the escrow id)");
  const room = LIVE ? await liveRoom(pk, DELIVERABLE_URL) : dryRoom();
  const escrowId = await room.open();
  log("YELLOW", c.yellow, `${LIVE ? "" : "(simulated) "}app session ${c.bold}${short(escrowId)}${c.reset} created`);
  await room.deposit();
  log("YELLOW", c.yellow, `${LIVE ? "" : "(simulated) "}buyer deposited ${c.bold}${AMOUNT} ${ASSET}${c.reset}`);

  // STEP 2 — bind both parties' agreed terms to that escrow id
  step(2, "Bind the agreed rules to the escrow id on GenLayer");
  const rulesJson = JSON.stringify(RULES);
  const amount = AMOUNT.toString();
  const txs: Record<string, string> = {};
  txs.open_escrow = await spin("Buyer proposes the terms", send(buyer, adjudicator, "open_escrow", [escrowId, who.seller, rulesJson, amount, ASSET]));
  log("BUYER", c.cyan, `open_escrow(${short(escrowId)}, seller, ${RULES.length} rules, ${amount} ${ASSET})  ${c.dim}${short(txs.open_escrow)}${c.reset}`);
  txs.accept_terms = await spin("Seller accepts the exact same terms", send(seller, adjudicator, "accept_terms", [escrowId, rulesJson, amount, ASSET]));
  log("SELLER", c.cyan, `accept_terms(...) with identical rules, amount, asset  ${c.dim}${short(txs.accept_terms)}${c.reset}`);
  RULES.forEach((r, i) => log("RULE", c.gray, `${i + 1}. ${r}`));

  // STEP 3 — deliver, dispute, rule
  step(3, "Seller delivers, buyer disputes, validators rule on every agreed rule");
  txs.submit_deliverable = await spin("Seller submits the deliverable", send(seller, adjudicator, "submit_deliverable", [escrowId, DELIVERABLE_URL]));
  log("SELLER", c.cyan, `submit_deliverable  ${c.dim}${DELIVERABLE_URL}${c.reset}`);
  log("BUYER", c.yellow, `${c.bold}Buyer rejects the work → raise_dispute${c.reset}`);
  log("GENLAYER", c.magenta, "Validators fetch the page (strict_eq evidence) and judge each rule (Optimistic Democracy)");
  txs.raise_dispute = await spin("Validators reaching consensus", send(buyer, adjudicator, "raise_dispute", [escrowId]));
  log("GENLAYER", c.green, `✔ consensus reached  ${c.dim}${short(txs.raise_dispute)}${c.reset}`);

  const rec = await readEscrow(buyer, adjudicator, escrowId);
  requireRuling(rec, escrowId);
  const ruling = rec.ruling;
  const color = ruling.seller_percent >= 50 ? c.green : c.red;
  console.log(`\n${color}${c.bold}  ┌──────────────────────── RULING ────────────────────────┐${c.reset}`);
  ruling.rule_results.forEach((ok, i) =>
    console.log(`  ${ok ? c.green + "✔" : c.red + "✘"}${c.reset} ${RULES[i]}  ${c.gray}${ruling.rule_reasons[i]}${c.reset}`));
  console.log(`${color}${c.bold}    ${ruling.rules_passed}/${ruling.rules_total} rules met → Seller ${ruling.seller_percent}% · Buyer ${100 - ruling.seller_percent}%${c.reset}`);
  console.log(`${color}${c.bold}  └─────────────────────────────────────────────────────────┘${c.reset}\n`);

  // Binding checks: the record on GenLayer must match what both parties agreed to
  check(rec.escrow_id === escrowId, `case is bound to escrow id ${short(escrowId)}`);
  check(rec.buyer.toLowerCase() === who.buyer.toLowerCase() && rec.seller.toLowerCase() === who.seller.toLowerCase(), "buyer and seller addresses match the Yellow participants");
  check(JSON.stringify(rec.rules) === JSON.stringify(RULES) && rec.amount === amount && rec.asset === ASSET, "rules, amount and asset are exactly what both parties agreed");
  check(ruling.seller_percent === Math.floor((100 * ruling.rules_passed + Math.floor(ruling.rules_total / 2)) / ruling.rules_total), "seller_percent equals the arithmetic split of the agreed rule results");

  // STEP 4 — settle exactly what the contract stored
  step(4, "Settle the stored ruling through Yellow");
  const { seller: sellerAmt, buyer: buyerAmt } = splitAmounts(new Decimal(rec.amount), ruling.seller_percent);
  check(sellerAmt.plus(buyerAmt).eq(new Decimal(rec.amount)), `allocations add up to the escrow: ${sellerAmt} + ${buyerAmt} = ${rec.amount} ${rec.asset}`);
  const favoured = ruling.seller_percent >= 50 ? "seller" : "buyer";
  log("COURT", c.blue, `court signs the stored ruling; ${favoured} co-signs → quorum ${QUORUM} met`);
  await room.settle(sellerAmt, buyerAmt, favoured);
  log("YELLOW", c.green, `${LIVE ? "" : "(simulated) "}room closed · seller ${c.bold}${sellerAmt} ${rec.asset}${c.reset} · buyer ${c.bold}${buyerAmt} ${rec.asset}${c.reset}`);

  console.log(`\n${c.cyan}${c.bold}  VERIFICATION SUMMARY${c.reset}`);
  console.log(`  contract   ${adjudicator}\n  escrow id  ${escrowId}`);
  Object.entries(txs).forEach(([k, v]) => console.log(`  ${k.padEnd(19)}${v}`));
  console.log(`  read it    genlayer call ${adjudicator} get_escrow --args ${escrowId}`);
  if (!LIVE) log("NOTE", c.yellow, "Yellow steps were simulated. Add funded wallet keys to .env to settle for real.");
  log("DONE", c.green, `${c.bold}Judged settlement complete.${c.reset} Internet Court ✚ GenLayer ✚ Yellow\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${c.red}${c.bold}✖ Demo failed:${c.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
