export type DeliveryTicketLine = {
  sku?: string | null;
  name: string;
  qty: number;
  delivered_qty?: number | null;
};

export type DeliveryTicketData = {
  id: string;
  customerName: string;
  jobSite?: string;
  scheduledDate?: string | null;
  status: string;
  driverName?: string;
  truck?: string;
  trailer?: string;
  crew?: string;
  notes?: string;
  lines: DeliveryTicketLine[];
  requirements?: string[];
  planningOnly?: boolean;
};

export type DeliveryTicketSite = {
  brand_name?: string;
  tagline?: string;
  logo_base64?: string;
  company_address?: string;
  company_phone?: string;
  company_email?: string;
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;",
})[character] || character);

const displayDate = (value?: string | null) => {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
};

const displayStatus = (value: string) => value.replace(/_/g, " ");

export function buildDeliveryTicketHtml(ticket: DeliveryTicketData, site?: DeliveryTicketSite | null) {
  const lineRows = ticket.lines.map((line) => (
    `<tr><td>${escapeHtml(line.sku || "Not assigned")}</td><td>${escapeHtml(line.name)}</td><td class="qty">${escapeHtml(line.delivered_qty ?? line.qty)}</td></tr>`
  )).join("");
  const requirementRows = (ticket.requirements || []).map((requirement) => (
    `<tr><td>Planned</td><td>${escapeHtml(requirement)}</td><td class="qty">Confirm</td></tr>`
  )).join("");
  const totalUnits = ticket.lines.reduce((total, line) => total + (line.delivered_qty ?? line.qty), 0);
  const logoHtml = site?.logo_base64
    ? `<img src="${escapeHtml(site.logo_base64)}" alt="" class="logo"/>`
    : `<div class="tile"></div>`;
  const assignment = [
    ticket.driverName && `Driver: ${ticket.driverName}`,
    ticket.truck && `Truck: ${ticket.truck}`,
    ticket.trailer && `Trailer: ${ticket.trailer}`,
    ticket.crew && `Crew: ${ticket.crew}`,
  ].filter(Boolean).join(" · ");
  const footer = [site?.company_address, site?.company_phone, site?.company_email].filter(Boolean).join(" · ");

  return `<!doctype html><html><head><meta charset="utf-8"/><style>
@page{margin:0.45in}*{box-sizing:border-box}body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial;color:#0F172A;margin:0}.brand{display:flex;align-items:center;border-bottom:1px solid #E2E8F0;padding-bottom:18px;margin-bottom:22px}.logo{max-height:72px;max-width:160px;object-fit:contain;margin-right:16px}.tile{width:6px;height:40px;background:#1E3A8A;margin-right:14px;border-radius:2px}h1{margin:0;font-size:22px}.label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:#64748B;font-weight:700}.ticket-id{margin-top:5px;font-size:11px;color:#64748B}.grid{display:grid;grid-template-columns:2fr 1fr;gap:12px}.box{border:1px solid #E2E8F0;padding:14px;margin-bottom:12px;border-radius:6px}.value{font-size:14px;margin-top:4px}.customer{font-size:17px;font-weight:650}.muted{color:#475569}.notice{border-left:4px solid #D97706;background:#FFFBEB;padding:10px 12px;margin:12px 0;font-size:12px;color:#92400E}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:11px 10px;border-bottom:1px solid #E2E8F0;font-size:13px}th{background:#F8FAFC;text-transform:uppercase;font-size:10px;letter-spacing:.6px;text-align:left;color:#475569}.qty{text-align:right}.total td{font-weight:700;border-top:2px solid #CBD5E1}.sig{margin-top:52px;display:flex;gap:32px}.sig div{flex:1;border-top:1px solid #0F172A;padding-top:8px;font-size:11px;text-transform:uppercase}.footer{margin-top:30px;font-size:10px;color:#94A3B8}</style></head><body>
<div class="brand">${logoHtml}<div><h1>${escapeHtml(site?.brand_name || "Concrete Form")}</h1><div class="label">Delivery Ticket${site?.tagline ? ` · ${escapeHtml(site.tagline)}` : ""}</div><div class="ticket-id">Ticket ${escapeHtml(ticket.id)}</div></div></div>
<div class="grid"><div class="box"><div class="label">Deliver to</div><div class="value customer">${escapeHtml(ticket.customerName)}</div><div class="value muted">${escapeHtml(ticket.jobSite || "No job site entered")}</div></div><div class="box"><div class="label">Delivery date</div><div class="value">${escapeHtml(displayDate(ticket.scheduledDate))}</div><div class="value muted">${escapeHtml(displayStatus(ticket.status))}</div></div></div>
${assignment ? `<div class="box"><div class="label">Delivery assignment</div><div class="value">${escapeHtml(assignment)}</div></div>` : ""}
${ticket.planningOnly ? `<div class="notice"><strong>Planning ticket:</strong> Requirements and quantities must be confirmed before loading. This ticket does not reserve or move inventory.</div>` : ""}
<table><thead><tr><th>Item / SKU</th><th>Description</th><th class="qty">Qty</th></tr></thead><tbody>${lineRows}${requirementRows}${ticket.lines.length ? `<tr class="total"><td colspan="2">Total units</td><td class="qty">${totalUnits}</td></tr>` : ""}</tbody></table>
${ticket.notes ? `<div class="box" style="margin-top:22px"><div class="label">Delivery notes</div><div class="value">${escapeHtml(ticket.notes)}</div></div>` : ""}
<div class="sig"><div>Delivered by</div><div>Received by (signature)</div></div>
${footer ? `<div class="footer">${escapeHtml(footer)}</div>` : ""}</body></html>`;
}
