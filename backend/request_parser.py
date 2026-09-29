"""Supply-request detection for Live Feed messages.

Crew post things like "I need 6 more turnbuckles" or "can we get another
shovel out here" in the Live Feed. This module turns that free text into
structured (qty, item) requests so the API can queue them for admin approval.

Deliberately deterministic and conservative: a missed request costs one manual
entry, but a false positive puts noise in an approval queue, so we only fire on
explicit first-person asks ("I/we need", "can we get", "send us", "we're out
of", or a bare leading "need ..."). No Mongo, no network — the API layer
supplies the equipment catalog for best-effort matching.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable, Optional

NUMBER_WORDS = {
    "a": 1, "an": 1, "another": 1, "one": 1, "two": 2, "three": 3, "four": 4,
    "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "thirty": 30,
    "forty": 40, "fifty": 50, "dozen": 12, "couple": 2, "pair": 2, "few": 3,
}

# Explicit asks only. Each pattern captures everything after the ask verb as
# the "rest" of the clause, which is then split into (qty, item) chunks.
TRIGGERS = [
    r"\b(?:i|we)(?:'ll| will| still| really| gonna| are going to| also)?\s+(?:need|needs)\b",
    r"\b(?:i|we)(?:'m| am|'re| are)\s+(?:gonna|going to)\s+need\b",
    r"\b(?:i|we)\s+(?:could|could really|can)\s+use\b",
    r"\b(?:i|we)\s+(?:gotta|have to|got to)\s+(?:have|get)\b",
    r"\b(?:can|could)\s+(?:i|we|you|someone|somebody)\s+(?:please\s+)?(?:get|grab|bring|send|order)(?:\s+(?:me|us))?(?:\s+out)?\b",
    r"\b(?:please\s+)?(?:send|bring)\s+(?:me|us)(?:\s+out)?\b",
    r"\b(?:i|we)(?:'re| are)\s+(?:out of|short(?: on)?|low on|running low on|running out of)\b",
    r"^\s*(?:(?:i'm|we're|im|were)\s+)?gonna\s+need\b",
    r"\bneed\s+(?:is|are)?\b",  # bare "need 6 more ..." — only honored at clause start, see below
]
TRIGGER_RE = re.compile("|".join(f"(?:{pattern})" for pattern in TRIGGERS), re.IGNORECASE)
BARE_NEED_RE = re.compile(r"^\s*(?:(?:hey|yo|ok|okay|also|and|so|guys|team)[,\s]+)*need\b", re.IGNORECASE)

SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?;\n])\s*|\s+-\s+")
ITEM_SPLIT_RE = re.compile(r"\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s+plus\s+")

QTY_RE = re.compile(
    r"^(?:like\s+|about\s+|maybe\s+|at least\s+|around\s+|another\s+(?=\d))?"
    r"(?P<qty>\d{1,4}|a couple(?: of)?|a few|a dozen|a pair of|"
    + "|".join(sorted((word for word in NUMBER_WORDS if word not in {"couple", "few", "dozen", "pair"}), key=len, reverse=True))
    + r")\b(?![/\"'\u2019.-])\s*",
    re.IGNORECASE,
)
MORE_RE = re.compile(r"^(?:another|one more|more|extra|additional|new|spare|replacement|of the|of those|of them|of)\b\s*", re.IGNORECASE)
LEADING_FILLER_RE = re.compile(r"^(?:some|any|the|more|extra|additional|new|spare|us|me|out|like|please)\b\s*", re.IGNORECASE)
# Anything after one of these is context (where/when/why), not part of the item.
TRAILING_CUT_RE = re.compile(
    r"\s+(?:for|at|to|on|by|from|out at|over at|in|asap|please|pls|today|tomorrow|tonight|"
    r"this|next|before|when|if|because|cause|cuz|since|so|thanks|thx|here|there|right|real quick|"
    r"please|too|also|as well|or so|or something|if possible|out here|out there)\b.*$",
    re.IGNORECASE,
)
TRAILING_PUNCT_RE = re.compile(r"[\s.,!?:;)\-'\"]+$")

# "I need to leave", "we need help", "I need you to…" — not supply requests.
NON_ITEM_STARTS = {
    "to", "help", "a hand", "you", "someone", "somebody", "a minute", "a sec", "a second",
    "a break", "a ride", "time", "more time", "an answer", "an update", "it", "that", "this",
    "them", "those", "these", "him", "her", "everyone", "everybody", "anything", "nothing",
    "something", "a call", "a callback", "info", "information", "confirmation", "approval",
    "the address", "directions", "a lift", "lunch", "water", "gas", "a day", "a week", "a few minutes",
    "more info", "an eta", "eta", "the day off", "off", "done", "back",
}
NON_ITEM_WORDS = {
    "to", "you", "him", "her", "them", "someone", "help", "it", "minute", "minutes",
    "second", "sec", "break", "ride", "hand", "day", "week", "hour", "hours",
}
MAX_ITEM_WORDS = 6


@dataclass(frozen=True)
class ParsedRequest:
    item_name: str
    qty: int
    phrase: str


def _qty_value(token: str) -> int:
    token = token.lower().strip()
    if token.isdigit():
        return int(token)
    if token.startswith("a couple"):
        return 2
    if token == "a few":
        return 3
    if token == "a dozen":
        return 12
    if token == "a pair of":
        return 2
    return NUMBER_WORDS.get(token, 1)


def _clean_item(text: str) -> str:
    item = TRAILING_CUT_RE.sub("", text.strip())
    item = TRAILING_PUNCT_RE.sub("", item)
    for _ in range(3):
        stripped = LEADING_FILLER_RE.sub("", item)
        if stripped == item:
            break
        item = stripped
    item = re.sub(r"\s+", " ", item).strip(" .,!?:;-'\"")
    return item


def _parse_chunk(chunk: str, default_qty: Optional[int]) -> Optional[tuple[int, str]]:
    chunk = chunk.strip()
    if not chunk:
        return None
    lowered_chunk = _clean_item(chunk).lower()
    if any(lowered_chunk == start or lowered_chunk.startswith(start + " ") for start in NON_ITEM_STARTS):
        return None
    qty = default_qty
    match = QTY_RE.match(chunk)
    if match:
        qty = _qty_value(match.group("qty"))
        chunk = chunk[match.end():]
    chunk = MORE_RE.sub("", chunk)
    item = _clean_item(chunk)
    if not item:
        return None
    lowered = item.lower()
    if any(lowered == start or lowered.startswith(start + " ") for start in NON_ITEM_STARTS):
        return None
    words = lowered.split()
    if words[0] in NON_ITEM_WORDS or len(words) > MAX_ITEM_WORDS:
        return None
    # A lone digit sequence or mention isn't an item.
    if not re.search(r"[a-z]", lowered) or lowered.startswith("@"):
        return None
    return (qty or 1), item


def parse_supply_requests(text: str) -> list[ParsedRequest]:
    """Return every explicit supply ask in `text`, de-duplicated by item."""
    results: list[ParsedRequest] = []
    seen: set[str] = set()
    body = re.sub(r"@[\w.-]+", " ", text or "")
    for sentence in SENTENCE_SPLIT_RE.split(body):
        sentence = sentence.strip()
        if not sentence or sentence.endswith("?") and not re.search(r"\b(?:can|could)\s+(?:i|we|you|someone|somebody)\b", sentence, re.IGNORECASE):
            # Questions are usually asks *about* things ("do we need shovels?"),
            # except polite requests ("can we get 4 more clips?").
            continue
        match = None
        for candidate in TRIGGER_RE.finditer(sentence):
            if candidate.group(0).lower().startswith("need") and not BARE_NEED_RE.match(sentence[: candidate.end()]):
                continue
            match = candidate
            break
        if not match:
            continue
        rest = sentence[match.end():]
        for chunk in ITEM_SPLIT_RE.split(rest):
            parsed = _parse_chunk(chunk, None)
            if not parsed:
                continue
            qty, item = parsed
            key = item.lower()
            if key in seen:
                continue
            seen.add(key)
            results.append(ParsedRequest(item_name=item, qty=qty, phrase=sentence.strip()))
    return results


# --------------------------- catalog matching ------------------------------
def _singular(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return word[:-3] + "y"
    if len(word) > 3 and word.endswith(("ches", "shes", "xes", "sses")):
        return word[:-2]
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _tokens(value: str) -> list[str]:
    return [_singular(token) for token in re.findall(r"[a-z0-9]+", (value or "").lower())]


def match_equipment(item_name: str, catalog: Iterable[dict]) -> Optional[dict]:
    """Best-effort link to an equipment record: every token of the requested
    item must appear in the record's name/sku/category tokens. Returns the
    record only when exactly one name family matches, so "turnbuckles" (many
    turnbuckle SKUs) stays unlinked while "chop saw" links cleanly."""
    wanted = set(_tokens(item_name))
    if not wanted:
        return None
    hits: list[dict] = []
    for record in catalog:
        haystack = set(_tokens(record.get("name", ""))) | set(_tokens(record.get("sku", ""))) | set(_tokens((record.get("category") or "").replace("_", " ")))
        if wanted <= haystack:
            hits.append(record)
    names = {(hit.get("name") or "").strip().lower() for hit in hits}
    if len(names) == 1:
        return hits[0]
    return None
