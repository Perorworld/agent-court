# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json
import re

from genlayer import *

MAX_PROOF_CHARS = 6000
VALID_VERDICTS = ("PAY_SELLER", "REFUND_BUYER")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:MAX_PROOF_CHARS]


def parse_verdict(raw: str) -> dict:
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    try:
        data = json.loads(match.group(0)) if match else {}
    except Exception:
        data = {}
    verdict = str(data.get("verdict", "")).strip().upper()
    if verdict not in VALID_VERDICTS:
        return {
            "verdict": "REFUND_BUYER",
            "confidence": 0,
            "reason": "Unparseable evaluation; defaulting to buyer refund.",
        }
    try:
        confidence = max(0, min(100, int(data.get("confidence", 0))))
    except Exception:
        confidence = 0
    return {
        "verdict": verdict,
        "confidence": confidence,
        "reason": str(data.get("reason", "")).strip()[:400],
    }


class AgentCourtAdjudicator(gl.Contract):
    owner: Address
    case_count: u256
    cases: TreeMap[u256, str]

    def __init__(self):
        self.owner = gl.message.sender_address
        self.case_count = u256(0)

    @gl.public.write
    def resolve_dispute(self, deliverable_url: str, spec_rules: str) -> str:
        if not deliverable_url.startswith(("http://", "https://")):
            raise Exception("deliverable_url must be a public http(s) URL")
        if len(spec_rules.strip()) == 0:
            raise Exception("spec_rules must not be empty")

        # Fetch evidence: every validator must see identical proof (strict_eq)
        def fetch_proof() -> str:
            response = gl.nondet.web.get(deliverable_url)
            if response.status >= 400:
                return "FETCH_ERROR status=" + str(response.status)
            return normalize(response.body.decode("utf-8", errors="replace"))

        proof = gl.eq_principle.strict_eq(fetch_proof)

        prompt = f"""You are an impartial arbitrator for an escrow dispute.

ACCEPTANCE RULES:
{spec_rules}

DELIVERABLE EVIDENCE (from {deliverable_url}):
\"\"\"{proof}\"\"\"

If the evidence satisfies ALL rules, verdict is PAY_SELLER.
If evidence is missing, unreachable, or fails any rule, verdict is REFUND_BUYER.

Respond with ONLY a JSON object, no markdown:
{{"verdict": "PAY_SELLER" or "REFUND_BUYER", "confidence": <integer 0-100>, "reason": "<one or two sentences>"}}"""

        # LLM judgment: validators re-run it and compare (Optimistic Democracy)
        def judge() -> str:
            raw = gl.nondet.exec_prompt(prompt)
            return json.dumps(parse_verdict(raw), sort_keys=True)

        result_json = gl.eq_principle.prompt_comparative(
            judge,
            "The verdict field must be identical. Confidence may differ by at most 10 points. Reason may differ in wording but not meaning.",
        )
        result = json.loads(result_json)

        case_id = self.case_count
        record = {
            "case_id": int(case_id),
            "requester": str(gl.message.sender_address),
            "deliverable_url": deliverable_url,
            "spec_rules": spec_rules,
            "verdict": result["verdict"],
            "confidence": result["confidence"],
            "reason": result["reason"],
        }
        self.cases[case_id] = json.dumps(record, sort_keys=True)
        self.case_count = u256(int(case_id) + 1)
        return result_json

    @gl.public.view
    def get_case(self, case_id: int) -> str:
        key = u256(case_id)
        if key not in self.cases:
            return ""
        return self.cases[key]

    @gl.public.view
    def get_case_count(self) -> int:
        return int(self.case_count)

    @gl.public.view
    def get_owner(self) -> str:
        return str(self.owner)
