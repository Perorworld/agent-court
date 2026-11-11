/**
 * Settle one GenLayer ruling through a Yellow settlement room.
 *
 *   npm run settle -- --case 1
 *
 * Reads case <N> from the AgentCourtAdjudicator on GenLayer, turns its seller_percent into
 * allocations, and settles them in a Yellow app session (open -> deposit -> operate -> close).
 *
 * LIVE   : BUYER_PK, SELLER_PK, COURT_PK set in .env -> real Yellow Nitronode calls.
 * SIMULATED : otherwise. The ruling is still read for real from GenLayer, and the output says
 *             plainly that the Yellow steps are simulated.
 *
 * LOCAL DEMO NOTE: all three keys run in one process. A real deployment signs from separate processes.
 */
import "dotenv/config";
import { createClient, createAccount, generatePrivateKey } from "genlayer-js";
import { studionet, localnet } from "genlayer-js/chains";
import { Decimal } from "decimal.js";
import { privateKeyToAddress, generatePrivateKey as evmKey } from "viem/accounts";
import { LIVE, WS_URL, ASSET, AMOUNT, QUORUM, liveRoom, dryRoom } from "./lib/yellow_room.js";

const env = process.env;
const NETWORK = env.GENLAYER_NETWORK ?? "studionet";
const CHAIN = NETWORK === "localnet" ? localnet : studionet;
const ADJUDICATOR = (env.ADJUDICATOR_ADDRESS || "0xa311d5a6b22e07e0aA112E7c2488eF53271F8498") as `0x${string}`;

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m",
  yellow: "\x1b[33m", magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m" };
const ts = () => `${c.gray}[${new Date().toISOString().slice(11, 23)}]${c.reset}`;
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const log = (tag: string, color: string, msg: string) =>
  console.log(`${ts()} ${color}${c.bold}${tag.padEnd(10)}${c.reset} ${msg}`);

interface CaseRecord {
  case_id: number;
  deliverable_url: string;
  verdict: string;
  seller_percent?: number;
  confidence: number;
  reason: string;
}

/** Read `--case N` (or `--case=N`) from the command line. */
function parseCaseId(argv: string[]): number {
  const i = argv.findIndex((a) => a === "--case" || a.startsWith("--case="));
  const raw = i === -1 ? undefined : argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n < 0) {
    throw new Error("Usage: npm run settle -- --case <number>   (the case number is shown on the Agent Court page)");
  }
  return n;
}

async function main(): Promise<void> {
  const caseId = parseCaseId(process.argv.slice(2));

  console.log(`\n${c.bold}${c.yellow}  ⚖️  SETTLE CASE ${caseId}${c.reset}  ${c.dim}Internet Court × GenLayer × Yellow${c.reset}`);
  log("MODE", c.cyan, LIVE
    ? `${c.bold}LIVE${c.reset} Yellow @ ${WS_URL}`
    : `${c.bold}${c.yellow}SIMULATED${c.reset} Yellow settlement (set BUYER_PK, SELLER_PK, COURT_PK in .env for live)`);

  // 1) Read the ruling from GenLayer (always real)
  const gl = createClient({ chain: CHAIN, account: createAccount(generatePrivateKey()) });
  log("GENLAYER", c.magenta, `Reading case ${caseId} from ${c.bold}${short(ADJUDICATOR)}${c.reset}`);
  const raw = (await gl.readContract({ address: ADJUDICATOR, functionName: "get_case", args: [caseId] })) as string;
  if (!raw) throw new Error(`Case ${caseId} not found on ${ADJUDICATOR}.`);
  const ruling = JSON.parse(raw) as CaseRecord;

  const pct = ruling.seller_percent ?? (ruling.verdict === "PAY_SELLER" ? 100 : 0);
  const sellerAmt = AMOUNT.mul(pct).div(100).toDecimalPlaces(6);
  const buyerAmt = AMOUNT.minus(sellerAmt);
  const color = pct >= 50 ? c.green : c.red;
  log("RULING", color, `${c.bold}Seller ${pct}% · Buyer ${100 - pct}%${c.reset}  confidence ${ruling.confidence}%`);
  log("RULING", c.gray, ruling.reason);

  // 2) Settle through Yellow
  const pk = {
    buyer: (env.BUYER_PK ?? evmKey()) as `0x${string}`,
    seller: (env.SELLER_PK ?? evmKey()) as `0x${string}`,
    court: (env.COURT_PK ?? evmKey()) as `0x${string}`,
  };
  log("ROOM", c.cyan, `buyer ${short(privateKeyToAddress(pk.buyer))}  seller ${short(privateKeyToAddress(pk.seller))}  court ${short(privateKeyToAddress(pk.court))}  quorum ${QUORUM}/3`);

  const room = LIVE ? await liveRoom(pk, ruling.deliverable_url) : dryRoom();
  const sessionId = await room.open();
  log("YELLOW", c.yellow, `${LIVE ? "" : "(simulated) "}app session ${c.bold}${short(sessionId)}${c.reset} opened`);
  await room.deposit();
  log("YELLOW", c.yellow, `${LIVE ? "" : "(simulated) "}buyer deposited ${c.bold}${AMOUNT} ${ASSET}${c.reset}`);
  log("COURT", c.cyan, `court signs the ruling; ${pct >= 50 ? "seller" : "buyer"} co-signs → quorum met`);
  await room.settle(sellerAmt, buyerAmt, pct >= 50 ? "seller" : "buyer");
  log("YELLOW", c.green, `${LIVE ? "" : "(simulated) "}room closed · seller ${c.bold}${sellerAmt} ${ASSET}${c.reset} · buyer ${c.bold}${buyerAmt} ${ASSET}${c.reset}`);
  if (!LIVE) log("NOTE", c.yellow, "Nothing was sent to Yellow. Add funded wallet keys to .env to settle for real.");
  console.log("");
}

main().catch((err: unknown) => {
  console.error(`\n${c.red}${c.bold}✖ Settle failed:${c.reset}`, err instanceof Error ? err.message : err);
  process.exit(1);
});
