/**
 * Shared GenLayer helpers for the Judged Settlement Room scripts.
 * Everything here talks to the escrow-bound AgentCourtAdjudicator (contracts/agent_court_adjudicator.py).
 */
import "dotenv/config";
import { createClient, createAccount } from "genlayer-js";
import { studionet, localnet } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { Decimal } from "decimal.js";

export type Hex = `0x${string}`;

const env = process.env;
export const NETWORK = env.GENLAYER_NETWORK ?? "studionet";
const CHAIN = NETWORK === "localnet" ? localnet : studionet;

/** What validators agreed on: one pass/fail per agreed rule. seller_percent is derived from it by the contract. */
export interface Ruling {
  source: "VALIDATORS" | "BUYER_APPROVAL";
  rules_passed: number;
  rules_total: number;
  rule_results: boolean[];
  rule_reasons: string[];
  seller_percent: number;
  verdict: "PAY_SELLER" | "REFUND_BUYER" | "SPLIT";
}

export interface EscrowRecord {
  escrow_id: string;
  buyer: string;
  seller: string;
  rules: string[];
  amount: string;
  asset: string;
  state: "OPEN" | "AGREED" | "FUNDED" | "SUBMITTED" | "RULED" | "SETTLED" | "CANCELLED";
  deliverable_url: string;
  ruling: Ruling | Record<string, never>;
  /** GEN escrows only: wei locked in the contract, and the exact payout once settled. */
  funded_wei: string;
  payout: { seller_wei: string; buyer_wei: string } | Record<string, never>;
}

export type GlClient = ReturnType<typeof createClient>;

/** GenLayer client for one party. The address of a key is identical on GenLayer and as a Yellow wallet. */
export async function glClient(pk: Hex): Promise<GlClient> {
  const client = createClient({ chain: CHAIN, account: createAccount(pk) });
  if (NETWORK === "studionet") {
    try { await client.initializeConsensusSmartContract(); } catch { /* already initialized */ }
  }
  return client;
}

/** Send a write transaction and wait until validators accepted it. Returns the tx hash. */
export async function send(client: GlClient, address: Hex, functionName: string, args: unknown[], valueWei = 0n): Promise<string> {
  const hash = await client.writeContract({ address, functionName, args: args as never, value: valueWei });
  await client.waitForTransactionReceipt({ hash: hash as any, status: TransactionStatus.ACCEPTED, retries: 120, interval: 3000 });
  return hash as string;
}

export async function readEscrow(client: GlClient, address: Hex, escrowId: string): Promise<EscrowRecord | null> {
  const raw = (await client.readContract({ address, functionName: "get_escrow", args: [escrowId] })) as string;
  return raw ? (JSON.parse(raw) as EscrowRecord) : null;
}

export function adjudicatorAddress(): Hex | undefined {
  const a = env.ADJUDICATOR_ADDRESS?.trim();
  return a ? (a as Hex) : undefined;
}

/**
 * Turn the stored, consensus-derived seller_percent into exact amounts.
 * Seller is rounded DOWN at 6 decimals and the buyer gets the remainder, so nothing is created or lost.
 */
export function splitAmounts(amount: Decimal, sellerPercent: number): { seller: Decimal; buyer: Decimal } {
  if (!Number.isInteger(sellerPercent) || sellerPercent < 0 || sellerPercent > 100) {
    throw new Error(`Invalid seller_percent ${sellerPercent}`);
  }
  const seller = amount.mul(sellerPercent).div(100).toDecimalPlaces(6, Decimal.ROUND_DOWN);
  const buyer = amount.minus(seller);
  if (!seller.plus(buyer).eq(amount)) throw new Error("Allocation does not add up to the escrow amount");
  return { seller, buyer };
}

/** Throws unless the record is a finished, validator- or buyer-decided ruling. */
export function requireRuling(rec: EscrowRecord | null, escrowId: string): asserts rec is EscrowRecord & { ruling: Ruling } {
  if (!rec) throw new Error(`Escrow ${escrowId} not found on this contract.`);
  if (rec.state !== "RULED") throw new Error(`Escrow ${escrowId} is ${rec.state}, not RULED yet. Nothing to settle.`);
  if (rec.escrow_id !== escrowId) throw new Error("Escrow id mismatch in the stored record.");
}

/** Decimal GEN (max 18 decimals) to wei, exactly. */
export function toWei(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
}

/** Wei to a decimal GEN string without trailing zeros. */
export function fromWei(wei: string | bigint): string {
  const w = BigInt(wei);
  const whole = w / 10n ** 18n;
  const frac = (w % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
