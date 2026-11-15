# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
AgentCourtAdjudicator v2 — GenLayer Intelligent Contract

Every case is bound to:
  * an escrow identifier (the Yellow app session id),
  * the buyer and seller addresses (the Yellow participants; same key = same address),
  * the agreed rules, the amount and the asset — proposed by the buyer and accepted
    byte-for-byte by the seller before any work can be submitted or disputed.

State machine (one ruling per escrow, no re-rolls):
  OPEN --accept_terms(seller)--> AGREED --[fund_escrow(buyer), GEN only]--> FUNDED
  AGREED|FUNDED --submit_deliverable(seller)--> SUBMITTED
  SUBMITTED --raise_dispute(buyer)--> RULED   (validators rule on every agreed rule)
  SUBMITTED --approve(buyer)-------> RULED   (buyer accepts: seller gets 100%)
  RULED --settle(anyone), GEN only--> SETTLED (the contract pays the split in GEN)

Two payment rails, one ruling:
  * asset "GEN": the buyer locks the agreed amount in this contract (payable fund_escrow). After
    the ruling, settle() pays the seller and the buyer in GEN, on GenLayer, with exact integer
    arithmetic: seller = amount * seller_percent // 100, buyer = the remainder.
  * any other asset (for example usdc): the funds live in the Yellow session whose id is the
    escrow id, and the settlement script applies the same stored percentage through Yellow.

Consensus-bound split:
  Validators must agree on a pass/fail result for EACH agreed rule. The seller's share is then
  computed by plain arithmetic from that agreed list:
      seller_percent = round(100 * rules_passed / rules_total)
  so the split is a pure function of what validators agreed on, not a free-form LLM number.
  The settlement script applies exactly this stored percentage.
"""

import json
import re

from genlayer import *

MAX_RULES = 8
MAX_RULE_CHARS = 400
MAX_PROOF_CHARS = 6000
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:\-]{3,80}$")
AMOUNT_PATTERN = re.compile(r"^[0-9]{1,12}(\.[0-9]{1,6})?$")
ASSET_PATTERN = re.compile(r"^[A-Za-z0-9_\-]{1,20}$")

STATE_OPEN = "OPEN"
STATE_AGREED = "AGREED"
STATE_FUNDED = "FUNDED"
STATE_SUBMITTED = "SUBMITTED"
STATE_RULED = "RULED"
STATE_SETTLED = "SETTLED"
STATE_CANCELLED = "CANCELLED"

ASSET_GEN = "GEN"
WEI_PER_GEN = 10**18


# ---------------------------------------------------------------------------
# Pure helpers (deterministic; unit-tested in tests/test_adjudicator.py)
# ---------------------------------------------------------------------------
def normalize(text: str) -> str:
    """Collapse whitespace and cap length so every validator sees identical evidence."""
    return re.sub(r"\s+", " ", text).strip()[:MAX_PROOF_CHARS]


def parse_rules(rules_json: str) -> list:
    """Agreed rules are a JSON list of 1..MAX_RULES non-empty strings."""
    try:
        data = json.loads(rules_json)
    except Exception:
        raise Exception("rules_json must be a JSON list of strings")
    if not isinstance(data, list) or not (1 <= len(data) <= MAX_RULES):
        raise Exception("rules must be a list of 1 to " + str(MAX_RULES) + " rules")
    rules = []
    for item in data:
        if not isinstance(item, str):
            raise Exception("every rule must be a string")
        rule = re.sub(r"\s+", " ", item).strip()
        if len(rule) == 0 or len(rule) > MAX_RULE_CHARS:
            raise Exception("each rule must be 1 to " + str(MAX_RULE_CHARS) + " characters")
        rules.append(rule)
    return rules


def canonical_rules(rules: list) -> str:
    """One canonical text for a rule list, so buyer and seller can prove they agreed on the same one."""
    return json.dumps(rules, separators=(",", ":"), ensure_ascii=True)


def split_percent(passed: int, total: int) -> int:
    """Seller share, a pure function of the agreed rule results (round half up)."""
    return (100 * passed + total // 2) // total


def verdict_label(seller_percent: int) -> str:
    if seller_percent >= 100:
        return "PAY_SELLER"
    if seller_percent <= 0:
        return "REFUND_BUYER"
    return "SPLIT"


def to_wei(amount: str) -> int:
    """Agreed decimal GEN amount (max 6 decimals) to wei, exactly."""
    whole, _, frac = amount.partition(".")
    return int(whole) * WEI_PER_GEN + int((frac + "0" * 18)[:18])


def split_wei(total_wei: int, seller_percent: int) -> list:
    """[seller, buyer] in wei. Seller is rounded down; the buyer gets the remainder, so nothing is lost."""
    seller = total_wei * seller_percent // 100
    return [seller, total_wei - seller]


def parse_rule_results(raw: str, count: int) -> dict:
    """
    Parse the LLM output into one pass/fail per rule.
    Unusable output fails every rule (fail-safe: no payout without clear evidence).
    """
    fail_safe = {
        "passed": [False] * count,
        "reasons": ["Unparseable evaluation; rule treated as not met."] * count,
    }
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    try:
        data = json.loads(match.group(0)) if match else {}
        results = data["results"]
    except Exception:
        return fail_safe
    if not isinstance(results, list) or len(results) != count:
        return fail_safe
    passed = []
    reasons = []
    for item in results:
        if not isinstance(item, dict) or not isinstance(item.get("passed"), bool):
            return fail_safe
        passed.append(item["passed"])
        reasons.append(str(item.get("reason", "")).strip()[:200])
    return {"passed": passed, "reasons": reasons}


def build_ruling(passed: list, reasons: list, source: str) -> dict:
    total = len(passed)
    count = sum(1 for p in passed if p)
    percent = split_percent(count, total)
    return {
        "source": source,
        "rules_passed": count,
        "rules_total": total,
        "rule_results": passed,
        "rule_reasons": reasons,
        "seller_percent": percent,
        "verdict": verdict_label(percent),
    }


# Native GEN is paid out to plain addresses through the EVM contract interface.
@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------
class AgentCourtAdjudicator(gl.Contract):
    owner: Address
    escrow_count: u256
    escrow_index: TreeMap[u256, str]  # position -> escrow_id (for listing)
    escrows: TreeMap[str, str]  # escrow_id -> JSON record

    def __init__(self):
        self.owner = gl.message.sender_address
        self.escrow_count = u256(0)

    # -- internal ---------------------------------------------------------
    def _load(self, escrow_id: str) -> dict:
        if escrow_id not in self.escrows:
            raise Exception("unknown escrow_id")
        return json.loads(self.escrows[escrow_id])

    def _save(self, escrow_id: str, record: dict) -> None:
        self.escrows[escrow_id] = json.dumps(record, sort_keys=True)

    # -- 1. buyer proposes the terms --------------------------------------
    @gl.public.write
    def open_escrow(self, escrow_id: str, seller: str, rules_json: str, amount: str, asset: str) -> str:
        """Buyer opens a case bound to an escrow id (the Yellow app session id), the seller's
        address, the agreed rules, the amount and the asset."""
        if not ID_PATTERN.match(escrow_id):
            raise Exception("escrow_id must be 3-80 characters: letters, digits, _ . : -")
        if escrow_id in self.escrows:
            raise Exception("escrow_id already exists")
        rules = parse_rules(rules_json)
        if not AMOUNT_PATTERN.match(amount) or float(amount) <= 0:
            raise Exception("amount must be a positive decimal with at most 6 decimals")
        if not ASSET_PATTERN.match(asset):
            raise Exception("invalid asset")
        buyer = str(gl.message.sender_address)
        seller_address = str(Address(seller))
        if seller_address == buyer:
            raise Exception("buyer and seller must be different addresses")

        record = {
            "escrow_id": escrow_id,
            "buyer": buyer,
            "seller": seller_address,
            "rules": rules,
            "amount": amount,
            "asset": asset,
            "state": STATE_OPEN,
            "deliverable_url": "",
            "ruling": {},
            "funded_wei": "0",
            "payout": {},
        }
        self._save(escrow_id, record)
        self.escrow_index[self.escrow_count] = escrow_id
        self.escrow_count = u256(int(self.escrow_count) + 1)
        return STATE_OPEN

    # -- 2. seller accepts exactly the same terms -------------------------
    @gl.public.write
    def accept_terms(self, escrow_id: str, rules_json: str, amount: str, asset: str) -> str:
        """Seller proves agreement by submitting the same rules, amount and asset the buyer proposed."""
        record = self._load(escrow_id)
        if record["state"] != STATE_OPEN:
            raise Exception("terms already accepted or case closed")
        if str(gl.message.sender_address) != record["seller"]:
            raise Exception("only the seller can accept the terms")
        if canonical_rules(parse_rules(rules_json)) != canonical_rules(record["rules"]):
            raise Exception("rules differ from the buyer's proposal")
        if amount != record["amount"] or asset != record["asset"]:
            raise Exception("amount or asset differ from the buyer's proposal")
        record["state"] = STATE_AGREED
        self._save(escrow_id, record)
        return STATE_AGREED

    # -- 3. seller delivers ------------------------------------------------
    @gl.public.write
    def submit_deliverable(self, escrow_id: str, deliverable_url: str) -> str:
        record = self._load(escrow_id)
        needed = STATE_FUNDED if record["asset"] == ASSET_GEN else STATE_AGREED
        if record["state"] != needed:
            if record["asset"] == ASSET_GEN:
                raise Exception("the buyer must fund the escrow in GEN before delivery")
            raise Exception("both parties must agree on the terms first")
        if str(gl.message.sender_address) != record["seller"]:
            raise Exception("only the seller can submit the deliverable")
        if not deliverable_url.startswith(("http://", "https://")):
            raise Exception("deliverable_url must be a public http(s) URL")
        record["deliverable_url"] = deliverable_url
        record["state"] = STATE_SUBMITTED
        self._save(escrow_id, record)
        return STATE_SUBMITTED

    # -- 4a. buyer is satisfied -------------------------------------------
    @gl.public.write
    def approve(self, escrow_id: str) -> str:
        record = self._load(escrow_id)
        if record["state"] != STATE_SUBMITTED:
            raise Exception("nothing to approve yet")
        if str(gl.message.sender_address) != record["buyer"]:
            raise Exception("only the buyer can approve")
        count = len(record["rules"])
        record["ruling"] = build_ruling([True] * count, ["Approved by the buyer."] * count, "BUYER_APPROVAL")
        record["state"] = STATE_RULED
        self._save(escrow_id, record)
        return json.dumps(record["ruling"], sort_keys=True)

    # -- 4b. buyer disputes: validators rule on every agreed rule ---------
    @gl.public.write
    def raise_dispute(self, escrow_id: str) -> str:
        record = self._load(escrow_id)
        if record["state"] != STATE_SUBMITTED:
            raise Exception("no submitted deliverable to dispute (or already ruled)")
        if str(gl.message.sender_address) != record["buyer"]:
            raise Exception("only the buyer can raise a dispute")

        url = record["deliverable_url"]
        rules = record["rules"]
        count = len(rules)

        # Evidence: every validator must fetch identical, normalized proof (strict_eq)
        def fetch_proof() -> str:
            response = gl.nondet.web.get(url)
            if response.status >= 400:
                return "FETCH_ERROR status=" + str(response.status)
            return normalize(response.body.decode("utf-8", errors="replace"))

        proof = gl.eq_principle.strict_eq(fetch_proof)

        if proof.startswith("FETCH_ERROR"):
            # Deterministic: unreachable evidence fails every rule, no LLM involved.
            passed = [False] * count
            reasons = ["Deliverable unreachable (" + proof + ")."] * count
        else:
            numbered = "\n".join(str(i + 1) + ". " + rule for i, rule in enumerate(rules))
            prompt = f"""You are an impartial arbitrator. Check the deliverable against each agreed rule separately.

AGREED RULES:
{numbered}

DELIVERABLE EVIDENCE (from {url}):
\"\"\"{proof}\"\"\"

For EACH rule, in order, decide whether the evidence satisfies it. Missing or unclear evidence means NOT satisfied.
Respond with ONLY a JSON object, no markdown, with exactly {count} entries:
{{"results": [{{"passed": true or false, "reason": "<one short sentence>"}}]}}"""

            def judge() -> str:
                raw = gl.nondet.exec_prompt(prompt)
                return json.dumps(parse_rule_results(raw, count), sort_keys=True)

            # Validators re-run the judgment (Optimistic Democracy) and must agree on the
            # pass/fail result of every single rule. Wording of reasons may differ.
            agreed_json = gl.eq_principle.prompt_comparative(
                judge,
                "The 'passed' list must be identical, element by element. The 'reasons' may differ in wording but not in meaning.",
            )
            agreed = json.loads(agreed_json)
            passed = agreed["passed"]
            reasons = agreed["reasons"]

        record["ruling"] = build_ruling(passed, reasons, "VALIDATORS")
        record["state"] = STATE_RULED
        self._save(escrow_id, record)
        return json.dumps(record["ruling"], sort_keys=True)

    # -- GEN rail: lock, settle, cancel -------------------------------------
    @gl.public.write.payable
    def fund_escrow(self, escrow_id: str) -> str:
        """Buyer locks exactly the agreed amount in GEN inside this contract."""
        record = self._load(escrow_id)
        if record["asset"] != ASSET_GEN:
            raise Exception("only GEN escrows are funded here; other assets settle through Yellow")
        if record["state"] != STATE_AGREED:
            raise Exception("both parties must agree on the terms before funding")
        if str(gl.message.sender_address) != record["buyer"]:
            raise Exception("only the buyer can fund the escrow")
        expected = to_wei(record["amount"])
        if int(gl.message.value) != expected:
            raise Exception("value must equal the agreed amount in wei: " + str(expected))
        record["funded_wei"] = str(expected)
        record["state"] = STATE_FUNDED
        self._save(escrow_id, record)
        return STATE_FUNDED

    @gl.public.write
    def settle(self, escrow_id: str) -> str:
        """Pay out a ruled GEN escrow. Anyone may call it; it can only pay the recorded seller and
        buyer, exactly once, using the stored seller_percent."""
        record = self._load(escrow_id)
        if record["asset"] != ASSET_GEN:
            raise Exception("this escrow settles through Yellow")
        if record["state"] != STATE_RULED:
            raise Exception("no ruling to settle (or already settled)")
        total = int(record["funded_wei"])
        seller_wei, buyer_wei = split_wei(total, record["ruling"]["seller_percent"])
        if int(self.balance) < total:
            raise Exception("contract balance is lower than the locked amount")
        record["state"] = STATE_SETTLED  # state first, transfers after: no double payout
        record["payout"] = {"seller_wei": str(seller_wei), "buyer_wei": str(buyer_wei)}
        self._save(escrow_id, record)
        if seller_wei > 0:
            _Recipient(Address(record["seller"])).emit_transfer(value=u256(seller_wei))
        if buyer_wei > 0:
            _Recipient(Address(record["buyer"])).emit_transfer(value=u256(buyer_wei))
        return json.dumps(record["payout"], sort_keys=True)

    @gl.public.write
    def cancel(self, escrow_id: str) -> str:
        """Buyer may cancel before anything is locked. Once GEN is locked, only the seller can
        release it back to the buyer (waive the job) before delivering."""
        record = self._load(escrow_id)
        sender = str(gl.message.sender_address)
        if record["state"] in (STATE_OPEN, STATE_AGREED) and sender == record["buyer"]:
            record["state"] = STATE_CANCELLED
            self._save(escrow_id, record)
            return STATE_CANCELLED
        if record["state"] == STATE_FUNDED and sender == record["seller"]:
            total = int(record["funded_wei"])
            if int(self.balance) < total:
                raise Exception("contract balance is lower than the locked amount")
            record["state"] = STATE_SETTLED
            record["payout"] = {"seller_wei": "0", "buyer_wei": str(total)}
            self._save(escrow_id, record)
            _Recipient(Address(record["buyer"])).emit_transfer(value=u256(total))
            return STATE_SETTLED
        raise Exception("cancel not allowed for this caller in this state")

    # -- views --------------------------------------------------------------
    @gl.public.view
    def get_escrow(self, escrow_id: str) -> str:
        """Full JSON record for an escrow ('' if it does not exist)."""
        if escrow_id not in self.escrows:
            return ""
        return self.escrows[escrow_id]

    @gl.public.view
    def get_escrow_count(self) -> int:
        return int(self.escrow_count)

    @gl.public.view
    def get_escrow_id_at(self, index: int) -> str:
        key = u256(index)
        if key not in self.escrow_index:
            return ""
        return self.escrow_index[key]

    @gl.public.view
    def get_owner(self) -> str:
        return str(self.owner)
