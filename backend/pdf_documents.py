"""Single-record PDFs: rental agreement/transaction record and dispatch (outbound / inbound / return) tickets.

Same visual language and numbered-page canvas as the tabular reports in exports.py. Money is
left out entirely for the crew role, matching redact_money_for_crew everywhere else.
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any, Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from exports import _NumberedCanvas, _esc, _fmt_dt

_INK = colors.HexColor("#1f2937")
_RULE = colors.HexColor("#d1d5db")
_BAND = colors.HexColor("#f3f4f6")


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=base["BodyText"], fontSize=9, leading=11.5)
    return {
        "title": ParagraphStyle("t", parent=base["Title"], fontSize=17, leading=20, alignment=0, spaceAfter=2),
        "sub": ParagraphStyle("s", parent=body, textColor=colors.HexColor("#4b5563")),
        "h": ParagraphStyle("h", parent=body, fontName="Helvetica-Bold", fontSize=10.5, spaceBefore=10, spaceAfter=3, textColor=_INK),
        "body": body,
        "cell": ParagraphStyle("c", parent=body, fontSize=8.5, leading=10.5),
        "head": ParagraphStyle("hd", parent=body, fontSize=8.5, leading=10.5, textColor=colors.white, fontName="Helvetica-Bold"),
        "label": ParagraphStyle("l", parent=body, fontSize=8, textColor=colors.HexColor("#6b7280")),
    }


def _kv_table(pairs: list[tuple[str, Any]], st: dict[str, ParagraphStyle], cols: int = 2) -> Table:
    pairs = [(k, v) for k, v in pairs if v not in (None, "")]
    cells = [[Paragraph(_esc(k), st["label"]), Paragraph(_esc(str(v)), st["body"])] for k, v in pairs]
    rows = []
    for i in range(0, len(cells), cols):
        chunk = cells[i:i + cols]
        row: list[Any] = []
        for pair in chunk:
            row.extend(pair)
        while len(row) < cols * 2:
            row.extend(["", ""])
        rows.append(row)
    width = 7.5 * inch
    label_w, value_w = 0.95 * inch, width / cols - 0.95 * inch
    table = Table(rows or [["", ""] * cols], colWidths=[label_w, value_w] * cols)
    table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("BOTTOMPADDING", (0, 0), (-1, -1), 3), ("TOPPADDING", (0, 0), (-1, -1), 2)]))
    return table


def _grid(header: list[str], rows: list[list[Any]], st: dict[str, ParagraphStyle], widths: list[float]) -> Table:
    data = [[Paragraph(_esc(h), st["head"]) for h in header]]
    data += [[Paragraph(_esc(str(c)), st["cell"]) for c in row] for row in rows]
    table = Table(data, colWidths=[w * inch for w in widths], repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), _INK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _BAND]),
        ("GRID", (0, 0), (-1, -1), 0.25, _RULE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    return table


def _signature_block(labels: list[str], st: dict[str, ParagraphStyle]) -> KeepTogether:
    cells = [[Paragraph(_esc(f"{label}"), st["label"]) for label in labels]]
    table = Table([[""] * len(labels)] + cells, colWidths=[7.5 * inch / len(labels)] * len(labels), rowHeights=[0.45 * inch, 0.22 * inch])
    table.setStyle(TableStyle([("LINEABOVE", (0, 1), (-1, 1), 0.6, _INK), ("LEFTPADDING", (0, 0), (-1, -1), 4)]))
    return KeepTogether([Spacer(1, 14), table])


def _letterhead(site: dict[str, Any], st: dict[str, ParagraphStyle], title: str, ref: str, generated_at: datetime) -> list[Any]:
    brand = site.get("brand_name") or "MobileOps"
    contact = " · ".join(x for x in (site.get("company_address"), site.get("company_phone"), site.get("company_email")) if x)
    return [
        Paragraph(_esc(brand), st["sub"]),
        Paragraph(_esc(title), st["title"]),
        Paragraph(_esc(f"{ref}  ·  Generated {generated_at.strftime('%Y-%m-%d %H:%M')} UTC"), st["sub"]),
        *([Paragraph(_esc(contact), st["sub"])] if contact else []),
        Spacer(1, 6),
    ]


def _build(story: list[Any], *, footer: str, title: str, author: str) -> bytes:
    buf = io.BytesIO()
    SimpleDocTemplate(
        buf, pagesize=letter, leftMargin=0.5 * inch, rightMargin=0.5 * inch, topMargin=0.55 * inch,
        bottomMargin=0.65 * inch, title=title, author=author,
    ).build(story, canvasmaker=lambda *a, **k: _NumberedCanvas(*a, footer=footer, **k))
    return buf.getvalue()


def _money(value: Any) -> str:
    try:
        return f"${float(value):,.2f}"
    except (TypeError, ValueError):
        return ""


def render_rental_pdf(
    rental: dict[str, Any], *, site: dict[str, Any], role: str, generated_by: str, generated_at: Optional[datetime] = None,
) -> bytes:
    """Rental agreement / transaction record: parties, job, equipment out and back, notes, signatures."""
    st = _styles()
    generated_at = generated_at or datetime.now(timezone.utc)
    show_money = role != "crew"
    ref = f"Rental {str(rental.get('id', ''))[:8]}"
    lines = rental.get("lines") or []
    story = _letterhead(site, st, "Rental Agreement & Transaction Record", ref, generated_at)
    story += [Paragraph("Customer & job", st["h"]), _kv_table([
        ("Customer", rental.get("customer_name")), ("Type", rental.get("customer_type")),
        ("Contact", rental.get("primary_contact")), ("Phone", rental.get("customer_phone")),
        ("Email", rental.get("customer_email")), ("Job site", rental.get("job_site")),
        ("Address", rental.get("job_address")), ("Status", str(rental.get("status", "")).replace("_", " ")),
    ], st)]
    terms = [
        ("Start", _fmt_dt(rental.get("start_date"))), ("Due", _fmt_dt(rental.get("due_date"))),
        ("Delivered by", rental.get("delivered_by")), ("Received by", rental.get("received_by")),
    ]
    if show_money:
        terms.append(("Deposit", _money(rental.get("deposit"))))
    story += [Paragraph("Rental terms", st["h"]), _kv_table(terms, st)]

    header = ["Item", "QR / SKU", "Ordered", "Delivered", "Returned", "Damaged", "Outstanding"]
    widths = [2.4, 1.2, 0.65, 0.7, 0.65, 0.65, 0.75]
    if show_money:
        header.append("Daily rate")
        widths = [2.0, 1.1, 0.6, 0.65, 0.65, 0.65, 0.8, 0.75]
    rows = []
    totals = {"ordered": 0, "delivered": 0, "returned": 0, "damaged": 0}
    for line in lines:
        qty = int(line.get("qty") or 0)
        delivered = int(line.get("delivered_qty") or 0) or qty
        returned = int(line.get("returned_qty") or 0)
        damaged = int(line.get("damaged_qty") or 0)
        totals["ordered"] += qty
        totals["delivered"] += delivered
        totals["returned"] += returned
        totals["damaged"] += damaged
        row = [line.get("name", ""), line.get("qr_code") or line.get("sku") or "", qty, delivered, returned, damaged, max(delivered - returned, 0)]
        if show_money:
            row.append(_money(line.get("daily_rate")))
        rows.append(row)
    story += [Paragraph(f"Equipment ({len(lines)} line{'s' if len(lines) != 1 else ''})", st["h"]),
              _grid(header, rows, st, widths) if rows else Paragraph("No equipment lines recorded.", st["body"])]
    story.append(Paragraph(
        f"<b>Totals:</b> {totals['ordered']} ordered · {totals['delivered']} delivered · {totals['returned']} returned · "
        f"{totals['damaged']} damaged · {max(totals['delivered'] - totals['returned'], 0)} outstanding", st["body"]))

    notes = [("Delivery notes", rental.get("delivery_notes")), ("Gate / access", rental.get("gate_access_instructions")),
             ("Return notes", rental.get("return_notes")), ("Notes", rental.get("notes"))]
    if any(v for _, v in notes):
        story += [Paragraph("Notes", st["h"]), _kv_table(notes, st, cols=1)]
    log = (rental.get("communication_log") or [])[-10:]
    if log:
        story += [Paragraph("Recent customer communication", st["h"]), _grid(
            ["When", "Channel", "Dir.", "Summary", "Outcome"],
            [[_fmt_dt(e.get("created_at")), e.get("channel", ""), e.get("direction", ""), e.get("summary", ""), e.get("outcome", "")] for e in log],
            st, [1.2, 0.8, 0.7, 3.4, 1.4])]
    story.append(_signature_block(["Customer signature / date", "Delivered by (signature / date)", "Received by (signature / date)"], st))
    return _build(story, footer=f"{site.get('brand_name') or 'MobileOps'} · {ref}", title=f"{ref} agreement", author=generated_by)


def render_dispatch_pdf(
    dispatch: dict[str, Any], *, site: dict[str, Any], role: str, generated_by: str, generated_at: Optional[datetime] = None,
) -> bytes:
    """Outbound delivery ticket, or inbound / return pickup ticket, depending on direction."""
    st = _styles()
    generated_at = generated_at or datetime.now(timezone.utc)
    direction = str(dispatch.get("direction") or "outbound")
    title = {"outbound": "Outbound Delivery Ticket", "inbound": "Inbound / Return Pickup Ticket"}.get(direction, "Dispatch Ticket")
    ref = f"Dispatch {str(dispatch.get('id', ''))[:8]}"
    story = _letterhead(site, st, title, ref, generated_at)
    story += [Paragraph("Job", st["h"]), _kv_table([
        ("Customer", dispatch.get("customer_name")), ("Job site", dispatch.get("job_site")),
        ("Address", dispatch.get("job_address")), ("Scheduled", _fmt_dt(dispatch.get("scheduled_date"))),
        ("Status", str(dispatch.get("status", "")).replace("_", " ")), ("Rental", str(dispatch.get("rental_id") or "")[:8]),
    ], st), Paragraph("Logistics", st["h"]), _kv_table([
        ("Driver", dispatch.get("driver_name")), ("Truck", dispatch.get("truck")),
        ("Trailer", dispatch.get("trailer")), ("Crew", dispatch.get("crew")),
    ], st)]
    lines = dispatch.get("lines") or []
    rows = [[ln.get("name", ""), ln.get("sku", ""), ln.get("qty", ""),
             "" if ln.get("delivered_qty") is None else ln.get("delivered_qty"),
             "Yes" if ln.get("pickup_confirmed") else ""] for ln in lines]
    story += [Paragraph(f"Equipment ({len(lines)} line{'s' if len(lines) != 1 else ''})", st["h"]),
              _grid(["Item", "SKU", "Qty", "Delivered qty", "Pickup confirmed"], rows, st, [3.0, 1.6, 0.7, 1.1, 1.1])
              if rows else Paragraph("No equipment lines.", st["body"])]
    notes = [("Status note", dispatch.get("status_note")), ("Notes", dispatch.get("notes"))]
    if any(v for _, v in notes):
        story += [Paragraph("Notes", st["h"]), _kv_table(notes, st, cols=1)]
    story.append(_signature_block(["Driver signature / date", "Customer / site contact (signature / date)"], st))
    return _build(story, footer=f"{site.get('brand_name') or 'MobileOps'} · {ref}", title=f"{ref} {direction}", author=generated_by)
