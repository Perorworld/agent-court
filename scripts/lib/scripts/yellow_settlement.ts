/**
 * Judged Settlement Room — Internet Court x GenLayer x Yellow
 *
 *  1. Buyer, seller and a "court" key open a Yellow app session; buyer deposits.
 *  2. Seller submits a public deliverable URL.
 *  3. Buyer disputes -> GenLayer's AgentCourtAdjudicator rules (real GenLayer tx).
 *  4. The ruling's seller/buyer split is signed by the court + the favoured party
 *     and settled through Yellow (operate -> close).
 *
 * Modes
 *   live : BUYER_PK, SELLER_PK, COURT_PK set -> real Yellow Nitronode calls.
 *   dry  : otherwise (or YELLOW_MODE=dry)    -> Yellow steps are only simulated;
 *          the GenLayer ruling is still real.
 *
 * LOCAL DEMO NOTE: all three keys live in one process for readability. In a real
 * deployment each agent signs from its own process (see Yellow's settlement-room skill).
 *
 * Run:  npm run demo
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, localnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { Decimal } from "decimal.js";
import { privateKeyToAddress, generatePrivateKey as evmKey } from "viem/accounts";
import { LIVE, WS_URL, ASSET, AMOUNT, QUORUM, liveRoom, dryRoom } from "./lib/yellow_room.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const env = process.env;
const NETWORK = env.GENLAYER_NETWORK ?? "studionet";
const CHAIN = NETWORK === "localnet" ? localnet : studionet;
const DELIVERABLE_URL =
  env.DELIVERABLE_URL ??
  "https://raw.githubusercontent.com/perorworld/internet-court-partner-demo-lab/main/demo/deliverable.md";
const SPEC_RULES =
  env.SPEC_RULES ??
  "The deliverable must (1) name the project 'Agent Court Demo', (2) list at least three working features, and (3) include a link to a live demo.";

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

interface Ruling { verdict: string; seller_percent?: number; confidence: number; reason: string }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const line = "═".repeat(66);
  console.log(`\n${c.cyan}${line}${c.reset}`);
  console.log(`${c.bold}  ⚖️  INTERNET COURT ${c.dim}×${c.reset}${c.bold}${c.magenta} GENLAYER ${c.dim}×${c.reset}${c.bold}${c.yellow} YELLOW${c.reset}`);
  console.log(`${c.gray}  Judged Settlement Room · agents pool funds, an AI court splits them${c.reset}`);
  console.log(`${c.cyan}${line}${c.reset}\n`);

  const pk = {
    buyer: (env.BUYER_PK ?? evmKey()) as `0x${string}`,
    seller: (env.SELLER_PK ?? evmKey()) as `0x${string}`,
    court: (env.COURT_PK ?? evmKey()) as `0x${string}`,
  };
  log("MODE", c.cyan, LIVE ? `${c.bold}LIVE${c.reset} Yellow @ ${WS_URL}` : `${c.bold}DRY${c.reset} (Yellow simulated, GenLayer real) — set BUYER_PK / SELLER_PK / COURT_PK for live`);
  log("ROOM", c.cyan, `buyer ${short(privateKeyToAddress(pk.buyer))}  seller ${short(privateKeyToAddress(pk.seller))}  court ${short(privateKeyToAddress(pk.court))}`);
  log("ROOM", c.cyan, `weights 1/1/1 · quorum ${QUORUM} · escrow ${c.bold}${AMOUNT} ${ASSET}${c.reset}`);

  // GenLayer client + contract
  const gl = createClient({ chain: CHAIN, account: createAccount(env.GENLAYER_PK ? (env.GENLAYER_PK as `0x${string}`) : generatePrivateKey()) });
  if (NETWORK === "studionet") { try { await gl.initializeConsensusSmartContract(); } catch { /* already initialized */ } }

  let adjudicator = env.ADJUDICATOR_ADDRESS as `0x${string}` | undefined;
  if (!adjudicator) {
    log("DEPLOY", c.magenta, "No ADJUDICATOR_ADDRESS set — deploying AgentCourtAdjudicator…");
    const code = readFileSync(resolve("contracts/agent_court_adjudicator.py"), "utf-8");
    const h = await gl.deployContract({ code, args: [] });
    const r: any = await spin("Waiting for deployment consensus", gl.waitForTransactionReceipt({ hash: h as any, status: TransactionStatus.ACCEPTED, retries: 60, interval: 3000 }));
    adjudicator = r.data?.contract_address as `0x${string}`;
  }
  log("GENLAYER", c.magenta, `Adjudicator ${c.bold}${adjudicator}${c.reset}`);

  const room = LIVE ? await liveRoom(pk, DELIVERABLE_URL) : dryRoom();

  // STEP 1 — open the room
  step(1, "Open the Yellow settlement room");
  const sessionId = await room.open();
  log("YELLOW", c.yellow, `✔ app session ${c.bold}${short(sessionId)}${c.reset} created (3 participants, quorum ${QUORUM})`);
  await room.deposit();
  log("YELLOW", c.yellow, `✔ buyer deposited ${c.bold}${AMOUNT} ${ASSET}${c.reset} into the room (off-chain, no gas per step)`);

  // STEP 2 — seller delivers
  step(2, "Seller submits the deliverable");
  log("SELLER", c.cyan, DELIVERABLE_URL);
  await sleep(600);
  log("BUYER", c.yellow, `${c.bold}Buyer rejects the work → dispute filed${c.reset}`);

  // STEP 3 — GenLayer rules
  step(3, "GenLayer validators rule on the dispute");
  log("GENLAYER", c.magenta, "Leader fetches the page with gl.nondet.web.get (strict_eq evidence)");
  log("GENLAYER", c.magenta, "LLM judges the evidence; validators re-run it (Optimistic Democracy)");
  const tx = await gl.writeContract({ address: adjudicator, functionName: "resolve_dispute", args: [DELIVERABLE_URL, SPEC_RULES], value: 0n });
  await spin("Validators reaching consensus", gl.waitForTransactionReceipt({ hash: tx as any, status: TransactionStatus.ACCEPTED, retries: 120, interval: 3000 }));
  log("GENLAYER", c.green, `✔ consensus reached  tx ${c.dim}${short(tx)}${c.reset}`);

  const count = Number(await gl.readContract({ address: adjudicator, functionName: "get_case_count", args: [] }));
  const ruling = JSON.parse((await gl.readContract({ address: adjudicator, functionName: "get_case", args: [count - 1] })) as string) as Ruling;
  const pct = ruling.seller_percent ?? (ruling.verdict === "PAY_SELLER" ? 100 : 0);
  const sellerAmt = AMOUNT.mul(pct).div(100).toDecimalPlaces(6);
  const buyerAmt = AMOUNT.minus(sellerAmt);

  const color = pct >= 50 ? c.green : c.red;
  console.log(`\n${color}${c.bold}  ┌────────────────────────── RULING ──────────────────────────┐${c.reset}`);
  console.log(`${color}${c.bold}    Seller ${pct}%  ·  Buyer ${100 - pct}%${c.reset}   ${c.gray}confidence${c.reset} ${c.bold}${ruling.confidence}%${c.reset}`);
  console.log(`${c.gray}    ${ruling.reason}${c.reset}`);
  console.log(`${color}${c.bold}  └─────────────────────────────────────────────────────────────┘${c.reset}\n`);

  // STEP 4 — settle on Yellow
  step(4, "Settle the ruling through Yellow");
  log("COURT", c.blue, `court signs the GenLayer ruling; ${pct >= 50 ? "seller" : "buyer"} co-signs → quorum ${QUORUM} met`);
  await room.settle(sellerAmt, buyerAmt, pct >= 50 ? "seller" : "buyer");
  log("YELLOW", c.green, `✔ room closed · seller receives ${c.bold}${sellerAmt} ${ASSET}${c.reset} · buyer receives ${c.bold}${buyerAmt} ${ASSET}${c.reset}`);
  log("DONE", c.green, `${c.bold}Judged settlement complete.${c.reset} Internet Court ✚ GenLayer ✚ Yellow\n`);
}

main().catch((err: unknown) => {
  console.error(`\n${c.red}${c.bold}✖ Demo failed:${c.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
