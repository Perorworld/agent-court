"""
Repository consistency check: the documented flow, the scripts and the contract must agree.

Run from the repository root:   python3 tests/check_repo.py

It fails if
  * a file the docs or package.json point to is missing (for example the contract),
  * any file still uses the retired flow (get_case / resolve_dispute / --case),
  * settle.ts does not settle from the stored escrow record (parties, amount, escrow id),
  * the deployed contract address differs between the page, .env.example and VERIFY.md.
"""
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "__pycache__", "out", "cache"}
errors = []


def fail(msg):
    errors.append(msg)


def files(suffixes=(".md", ".ts", ".py", ".json", ".html", ".txt", ".example")):
    for p in ROOT.rglob("*"):
        if p.is_file() and not (set(p.relative_to(ROOT).parts) & SKIP_DIRS) and (p.suffix in suffixes or p.name == ".env.example"):
            yield p


def text(rel):
    p = ROOT / rel
    return p.read_text(encoding="utf-8") if p.exists() else ""


# 1) Required files exist
REQUIRED = [
    "contracts/agent_court_adjudicator.py", "tests/test_adjudicator.py",
    "scripts/settle.ts", "scripts/gen_settlement.ts", "scripts/yellow_settlement.ts",
    "scripts/lib/court.ts", "scripts/lib/yellow_room.ts",
    "package.json", "README.md", "VERIFY.md", "demo/deliverable.md", "index.html",
]
for rel in REQUIRED:
    if not (ROOT / rel).exists():
        fail(f"missing required file: {rel}")

# 2) The contract has the escrow-bound API
contract = text("contracts/agent_court_adjudicator.py")
for fn in ["open_escrow", "accept_terms", "fund_escrow", "submit_deliverable", "approve", "raise_dispute", "settle", "cancel", "get_escrow"]:
    if contract and f"def {fn}(" not in contract:
        fail(f"contract is missing method {fn}()")

# 3) No file may still use the retired flow
RETIRED = ["get_case", "resolve_dispute", "--case"]
for p in files():
    rel = p.relative_to(ROOT).as_posix()
    if rel == "tests/check_repo.py":
        continue
    body = p.read_text(encoding="utf-8", errors="ignore")
    for word in RETIRED:
        if word in body:
            fail(f"{rel} still uses the retired flow ('{word}')")

# 4) settle.ts settles from the stored escrow record
settle = text("scripts/settle.ts")
if settle:
    for needle, why in [
        ("readEscrow(", "reads the escrow record by id"),
        ("--escrow", "takes the escrow id"),
        ("rec.amount", "uses the stored amount"),
        ("rec.buyer", "checks the stored buyer"),
        ("rec.seller", "checks the stored seller"),
        ("liveRoom(pk, rec.deliverable_url, escrowId)", "attaches to the existing session with the stored escrow id"),
    ]:
        if needle not in settle:
            fail(f"scripts/settle.ts does not use the stored record: missing {needle} ({why})")
    if "createAppSession" in settle:
        fail("scripts/settle.ts opens a new Yellow session; it must attach to the escrow's own session")

# 5) package.json scripts point at files that exist
try:
    pkg = json.loads(text("package.json"))
    for name, cmd in pkg.get("scripts", {}).items():
        for rel in re.findall(r"(?:tsx|python3)\s+([\w./-]+)", cmd):
            if not (ROOT / rel).exists():
                fail(f"package.json script '{name}' runs a missing file: {rel}")
except Exception as e:
    fail(f"package.json is unreadable: {e}")

# 6) Every repo path mentioned in the docs exists
EXT = r"(?:py|ts|md|json|html|svg)"
for doc in ["README.md", "VERIFY.md", "skills/internet_court_yellow_genlayer_skill.md"]:
    for path in set(re.findall(rf"`((?:[\w.-]+/)+[\w.-]+\.{EXT})`", text(doc))):
        if path.startswith("http") or path.startswith("$"):
            continue
        if not (ROOT / path).exists() and not (ROOT / "web" / path).exists():
            fail(f"{doc} points to a path that does not exist: {path}")

# 7) One contract address everywhere
ADDR = re.compile(r"0x[0-9a-fA-F]{40}")
found = {}
for rel, pattern in [
    ("index.html", r'DEFAULT_CONTRACT\s*=\s*"(0x[0-9a-fA-F]{40})"'),
    ("web/index.html", r'DEFAULT_CONTRACT\s*=\s*"(0x[0-9a-fA-F]{40})"'),
    (".env.example", r"ADJUDICATOR_ADDRESS=(0x[0-9a-fA-F]{40})"),
    ("VERIFY.md", r"Contract on GenLayer Studio:\s*`(0x[0-9a-fA-F]{40})`"),
]:
    m = re.search(pattern, text(rel))
    if m:
        found[rel] = m.group(1)
if len(set(found.values())) > 1:
    fail("contract address differs between files: " + ", ".join(f"{k}={v}" for k, v in found.items()))

if errors:
    print("REPOSITORY CHECK FAILED")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print(f"Repository check passed ({len(REQUIRED)} required files, escrow-bound flow only, one contract address: {next(iter(set(found.values())), 'n/a')}).")
