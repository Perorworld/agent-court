/**
 * Settle one finished GenLayer ruling through its Yellow settlement room.
 *
 *   npm run settle -- --escrow <escrow id>
 *
 * The escrow id is the Yellow app session id the case is bound to on GenLayer. The script:
 *   1. reads the escrow record from the AgentCourtAdjudicator (state must be RULED);
 *   2. checks that your wallet keys are the buyer and seller recorded in that case (live mode);
 *   3. applies exactly the stored seller_percent to the stored amount (rounding down for the
 *      seller, remainder to the buyer) and checks the allocations add up;
 *   4. operates and closes the existing Yellow session.
 *
 * GEN escrows (asset "GEN") are paid by the contract itself: this script just calls settle(), then
 * prints the exact payout the contract recorded. Any other asset is settled through Yellow:
 *
 * LIVE      : BUYER_PK, SELLER_PK, COURT_PK in .env -> real Yellow calls on the existing session.
 * SIMULATED : otherwise. The ruling is still read for real from GenLayer; the output says so.
 *
 * LOCAL DEMO NOTE: all three keys run in one process. A real deployment signs from separate processes.
 */
import "dotenv/config";
import { Decimal } from "decimal.js";
import { privateKeyToAddress, generatePrivateKey as evmKey } from "viem/accounts";
import { LIVE, WS_URL, QUORUM, liveRoom, dryRoom } from "./lib/yellow_room.js";
import { glClient, send, readEscrow, splitAmounts, requireRuling, adjudicatorAddress, fromWei, type Hex } from "./lib/court.js";

const env = process.env;
const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m" };
const ts = () => `${c.gray}[${new Date().toISOString().slice(11, 23)}]${c.reset}`;
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const log = (tag: string, color: string, msg: string) =>
  console.log(`${ts()} ${color}${c.bold}${tag.padEnd(10)}${c.reset} ${msg}`);

/** Read `--escrow <id>` (or `--escrow=<id>`) from the command line. */
function parseEscrowId(argv: string[]): string {
  const i = argv.findIndex((a) => a === "--escrow" || a.startsWith("--escrow="));
  const raw = i === -1 ? undefined : argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
  if (!raw) throw new Error("Usage: npm run settle -- --escrow <escrow id>   (the escrow id is shown on the Agent Court page)");
  return raw;
}

async function main(): Promise<void> {
  const escrowId = parseEscrowId(process.argv.slice(2));
  const contract = adjudicatorAddress();
  if (!contract) throw new Error("Set ADJUDICATOR_ADDRESS in .env to the deployed AgentCourtAdjudicator address.");

  console.log(`\n${c.bold}${c.yellow}  ⚖️  SETTLE ESCROW ${short(escrowId)}${c.reset}  ${c.dim}Internet Court × GenLayer × Yellow${c.reset}`);
  log("MODE", c.cyan, LIVE
    ? `${c.bold}LIVE${c.reset} Yellow @ ${WS_URL}`
    : `${c.bold}${c.yellow}SIMULATED${c.reset} Yellow settlement (set BUYER_PK, SELLER_PK, COURT_PK in .env for live)`);

  // 1) Read the bound case from GenLayer (always real)
  const reader = await glClient(evmKey());
  log("GENLAYER", c.magenta, `Reading escrow ${short(escrowId)} from ${c.bold}${short(contract)}${c.reset}`);
  const rec = await readEscrow(reader, contract, escrowId);
  requireRuling(rec, escrowId);
  const ruling = rec.ruling;
  log("BOUND", c.cyan, `buyer ${short(rec.buyer)} · seller ${short(rec.seller)} · ${rec.amount} ${rec.asset} · ${rec.rules.length} agreed rules`);
  ruling.rule_results.forEach((ok, i) => log("RULE", ok ? c.green : c.red, `${ok ? "✔" : "✘"} ${rec.rules[i]}`));
  const color = ruling.seller_percent >= 50 ? c.green : c.red;
  log("RULING", color, `${c.bold}${ruling.rules_passed}/${ruling.rules_total} rules met → Seller ${ruling.seller_percent}% · Buyer ${100 - ruling.seller_percent}%${c.reset}  (${ruling.source})`);

  // GEN rail: the contract pays out on GenLayer
  if (rec.asset === "GEN") {
    const caller = await glClient((env.COURT_PK ?? env.BUYER_PK ?? evmKey()) as Hex);
    const { seller: s, buyer: b } = splitAmounts(new Decimal(rec.amount), ruling.seller_percent);
    log("GEN", c.cyan, `expected payout: seller ${s} GEN + buyer ${b} GEN = ${rec.amount} GEN`);
    const hash = await send(caller, contract, "settle", [escrowId]);
    log("GEN", c.green, `✔ settle() accepted  ${c.dim}${short(hash)}${c.reset}`);
    const after = await readEscrow(reader, contract, escrowId);
    const pay = after?.payout as { seller_wei: string; buyer_wei: string };
    log("PAID", c.green, `${c.bold}seller ${fromWei(pay.seller_wei)} GEN · buyer ${fromWei(pay.buyer_wei)} GEN${c.reset} (paid by the contract on GenLayer)`);
    if (fromWei(pay.seller_wei) !== s.toString() && !new Decimal(fromWei(pay.seller_wei)).eq(s)) throw new Error("Contract payout differs from the expected split");
    console.log("");
    return;
  }

  // 2) The keys we hold must be the parties recorded in the case
  const pk = {
    buyer: (env.BUYER_PK ?? evmKey()) as Hex,
    seller: (env.SELLER_PK ?? evmKey()) as Hex,
    court: (env.COURT_PK ?? evmKey()) as Hex,
  };
  if (LIVE) {
    const okParties =
      privateKeyToAddress(pk.buyer).toLowerCase() === rec.buyer.toLowerCase() &&
      privateKeyToAddress(pk.seller).toLowerCase() === rec.seller.toLowerCase();
    if (!okParties) throw new Error("BUYER_PK / SELLER_PK do not match the buyer and seller recorded in this escrow. Refusing to settle.");
    log("BOUND", c.green, "✔ wallet keys match the buyer and seller recorded on GenLayer");
  }

  // 3) Exact amounts from the stored percentage
  const { seller: sellerAmt, buyer: buyerAmt } = splitAmounts(new Decimal(rec.amount), ruling.seller_percent);
  log("SPLIT", c.cyan, `${sellerAmt} + ${buyerAmt} = ${rec.amount} ${rec.asset} ✔`);

  // 4) Settle on the existing Yellow session
  const room = LIVE ? await liveRoom(pk, rec.deliverable_url, escrowId) : dryRoom(escrowId);
  const sessionId = await room.open();
  log("YELLOW", c.yellow, `${LIVE ? "" : "(simulated) "}attached to app session ${c.bold}${short(sessionId)}${c.reset}`);
  const favoured = ruling.seller_percent >= 50 ? "seller" : "buyer";
  log("COURT", c.cyan, `court signs the stored ruling; ${favoured} co-signs → quorum ${QUORUM}/3 met`);
  await room.settle(sellerAmt, buyerAmt, favoured);
  log("YELLOW", c.green, `${LIVE ? "" : "(simulated) "}room closed · seller ${c.bold}${sellerAmt} ${rec.asset}${c.reset} · buyer ${c.bold}${buyerAmt} ${rec.asset}${c.reset}`);
  if (!LIVE) log("NOTE", c.yellow, "Nothing was sent to Yellow. Add funded wallet keys to .env to settle for real.");
  console.log("");
}

main().catch((err: unknown) => {
  console.error(`\n${c.red}${c.bold}✖ Settle failed:${c.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
