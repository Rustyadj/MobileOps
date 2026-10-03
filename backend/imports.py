"""Staged, confirmable data imports from XLSX (and table-based PDF) files.

Flow: parse -> map columns -> validate -> detect duplicates -> persist a *plan* (nothing in
production changes) -> a separate, hash-bound commit applies the plan all-or-nothing.

Safety rules this module enforces:
  * Staging never writes to domain collections; only `import_jobs` / `import_files`.
  * A commit must present the plan hash of the preview a human reviewed, and the plan is
    re-derived from live data first. If anything changed in between, it refuses.
  * Existing records are only touched with an explicit `on_duplicate="update"`, only for
    fields that are safe to edit (never stock buckets), and every change is shown as old->new.
  * Application is all-or-nothing: each write records an undo step and any failure rolls
    the already-applied writes back (MongoDB here has no multi-document transactions).
  * Formula cells, macro workbooks, oversized/zip-bomb files and non-table PDFs are rejected.
"""
from __future__ import annotations

import hashlib
import hmac
import io
import json
import math
import re
import uuid
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterable, Optional

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from documents import record_activity

MAX_FILE_BYTES = 5_000_000
MAX_ROWS = 2000
MAX_COLUMNS = 60
MAX_PDF_PAGES = 40
MAX_UNCOMPRESSED_BYTES = 60_000_000
MAX_ZIP_ENTRIES = 500
JOB_TTL = timedelta(hours=2)  # how long a staged preview can still be committed
JOB_RETENTION = timedelta(days=180)  # import_jobs are audit evidence; purged by TTL index after this
FILE_RETENTION = timedelta(days=30)
PREVIEW_ROWS = 25
PREVIEW_ERRORS = 50
DUPLICATE_POLICIES = ("skip", "update")


class ImportFileError(ValueError):
    """The upload is unusable (bad file, bad mapping, unsupported dataset)."""


class ImportStateError(ValueError):
    """The job can't be committed in its current state (stale, already used, hash mismatch)."""

    def __init__(self, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.status_code = status_code


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


# ----------------------------- field specs ---------------------------------
@dataclass(frozen=True)
class FieldSpec:
    key: str
    aliases: tuple[str, ...] = ()
    kind: str = "str"  # str | int | float | choice
    required: bool = False
    choices: tuple[str, ...] = ()
    minimum: Optional[float] = None
    updatable: bool = True  # may an on_duplicate="update" import change it?
    max_len: int = 200


@dataclass(frozen=True)
class ImportSpec:
    dataset: str
    collection: str
    title: str
    fields: tuple[FieldSpec, ...]
    fixed: tuple[tuple[str, str], ...] = ()  # forced values (e.g. kind=block, category=tool)

    def field(self, key: str) -> FieldSpec:
        return next(f for f in self.fields if f.key == key)

    @property
    def keys(self) -> tuple[str, ...]:
        return tuple(f.key for f in self.fields)


_CONDITIONS = ("good", "fair", "poor", "broken", "damaged")

_EQUIPMENT_FIELDS = (
    FieldSpec("name", ("tool", "item", "equipment", "description", "product name"), required=True),
    FieldSpec("category", ("type", "group", "equipment category"), required=True),
    FieldSpec("qr_code", ("qr", "qr code", "qr tag", "tag", "asset tag", "asset id", "barcode"), updatable=False),
    FieldSpec("sku", ("internal sku", "internal_sku", "item number", "part number", "part #", "sku"), updatable=False),
    FieldSpec("model", ("model number", "model #")),
    FieldSpec("equipment_family", ("family",)),
    FieldSpec("serial_number", ("serial", "serial #", "serial no", "serial number", "s/n"), updatable=False),
    FieldSpec("condition", ("status condition", "state"), kind="choice", choices=_CONDITIONS),
    FieldSpec("location", ("yard", "site", "stored at"), updatable=False),
    FieldSpec("quantity", ("owned", "qty", "total", "count", "total qty", "quantity owned"), kind="int", minimum=0, updatable=False),
    FieldSpec("available", ("available qty", "in stock", "on hand"), kind="int", minimum=0, updatable=False),
    FieldSpec("daily_rate", ("rate", "daily rate", "rental rate", "day rate", "price per day"), kind="float", minimum=0),
    FieldSpec("tracking_type", ("tracking",), kind="choice", choices=("bulk", "serialized"), updatable=False),
    FieldSpec("notes", ("note", "comments", "comment", "remarks"), max_len=2000),
)

_SELLABLE_FIELDS = (
    FieldSpec("product", ("name", "item", "description", "product name"), required=True),
    FieldSpec("manufacturer", ("brand", "vendor", "mfr", "make")),
    FieldSpec("sku", ("item number", "part number", "part #", "sku code")),
    FieldSpec("unit", ("uom", "unit of measure")),
    FieldSpec("core_size", ("core", "core size", "size")),
    FieldSpec("form_type", ("form", "form type", "type")),
    FieldSpec("quantity_on_hand", ("on hand", "qty", "quantity", "stock", "in stock", "count"), kind="int", minimum=0),
    FieldSpec("reorder_point", ("reorder", "reorder point", "reorder level", "min", "minimum"), kind="int", minimum=0),
    FieldSpec("cost", ("unit cost", "our cost"), kind="float", minimum=0),
    FieldSpec("price", ("sell price", "unit price", "retail"), kind="float", minimum=0),
    FieldSpec("notes", ("note", "comments", "comment", "remarks"), max_len=2000),
)

IMPORT_SPECS: dict[str, ImportSpec] = {
    "equipment": ImportSpec("equipment", "equipment", "Equipment inventory", _EQUIPMENT_FIELDS),
    "tools": ImportSpec("tools", "equipment", "Tools", _EQUIPMENT_FIELDS, fixed=(("category", "tool"),)),
    "consumables": ImportSpec("consumables", "sellable_items", "Consumables", _SELLABLE_FIELDS, fixed=(("kind", "consumable"),)),
    "block": ImportSpec("block", "sellable_items", "Block", _SELLABLE_FIELDS, fixed=(("kind", "block"),)),
}
IMPORT_ALIASES = {"inventory": "equipment", "tool": "tools", "consumable": "consumables", "blocks": "block"}

# Anything the UI shows as stock or state is driven by the ledger, never by a spreadsheet.
_LEDGER_NOTE = "stock and location changes must go through counts, transfers or check-in/out"


def resolve_import_spec(name: str) -> ImportSpec:
    key = (name or "").strip().lower().replace("-", "_").replace(" ", "_")
    key = IMPORT_ALIASES.get(key, key)
    spec = IMPORT_SPECS.get(key)
    if not spec:
        raise ImportFileError(
            f"Imports are supported for: {', '.join(sorted(IMPORT_SPECS))}. "
            "Rentals, dispatches and returns drive reservations and inventory ledgers and can't be bulk-imported."
        )
    return spec


# ----------------------------- file parsing --------------------------------
@dataclass
class ParsedSheet:
    headers: list[str]
    rows: list[tuple[int, list[Any]]]  # (source row number, cell values)
    source: str  # xlsx | pdf
    sheet_name: str = ""
    formula_cells: list[tuple[int, str]] = None  # (row, header)
    warnings: list[str] = None

    def __post_init__(self) -> None:
        self.formula_cells = self.formula_cells or []
        self.warnings = self.warnings or []


def detect_format(content: bytes) -> str:
    if content[:5] == b"%PDF-":
        return "pdf"
    if content[:4] == b"PK\x03\x04":
        return "xlsx"
    raise ImportFileError("Unsupported file. Upload an .xlsx workbook or a table-based .pdf report.")


def _guard_zip(content: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            infos = zf.infolist()
            if len(infos) > MAX_ZIP_ENTRIES:
                raise ImportFileError("Workbook has too many parts")
            if sum(i.file_size for i in infos) > MAX_UNCOMPRESSED_BYTES:
                raise ImportFileError("Workbook expands to an unreasonable size")
            names = {i.filename.lower() for i in infos}
            if "xl/workbook.xml" not in names:
                raise ImportFileError("Not a valid .xlsx workbook")
            if any(n.endswith("vbaproject.bin") for n in names):
                raise ImportFileError("Macro-enabled workbooks are not accepted")
    except zipfile.BadZipFile as exc:
        raise ImportFileError("Not a valid .xlsx workbook") from exc


def _clean_cell(value: Any) -> Any:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, datetime) and value.tzinfo:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _header_score(texts: list[str], spec: Optional["ImportSpec"]) -> int:
    """How many cells of a candidate header row are column names we recognise."""
    if spec is None:
        return 0
    known = set(_alias_lookup(spec))
    return sum(1 for t in texts if t and _norm(t) in known)


def read_xlsx(content: bytes, spec: Optional["ImportSpec"] = None) -> ParsedSheet:
    """Read the `Data` (or first) sheet. With a spec, the header is the best-matching of the first ten non-empty rows,
    so a title row above the real header is skipped instead of being mistaken for it."""
    _guard_zip(content)
    try:
        wb = load_workbook(io.BytesIO(content), read_only=True, data_only=False)
    except ImportFileError:
        raise
    except Exception as exc:  # openpyxl raises many types on corrupt input
        raise ImportFileError("Could not read the workbook; it may be corrupt or password-protected") from exc
    try:
        ws = wb["Data"] if "Data" in wb.sheetnames else wb.worksheets[0]
        try:
            ws.reset_dimensions()  # some writers record a wrong used-range; read what is actually there
        except Exception:  # pragma: no cover - older sheets without a dimension record
            pass
        collected: list[tuple[int, list[Any], set[int]]] = []  # (row number, values, formula column indexes)
        for row_idx, cells in enumerate(ws.iter_rows(max_col=MAX_COLUMNS + 1), start=1):
            values = [_clean_cell(c.value) for c in cells]
            if all(v in (None, "") for v in values):
                continue
            collected.append((row_idx, values, {i for i, c in enumerate(cells) if getattr(c, "data_type", "") == "f"}))
            if len(collected) > MAX_ROWS + 10:
                raise ImportFileError(f"Too many rows (max {MAX_ROWS} per import); split the file")
        if not collected:
            raise ImportFileError("The sheet has no header row")
        candidates = collected[:10]
        texts_of = lambda vals: [str(v).strip() if v is not None else "" for v in vals]  # noqa: E731
        best = max(range(len(candidates)), key=lambda i: (_header_score(texts_of(candidates[i][1]), spec), -i))
        if _header_score(texts_of(candidates[best][1]), spec) < 2:
            best = 0
        header_vals = texts_of(collected[best][1])
        width = max(i for i, t in enumerate(header_vals) if t) + 1
        if width > MAX_COLUMNS:
            raise ImportFileError(f"Too many columns (max {MAX_COLUMNS})")
        headers = header_vals[:width]
        rows: list[tuple[int, list[Any]]] = []
        formulas: list[tuple[int, str]] = []
        for row_idx, values, formula_cols in collected[best + 1:]:
            data = values[:width] + [None] * max(0, width - len(values))
            for col in sorted(c for c in formula_cols if c < width):
                formulas.append((row_idx, headers[col] or get_column_letter(col + 1)))
            rows.append((row_idx, data))
        if len(rows) > MAX_ROWS:
            raise ImportFileError(f"Too many rows (max {MAX_ROWS} per import); split the file")
        return ParsedSheet(headers, rows, "xlsx", sheet_name=ws.title, formula_cells=formulas)
    finally:
        wb.close()


def read_pdf_tables(content: bytes) -> ParsedSheet:
    """Extract one consistent table from a PDF. Anything less reliable than that is refused."""
    try:
        import pdfplumber
    except ImportError as exc:  # pragma: no cover
        raise ImportFileError("PDF import is not available on this server") from exc
    try:
        pdf = pdfplumber.open(io.BytesIO(content))
    except Exception as exc:
        raise ImportFileError("Could not read the PDF; it may be corrupt or encrypted") from exc
    with pdf:
        if len(pdf.pages) > MAX_PDF_PAGES:
            raise ImportFileError(f"PDF has too many pages (max {MAX_PDF_PAGES})")
        header: list[str] = []
        rows: list[tuple[int, list[Any]]] = []
        skipped_tables = 0
        counter = 0
        for page_no, page in enumerate(pdf.pages, start=1):
            try:
                tables = page.extract_tables()
            except Exception as exc:
                raise ImportFileError(f"Could not extract tables from page {page_no}") from exc
            for table in tables:
                cleaned = [[re.sub(r"\s+", " ", (c or "")).strip() for c in row] for row in table if row]
                if len(cleaned) < 2 or len(cleaned[0]) < 2:
                    continue
                if not header:
                    header = cleaned[0]
                elif cleaned[0] != header:
                    skipped_tables += 1
                    continue
                for row in cleaned[1:]:
                    if row == header or all(not c for c in row):
                        continue  # PDFs repeat the header on every page
                    if len(row) != len(header):
                        raise ImportFileError(
                            f"Page {page_no}: a table row has {len(row)} cells but the header has {len(header)}; "
                            "this PDF can't be extracted reliably. Use the Excel export instead."
                        )
                    counter += 1
                    if counter > MAX_ROWS:
                        raise ImportFileError(f"Too many rows (max {MAX_ROWS} per import)")
                    rows.append((counter + 1, list(row)))
    if not header or not rows:
        raise ImportFileError(
            "No structured table was found in this PDF. PDF import works on table-based reports "
            "(such as MobileOps exports); use an Excel file for anything else."
        )
    warnings = [f"{skipped_tables} table(s) with a different layout were ignored."] if skipped_tables else []
    return ParsedSheet(header, rows, "pdf", sheet_name="pdf", warnings=warnings)


def read_upload(content: bytes, spec: Optional["ImportSpec"] = None) -> ParsedSheet:
    if not content:
        raise ImportFileError("The file is empty")
    if len(content) > MAX_FILE_BYTES:
        raise ImportFileError(f"File too large (max {MAX_FILE_BYTES // 1_000_000} MB)")
    return read_xlsx(content, spec) if detect_format(content) == "xlsx" else read_pdf_tables(content)


# ----------------------------- column mapping ------------------------------
def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def _alias_lookup(spec: ImportSpec) -> dict[str, str]:
    lookup: dict[str, str] = {}
    for f in spec.fields:
        for alias in (f.key, f.key.replace("_", " "), *f.aliases):
            lookup.setdefault(_norm(alias), f.key)
    return lookup


def auto_map(headers: list[str], spec: ImportSpec) -> dict[str, Optional[str]]:
    lookup = _alias_lookup(spec)
    mapping: dict[str, Optional[str]] = {}
    taken: set[str] = set()
    for header in headers:
        key = lookup.get(_norm(header)) if header else None
        if key and key not in taken:
            mapping[header] = key
            taken.add(key)
        else:
            mapping[header] = None
    return mapping


def resolve_mapping(headers: list[str], spec: ImportSpec, override: Optional[dict[str, Any]]) -> dict[str, Optional[str]]:
    mapping = auto_map(headers, spec)
    if not override:
        return mapping
    for header, target in override.items():
        if header not in mapping:
            raise ImportFileError(f"Mapping refers to a column that is not in the file: '{header}'")
        if target in (None, "", "ignore"):
            mapping[header] = None
        elif target not in spec.keys:
            raise ImportFileError(f"Unknown target field '{target}'. Valid fields: {', '.join(spec.keys)}")
        else:
            mapping[header] = target
    used = [t for t in mapping.values() if t]
    dupes = sorted({t for t in used if used.count(t) > 1})
    if dupes:
        raise ImportFileError(f"More than one column is mapped to: {', '.join(dupes)}")
    return mapping


# ----------------------------- coercion & validation -----------------------
def _coerce(value: Any, f: FieldSpec) -> tuple[Any, Optional[str]]:
    if value is None or (isinstance(value, str) and value == ""):
        return None, None
    if isinstance(value, bool):
        return None, f"{f.key}: expected {f.kind}, got a yes/no value"
    if f.kind in ("str", "choice"):
        if isinstance(value, float) and value.is_integer():
            value = int(value)  # a QR/SKU typed as a number must not become "1234.0"
        if isinstance(value, datetime):
            return None, f"{f.key}: expected text, got a date"
        text = str(value).strip()
        if len(text) > f.max_len:
            return None, f"{f.key}: longer than {f.max_len} characters"
        if f.kind == "choice":
            match = next((c for c in f.choices if c == text.lower()), None)
            if not match:
                return None, f"{f.key}: '{text}' is not one of {', '.join(f.choices)}"
            return match, None
        return text, None
    if f.kind in ("int", "float"):
        if isinstance(value, str):
            cleaned = value.replace(",", "").replace("$", "").strip()
            try:
                number = float(cleaned)
            except ValueError:
                return None, f"{f.key}: '{value}' is not a number"
        elif isinstance(value, (int, float)):
            number = float(value)
        else:
            return None, f"{f.key}: expected a number"
        if math.isnan(number) or math.isinf(number):
            return None, f"{f.key}: not a finite number"
        if f.minimum is not None and number < f.minimum:
            return None, f"{f.key}: must be at least {int(f.minimum) if f.minimum.is_integer() else f.minimum}"
        if f.kind == "int":
            if not number.is_integer():
                return None, f"{f.key}: must be a whole number"
            return int(number), None
        return round(number, 4), None
    return None, f"{f.key}: unsupported field type"


def _validate_row(spec: ImportSpec, data: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if spec.collection == "equipment":
        quantity, available = data.get("quantity"), data.get("available")
        if quantity is not None and available is not None and available > quantity:
            errors.append("available: cannot exceed quantity")
    return errors


def _apply_defaults(spec: ImportSpec, data: dict[str, Any]) -> dict[str, Any]:
    out = dict(data)
    for key, value in spec.fixed:
        if out.get(key) not in (None, value):
            raise ValueError(f"{key}: this import only accepts '{value}'")
        out[key] = value
    if spec.collection == "equipment":
        out.setdefault("condition", "good")
        out["quantity"] = 1 if out.get("quantity") is None else out["quantity"]
        out["available"] = out["quantity"] if out.get("available") is None else out["available"]
        out.setdefault("daily_rate", 0.0)
        out.setdefault("tracking_type", "bulk")
        for text_key in ("model", "equipment_family", "serial_number", "location", "notes", "sku"):
            out[text_key] = out.get(text_key) or ""
        out["qr_code"] = out.get("qr_code") or None
    else:
        out["quantity_on_hand"] = 0 if out.get("quantity_on_hand") is None else out["quantity_on_hand"]
        for text_key in ("manufacturer", "sku", "unit", "core_size", "form_type", "notes"):
            out[text_key] = out.get(text_key) or ""
    return out


# ----------------------------- identity & duplicates -----------------------
def _lc(value: Any) -> str:
    return str(value or "").strip().lower()


def row_keys(spec: ImportSpec, data: dict[str, Any]) -> list[tuple[str, ...]]:
    """Identity keys for a record, strongest first. A weaker key is used only when no stronger one exists."""
    if spec.collection == "equipment":
        keys: list[tuple[str, ...]] = []
        if data.get("qr_code"):
            keys.append(("qr", _lc(data["qr_code"])))
        if data.get("sku"):
            keys.append(("sku", _lc(data["sku"])))
        if data.get("serial_number"):
            keys.append(("serial", _lc(data["serial_number"])))
        return keys or [("name", _lc(data.get("name")), _lc(data.get("model")))]
    if data.get("sku"):
        return [("sku", _lc(data["sku"]))]
    return [("item", _lc(data.get("product")), _lc(data.get("manufacturer")), _lc(data.get("core_size")), _lc(data.get("form_type")))]


def _existing_index(spec: ImportSpec, docs: Iterable[dict[str, Any]]) -> dict[tuple[str, ...], set[str]]:
    index: dict[tuple[str, ...], set[str]] = {}
    for doc in docs:
        if spec.collection == "sellable_items" and dict(spec.fixed).get("kind") and doc.get("kind") != dict(spec.fixed)["kind"]:
            continue
        probe = doc
        for key in _all_identity_keys(spec, probe):
            index.setdefault(key, set()).add(doc["id"])
    return index


def _all_identity_keys(spec: ImportSpec, doc: dict[str, Any]) -> list[tuple[str, ...]]:
    """Every key an existing record can be found by (a record with a QR is also findable by its SKU)."""
    out: list[tuple[str, ...]] = []
    if spec.collection == "equipment":
        if doc.get("qr_code"):
            out.append(("qr", _lc(doc["qr_code"])))
        if doc.get("sku"):
            out.append(("sku", _lc(doc["sku"])))
        if doc.get("serial_number"):
            out.append(("serial", _lc(doc["serial_number"])))
        out.append(("name", _lc(doc.get("name")), _lc(doc.get("model"))))
    else:
        if doc.get("sku"):
            out.append(("sku", _lc(doc["sku"])))
        out.append(("item", _lc(doc.get("product")), _lc(doc.get("manufacturer")), _lc(doc.get("core_size")), _lc(doc.get("form_type"))))
    return out


def _same(spec_field: FieldSpec, old: Any, new: Any) -> bool:
    if spec_field.kind == "float":
        return math.isclose(float(old or 0), float(new or 0), abs_tol=0.005)
    if spec_field.kind == "int":
        return int(old or 0) == int(new or 0)
    return str(old or "").strip() == str(new or "").strip()


def _row_view(headers: list[str], values: list[Any]) -> dict[str, str]:
    return {h or f"col{i + 1}": ("" if v is None else str(v))[:120] for i, (h, v) in enumerate(zip(headers, values))}


async def plan_rows(
    db: Any, spec: ImportSpec, parsed_rows: list[dict[str, Any]], on_duplicate: str,
) -> list[dict[str, Any]]:
    """Turn normalized rows into a per-row plan against *current* data. Pure read."""
    existing_docs = await db[spec.collection].find({}, {"_id": 0}).to_list(None)
    by_id = {d["id"]: d for d in existing_docs}
    index = _existing_index(spec, existing_docs)
    seen_in_file: dict[tuple[str, ...], int] = {}
    plan: list[dict[str, Any]] = []
    for item in parsed_rows:
        entry: dict[str, Any] = {k: item[k] for k in ("row", "raw") if k in item}
        if item.get("errors"):
            plan.append({**entry, "action": "error", "errors": item["errors"]})
            continue
        data = item["data"]
        keys = row_keys(spec, data)
        entry.update({"key": " / ".join(":".join(k) for k in keys[:1]), "data": data})
        clash = next((seen_in_file[k] for k in keys if k in seen_in_file), None)
        if clash is not None:
            plan.append({**entry, "action": "error", "errors": [f"duplicate of row {clash} in this file"]})
            continue
        for k in keys:
            seen_in_file[k] = item["row"]
        matches: set[str] = set()
        for k in keys:
            matches |= index.get(k, set())
        if len(matches) > 1:
            plan.append({**entry, "action": "error", "errors": [f"ambiguous: matches {len(matches)} existing records"]})
            continue
        if not matches:
            plan.append({**entry, "action": "create"})
            continue
        existing = by_id[next(iter(matches))]
        diff: dict[str, list[Any]] = {}
        ignored: dict[str, list[Any]] = {}
        for f in spec.fields:
            if f.key not in data or data[f.key] in (None, ""):
                continue
            if f.key in dict(spec.fixed):
                continue
            if _same(f, existing.get(f.key), data[f.key]):
                continue
            (diff if f.updatable else ignored)[f.key] = [existing.get(f.key), data[f.key]]
        entry.update({"existing_id": existing["id"], "existing_name": existing.get("name") or existing.get("product")})
        if ignored:
            entry["ignored_changes"] = ignored
        if on_duplicate == "update" and diff:
            plan.append({**entry, "action": "update", "diff": diff})
        elif on_duplicate == "update":
            plan.append({**entry, "action": "unchanged"})
        else:
            plan.append({**entry, "action": "skip_duplicate", "diff": diff})
    return plan


def _hash_plan(job_facts: dict[str, Any], plan: list[dict[str, Any]]) -> str:
    material = [
        [r.get("row"), r["action"], r.get("key"), r.get("existing_id"), r.get("data"), r.get("diff"), r.get("errors")]
        for r in plan
    ]
    blob = json.dumps({"job": job_facts, "plan": material}, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()


def _summarize(plan: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"total": len(plan), "create": 0, "update": 0, "unchanged": 0, "skip_duplicate": 0, "error": 0}
    for r in plan:
        counts[r["action"]] += 1
    return counts


# ----------------------------- staging -------------------------------------
def _normalize_rows(spec: ImportSpec, parsed: ParsedSheet, mapping: dict[str, Optional[str]]) -> list[dict[str, Any]]:
    formula_rows: dict[int, list[str]] = {}
    for row_no, header in parsed.formula_cells:
        formula_rows.setdefault(row_no, []).append(header)
    col_to_field = [(i, mapping.get(h)) for i, h in enumerate(parsed.headers)]
    out: list[dict[str, Any]] = []
    for row_no, values in parsed.rows:
        item: dict[str, Any] = {"row": row_no, "raw": _row_view(parsed.headers, values)}
        errors: list[str] = []
        if row_no in formula_rows:
            errors.append(f"formulas are not allowed (column {', '.join(formula_rows[row_no])}); paste values instead")
        data: dict[str, Any] = {}
        for idx, field_key in col_to_field:
            if not field_key:
                continue
            value, error = _coerce(values[idx], spec.field(field_key))
            if error:
                errors.append(error)
            elif value is not None:
                data[field_key] = value
        for f in spec.fields:
            if f.required and f.key not in data and f.key not in dict(spec.fixed):
                errors.append(f"{f.key}: required")
        if not errors:
            try:
                data = _apply_defaults(spec, data)
            except ValueError as exc:
                errors.append(str(exc))
        if not errors:
            errors.extend(_validate_row(spec, data))
        if errors:
            item["errors"] = errors
        else:
            item["data"] = data
        out.append(item)
    return out


async def stage_import(
    db: Any, *, dataset: str, filename: str, content: bytes, actor_id: str, actor_name: str,
    mapping: Optional[dict[str, Any]] = None, on_duplicate: str = "skip", source: str = "api",
) -> dict[str, Any]:
    """Parse + validate + plan, and persist the plan. Writes only to import_jobs/import_files."""
    spec = resolve_import_spec(dataset)
    if on_duplicate not in DUPLICATE_POLICIES:
        raise ImportFileError(f"on_duplicate must be one of: {', '.join(DUPLICATE_POLICIES)}")
    parsed = read_upload(content, spec)
    if parsed.source == "pdf" and on_duplicate == "update":
        raise ImportFileError("PDF imports can only add new records; use an Excel file to update existing ones")
    resolved = resolve_mapping(parsed.headers, spec, mapping)
    mapped_fields = {v for v in resolved.values() if v}
    blocking: list[str] = []
    for f in spec.fields:
        if f.required and f.key not in mapped_fields and f.key not in dict(spec.fixed):
            blocking.append(f"No column is mapped to required field '{f.key}'. Map one with the `mapping` option.")
    ignored_columns = [h or "(blank header)" for h, t in resolved.items() if not t]
    normalized = _normalize_rows(spec, parsed, resolved) if not blocking else []
    plan = await plan_rows(db, spec, normalized, on_duplicate) if not blocking else []
    file_sha = hashlib.sha256(content).hexdigest()
    plan_hash = _hash_plan(
        {"dataset": spec.dataset, "on_duplicate": on_duplicate, "mapping": resolved, "file": file_sha, "source": parsed.source}, plan
    )
    now = utc_now()
    job = {
        "id": str(uuid.uuid4()), "dataset": spec.dataset, "collection": spec.collection, "source": parsed.source,
        "filename": (filename or "upload")[:200], "file_sha256": file_sha, "file_size": len(content),
        "uploaded_by_id": actor_id, "uploaded_by_name": actor_name, "created_at": now, "expires_at": now + JOB_TTL,
        "status": "staged", "on_duplicate": on_duplicate, "mapping": resolved, "headers": parsed.headers,
        "ignored_columns": ignored_columns, "warnings": list(parsed.warnings), "blocking_errors": blocking,
        "plan_hash": plan_hash, "summary": _summarize(plan), "rows": plan, "channel": source,
        "purge_after": now + JOB_RETENTION,
    }
    await db.import_jobs.insert_one(dict(job))
    await db.import_files.insert_one({"id": job["id"], "filename": job["filename"], "content": content, "sha256": file_sha, "created_at": now, "purge_after": now + FILE_RETENTION})
    await record_activity(
        db, source="import", event_type="import_staged", actor_id=actor_id, actor_name=actor_name,
        parameters={"import_id": job["id"], "dataset": spec.dataset, "filename": job["filename"], "on_duplicate": on_duplicate, "source": parsed.source},
        result={"summary": job["summary"], "plan_hash": plan_hash, "blocking_errors": blocking, "writes_to_domain_data": False},
    )
    return preview(job)


def preview(job: dict[str, Any], *, offset: int = 0, limit: int = PREVIEW_ROWS, action: Optional[str] = None) -> dict[str, Any]:
    rows = job["rows"] if not action else [r for r in job["rows"] if r["action"] == action]
    errors = [r for r in job["rows"] if r["action"] == "error"]
    page = rows[offset: offset + limit] if (offset or action) else _balanced_sample(job["rows"], limit)
    return {
        "import_id": job["id"], "status": job["status"], "dataset": job["dataset"], "source": job["source"],
        "filename": job["filename"], "on_duplicate": job["on_duplicate"], "plan_hash": job["plan_hash"],
        "expires_at": job["expires_at"], "summary": job["summary"], "mapping": job["mapping"],
        "ignored_columns": job["ignored_columns"], "warnings": job.get("warnings", []),
        "blocking_errors": job["blocking_errors"], "errors": [_slim(r) for r in errors[:PREVIEW_ERRORS]],
        "errors_truncated": max(0, len(errors) - PREVIEW_ERRORS),
        "rows": [_slim(r) for r in page], "rows_total_matching": len(rows), "offset": offset,
        "result": job.get("result"), "commit_error": job.get("commit_error"),
        "next_step": (
            "Nothing has been changed. Review the rows, then an administrator must confirm the commit with this plan_hash."
            if job["status"] == "staged" and not job["blocking_errors"] else None
        ),
    }


def _balanced_sample(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for act in ("create", "update", "skip_duplicate", "unchanged"):
        out.extend([r for r in rows if r["action"] == act][: max(3, limit // 4)])
    return out[:limit]


def _slim(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k in ("row", "action", "key", "data", "diff", "ignored_changes", "errors", "existing_id", "existing_name", "raw")}


async def load_job(db: Any, import_id: str, *, require_live: bool = True) -> dict[str, Any]:
    job = await db.import_jobs.find_one({"id": import_id}, {"_id": 0})
    if not job:
        raise ImportStateError("Import not found", 404)
    if require_live and job["status"] == "staged" and _aware(job["expires_at"]) <= utc_now():
        await db.import_jobs.update_one({"id": import_id, "status": "staged"}, {"$set": {"status": "expired"}})
        raise ImportStateError("This import preview has expired; upload the file again", 410)
    return job


async def cancel_import(db: Any, import_id: str, *, actor_id: str, actor_name: str) -> dict[str, Any]:
    job = await load_job(db, import_id, require_live=False)
    res = await db.import_jobs.update_one({"id": import_id, "status": "staged"}, {"$set": {"status": "cancelled", "cancelled_at": utc_now()}})
    if res.modified_count != 1:
        raise ImportStateError(f"Import is {job['status']} and can't be cancelled")
    await db.import_files.delete_one({"id": import_id})
    await record_activity(db, source="import", event_type="import_cancelled", actor_id=actor_id, actor_name=actor_name,
                          parameters={"import_id": import_id}, result={"status": "cancelled"})
    return {"import_id": import_id, "status": "cancelled"}


# ----------------------------- commit (all-or-nothing) ---------------------
BeforeApply = Callable[[int, dict[str, Any]], Awaitable[None]]


async def commit_import(
    db: Any, backend: Any, *, import_id: str, plan_hash: str, actor_id: str, actor_name: str,
    skip_invalid_rows: bool = False, before_apply: Optional[BeforeApply] = None,
) -> dict[str, Any]:
    """Apply a reviewed plan. `backend` supplies the domain models (Equipment, LedgerEntry, SellableItem).

    `before_apply(index, row)` is a test seam that runs ahead of each write.
    """
    job = await load_job(db, import_id)
    if job["status"] != "staged":
        raise ImportStateError(f"Import is already {job['status']}; it can't be committed again")
    if not hmac.compare_digest(str(plan_hash or ""), job["plan_hash"]):
        raise ImportStateError("plan_hash does not match the reviewed preview; review the latest preview and try again", 409)
    if job["blocking_errors"]:
        raise ImportStateError("The import has blocking errors: " + "; ".join(job["blocking_errors"]))
    if job["summary"]["error"] and not skip_invalid_rows:
        raise ImportStateError(
            f"{job['summary']['error']} row(s) are invalid. Fix the file, or confirm with skip_invalid_rows=true to import only the valid rows."
        )
    claimed = await db.import_jobs.find_one_and_update(
        {"id": import_id, "status": "staged"},
        {"$set": {"status": "committing", "commit_started_at": utc_now(), "committed_by_id": actor_id, "committed_by_name": actor_name}},
    )
    if claimed is None:
        raise ImportStateError("Import is already being committed")

    spec = resolve_import_spec(job["dataset"])
    # Re-derive the plan from live data: the preview must still be true at write time.
    rebuilt_input = [{"row": r["row"], "raw": r.get("raw"), **({"errors": r["errors"]} if r["action"] == "error" and "data" not in r else {"data": r["data"]})} for r in job["rows"]]
    fresh = await plan_rows(db, spec, rebuilt_input, job["on_duplicate"])
    fresh_hash = _hash_plan(
        {"dataset": spec.dataset, "on_duplicate": job["on_duplicate"], "mapping": job["mapping"], "file": job["file_sha256"], "source": job["source"]},
        fresh,
    )
    if fresh_hash != job["plan_hash"]:
        await db.import_jobs.update_one({"id": import_id}, {"$set": {"status": "stale", "commit_error": "Data changed since the preview"}})
        await record_activity(db, source="import", event_type="import_refused_stale", actor_id=actor_id, actor_name=actor_name,
                              parameters={"import_id": import_id}, result={"reason": "data changed since preview", "writes": 0})
        raise ImportStateError("Inventory changed since this preview was generated; nothing was written. Upload the file again to re-preview.", 409)

    todo = [r for r in fresh if r["action"] in ("create", "update")]
    undo: list[tuple[str, str, Any]] = []
    applied = {"created": [], "updated": []}
    try:
        for idx, row in enumerate(todo):
            if before_apply:
                await before_apply(idx, row)
            await _apply_row(db, backend, spec, row, job, actor_name, undo, applied)
    except Exception as exc:
        rollback_errors = await _rollback(db, undo)
        status = "failed" if not rollback_errors else "failed_needs_review"
        detail = f"{exc.__class__.__name__}: {exc}"
        await db.import_jobs.update_one(
            {"id": import_id},
            {"$set": {"status": status, "commit_error": detail, "rollback_errors": rollback_errors, "failed_at": utc_now()}},
        )
        await record_activity(
            db, source="import", event_type="import_failed", actor_id=actor_id, actor_name=actor_name,
            parameters={"import_id": import_id, "dataset": job["dataset"]},
            result={"error": detail, "rolled_back": not rollback_errors, "rollback_errors": rollback_errors, "net_writes": 0 if not rollback_errors else "unknown"},
        )
        raise ImportCommitError(
            f"Import failed and was rolled back; no changes were kept ({detail})" if not rollback_errors
            else f"Import failed and the rollback was incomplete ({detail}); an administrator must review import {import_id}",
            rolled_back=not rollback_errors,
        ) from exc

    result = {
        "created": len(applied["created"]), "updated": len(applied["updated"]),
        "skipped_duplicates": job["summary"]["skip_duplicate"], "unchanged": job["summary"]["unchanged"],
        "skipped_invalid_rows": job["summary"]["error"], "created_ids": applied["created"][:200], "updated_ids": applied["updated"][:200],
    }
    await db.import_jobs.update_one({"id": import_id}, {"$set": {"status": "committed", "committed_at": utc_now(), "result": result}})
    await record_activity(db, source="import", event_type="import_committed", actor_id=actor_id, actor_name=actor_name,
                          parameters={"import_id": import_id, "dataset": job["dataset"], "filename": job["filename"], "plan_hash": job["plan_hash"]},
                          result=result)
    return {"import_id": import_id, "status": "committed", "result": result}


class ImportCommitError(RuntimeError):
    def __init__(self, message: str, rolled_back: bool) -> None:
        super().__init__(message)
        self.rolled_back = rolled_back


async def _apply_row(
    db: Any, backend: Any, spec: ImportSpec, row: dict[str, Any], job: dict[str, Any], actor_name: str,
    undo: list[tuple[str, str, Any]], applied: dict[str, list[str]],
) -> None:
    data = row["data"]
    coll = db[spec.collection]
    if row["action"] == "update":
        existing = await coll.find_one({"id": row["existing_id"]}, {"_id": 0})
        if not existing:
            raise RuntimeError(f"record {row['existing_id']} disappeared")
        changes = {k: new for k, (_old, new) in row["diff"].items()}
        if spec.collection == "sellable_items":
            changes["updated_at"] = utc_now()
        undo.append(("restore", spec.collection, {"id": existing["id"], "values": {k: existing.get(k) for k in changes}, "unset": [k for k in changes if k not in existing]}))
        await coll.update_one({"id": existing["id"]}, {"$set": changes})
        applied["updated"].append(existing["id"])
        return
    if spec.collection == "equipment":
        qr = data.get("qr_code")
        eq = backend.Equipment(
            sku=data.get("sku") or backend.equipment_identifier_sku(qr, data.get("serial_number", "")),
            qr_code=qr, model=data.get("model", ""), equipment_family=data.get("equipment_family", ""),
            serial_number=data.get("serial_number", ""), name=data["name"], category=data["category"],
            condition=data["condition"], location=data.get("location", ""),
            location_balances={data["location"]: data["available"]} if data["available"] > 0 and data.get("location") else {},
            daily_rate=data["daily_rate"], quantity=data["quantity"], available=data["available"],
            tracking_type=data["tracking_type"], notes=data.get("notes", ""),
        )
        undo.append(("delete", "equipment", eq.id))
        await coll.insert_one(eq.model_dump())
        if eq.available > 0:
            entry = backend.LedgerEntry(
                equipment_id=eq.id, qty=eq.available, from_bucket="owned", to_bucket="available", reason="received",
                location=eq.location, note=f"Initial stock (import {job['id'][:8]})", created_by=actor_name,
            )
            undo.append(("delete", "ledger_entries", entry.id))
            await db.ledger_entries.insert_one(entry.model_dump())
        applied["created"].append(eq.id)
        return
    fields = {k: v for k, v in data.items() if k in {f.key for f in spec.fields}}
    item = backend.SellableItem(kind=dict(spec.fixed)["kind"], created_by=actor_name, **fields)
    undo.append(("delete", "sellable_items", item.id))
    await coll.insert_one(item.model_dump())
    applied["created"].append(item.id)


async def _rollback(db: Any, undo: list[tuple[str, str, Any]]) -> list[str]:
    failures: list[str] = []
    for op, collection, payload in reversed(undo):
        try:
            if op == "delete":
                await db[collection].delete_one({"id": payload})
            else:
                update: dict[str, Any] = {"$set": payload["values"]}
                if payload["unset"]:
                    update["$unset"] = {k: "" for k in payload["unset"]}
                    update["$set"] = {k: v for k, v in payload["values"].items() if k not in payload["unset"]}
                    if not update["$set"]:
                        del update["$set"]
                await db[collection].update_one({"id": payload["id"]}, update)
        except Exception as exc:  # keep rolling back the rest; report what stuck
            failures.append(f"{op} {collection} {payload if op == 'delete' else payload['id']}: {exc}")
    return failures


# ----------------------------- review report -------------------------------
def render_plan_report(job: dict[str, Any]) -> bytes:
    """Every row of a staged plan with its action and problems, for review outside the chat."""
    wb = Workbook()
    ws = wb.active
    ws.title = "Import plan"
    ws.append(["Row", "Action", "Key", "Problems", "Changes (old -> new)", "Not applied (stock/location are ledger-driven)"])
    for r in job["rows"]:
        diff = "; ".join(f"{k}: {a} -> {b}" for k, (a, b) in (r.get("diff") or {}).items())
        ignored = "; ".join(f"{k}: {a} -> {b}" for k, (a, b) in (r.get("ignored_changes") or {}).items())
        ws.append([r.get("row"), r["action"], r.get("key", ""), "; ".join(r.get("errors") or []), diff, ignored])
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="1F2937")
        cell.alignment = Alignment(wrap_text=True, vertical="center")
    for idx, width in enumerate((7, 16, 32, 60, 60, 50), start=1):
        ws.column_dimensions[get_column_letter(idx)].width = width
    ws.freeze_panes = "A2"
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            if isinstance(cell.value, str):
                cell.data_type = "s"
    summary = wb.create_sheet("Summary")
    for k, v in (("Import", job["id"]), ("File", job["filename"]), ("Dataset", job["dataset"]), ("Duplicates", job["on_duplicate"]),
                 ("Plan hash", job["plan_hash"]), *[(k, v) for k, v in job["summary"].items()],
                 ("Ignored columns", ", ".join(job["ignored_columns"]) or "none")):
        summary.append([k, str(v)])
    summary.column_dimensions["A"].width = 18
    summary.column_dimensions["B"].width = 70
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
