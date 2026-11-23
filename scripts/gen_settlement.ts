/**
 * Judged Settlement Room, paid in GEN — the complete flow on GenLayer, one command:
 *
 *   npm run demo:gen
 *
 *  1. Buyer proposes the terms (rules, amount in GEN) bound to an escrow id; seller accepts the same terms.
 *  2. Buyer locks the agreed GEN inside the contract (fund_escrow, payable).
 *  3. Seller delivers; buyer disputes; validators rule on every agreed rule.
 *  4. settle(): the contract pays the seller and the buyer in GEN, exactly seller_percent / remainder.
 *
 * Needs BUYER_PK funded with GEN (Studio / Studionet: the 💧 faucet in the account selector; testnet: the
 * faucet at testnet-faucet.genlayer.foundation) and ESCROW_AMOUNT_GEN (default 0.01). No Yellow involved.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { privateKeyToAddress, generatePrivateKey as evmKey } from "viem/accounts";
import { TransactionStatus } from "genlayer-js/types";
import { glClient, send, readEscrow, requireRuling, adjudicatorAddress, toWei, fromWei, NETWORK, type Hex } from "./lib/court.js";

const env = process.env;
const AMOUNT = env.ESCROW_AMOUNT_GEN ?? "0.01";
const DELIVERABLE_URL =
  env.DELIVERABLE_URL ?? "https://raw.githubusercontent.com/perorworld/internet-court-partner-demo-lab/main/demo/deliverable.md";
const RULES: string[] = env.RULES_JSON
  ? JSON.parse(env.RULES_JSON)
  : [
      "The page names the project 'Agent Court Demo'.",
      "The page lists at least three working features.",
      "The page includes a link to a live demo.",
    ];

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m" };
const ts = () => `${c.gray}[${new Date().toISOString().slice(11, 23)}]${c.reset}`;
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const log = (tag: string, color: string, msg: string) =>
  console.log(`${ts()} ${color}${c.bold}${tag.padEnd(10)}${c.reset} ${msg}`);
const step = (n: number, t: string) => console.log(`\n${c.bold}${c.yellow}▶ STEP ${n}${c.reset} ${c.bold}${t}${c.reset}\n${c.gray}${"─".repeat(66)}${c.reset}`);
async function spin<T>(label: string, work: Promise<T>): Promise<T> {
  const f = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]; let i = 0;
  const t = setInterval(() => process.stdout.write(`\r${c.magenta}${f[i++ % f.length]}${c.reset} ${label}   `), 90);
  try { return await work; } finally { clearInterval(t); process.stdout.write("\r\x1b[K"); }
}

async function main(): Promise<void> {
  console.log(`\n${c.cyan}${"═".repeat(66)}${c.reset}\n${c.bold}  ⚖️  INTERNET COURT ${c.dim}×${c.reset}${c.bold}${c.magenta} GENLAYER${c.reset}${c.bold}  ·  paid in GEN${c.reset}\n${c.cyan}${"═".repeat(66)}${c.reset}\n`);
  if (!env.BUYER_PK) throw new Error("Set BUYER_PK in .env to a key that holds GEN (use the 💧 faucet in GenLayer Studio, or the testnet faucet).");

  const pk = { buyer: env.BUYER_PK as Hex, seller: (env.SELLER_PK ?? evmKey()) as Hex };
  const sellerAddr = privateKeyToAddress(pk.seller);
  const buyer = await glClient(pk.buyer);
  const seller = await glClient(pk.seller);
  log("PARTIES", c.cyan, `buyer ${short(privateKeyToAddress(pk.buyer))}  seller ${short(sellerAddr)}  amount ${c.bold}${AMOUNT} GEN${c.reset}  network ${NETWORK}`);

  let contract = adjudicatorAddress();
  if (!contract) {
    log("DEPLOY", c.magenta, "No ADJUDICATOR_ADDRESS set — deploying AgentCourtAdjudicator…");
    const h = await buyer.deployContract({ code: readFileSync(resolve("contracts/agent_court_adjudicator.py"), "utf-8"), args: [] });
    const r: any = await spin("Waiting for deployment consensus", buyer.waitForTransactionReceipt({ hash: h as any, status: TransactionStatus.ACCEPTED, retries: 60, interval: 3000 }));
    contract = r.data?.contract_address as Hex;
  }
  log("GENLAYER", c.magenta, `Adjudicator ${c.bold}${contract}${c.reset}`);

  const escrowId = "gen-" + Date.now().toString(16);
  const rulesJson = JSON.stringify(RULES);
  const txs: Record<string, string> = {};

  step(1, "Bind the agreed terms to the escrow id");
  txs.open_escrow = await spin("Buyer proposes the terms", send(buyer, contract, "open_escrow", [escrowId, sellerAddr, rulesJson, AMOUNT, "GEN"]));
  log("BUYER", c.cyan, `open_escrow(${escrowId}, seller, ${RULES.length} rules, ${AMOUNT} GEN)`);
  txs.accept_terms = await spin("Seller accepts the exact same terms", send(seller, contract, "accept_terms", [escrowId, rulesJson, AMOUNT, "GEN"]));
  log("SELLER", c.cyan, "accept_terms(...) with identical rules, amount, asset");

  step(2, `Buyer locks ${AMOUNT} GEN in the contract`);
  txs.fund_escrow = await spin("Locking GEN", send(buyer, contract, "fund_escrow", [escrowId], toWei(AMOUNT)));
  log("ESCROW", c.green, `✔ ${AMOUNT} GEN locked  ${c.dim}${short(txs.fund_escrow)}${c.reset}`);

  step(3, "Seller delivers, buyer disputes, validators rule on every rule");
  txs.submit_deliverable = await spin("Seller submits the deliverable", send(seller, contract, "submit_deliverable", [escrowId, DELIVERABLE_URL]));
  log("SELLER", c.cyan, `submit_deliverable  ${c.dim}${DELIVERABLE_URL}${c.reset}`);
  log("BUYER", c.yellow, `${c.bold}Buyer rejects the work → raise_dispute${c.reset}`);
  txs.raise_dispute = await spin("Validators reaching consensus", send(buyer, contract, "raise_dispute", [escrowId]));
  const ruled = await readEscrow(buyer, contract, escrowId);
  requireRuling(ruled, escrowId);
  const g = ruled.ruling;
  g.rule_results.forEach((ok, i) => console.log(`  ${ok ? c.green + "✔" : c.red + "✘"}${c.reset} ${RULES[i]}  ${c.gray}${g.rule_reasons[i]}${c.reset}`));
  log("RULING", g.seller_percent >= 50 ? c.green : c.red, `${c.bold}${g.rules_passed}/${g.rules_total} rules met → Seller ${g.seller_percent}% · Buyer ${100 - g.seller_percent}%${c.reset}`);

  step(4, "The contract pays out in GEN");
  txs.settle = await spin("settle()", send(buyer, contract, "settle", [escrowId]));
  const done = await readEscrow(buyer, contract, escrowId);
  const pay = done?.payout as { seller_wei: string; buyer_wei: string };
  if (done?.state !== "SETTLED") throw new Error(`Expected SETTLED, got ${done?.state}`);
  if (BigInt(pay.seller_wei) + BigInt(pay.buyer_wei) !== toWei(AMOUNT)) throw new Error("Payout does not add up to the locked amount");
  log("PAID", c.green, `${c.bold}seller ${fromWei(pay.seller_wei)} GEN · buyer ${fromWei(pay.buyer_wei)} GEN${c.reset} (sum = ${AMOUNT} GEN ✔)`);

  console.log(`\n${c.cyan}${c.bold}  VERIFICATION SUMMARY${c.reset}\n  contract   ${contract}\n  escrow id  ${escrowId}`);
  Object.entries(txs).forEach(([k, v]) => console.log(`  ${k.padEnd(19)}${v}`));
  console.log(`  read it    genlayer call ${contract} get_escrow --args ${escrowId}\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${c.red}${c.bold}✖ Demo failed:${c.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
