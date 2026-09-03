#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.MOBILEOPS_DEMO_API_PORT || 8001);
const backendRoot = path.resolve(__dirname, "..", "..", "backend");
const demoDataRoot = path.resolve(__dirname, "..", ".demo-data");
const statePath = process.env.MOBILEOPS_DEMO_STATE_PATH || path.join(demoDataRoot, "state.json");
const loadSeed = (name) => JSON.parse(fs.readFileSync(path.join(backendRoot, name), "utf8"));
const now = () => new Date().toISOString();
const savedState = (() => {
  try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; }
})();

const equipment = [
  { id: "demo-sb20", sku: "SB-2001", qr_code: "SB-2001", name: "20 ft Stiffback", category: "strongback", quantity: 240, available: 120, reserved: 60, on_rental: 60, pending_inspection: 0, in_maintenance: 0, location: "Yard A", condition: "good", daily_rate: 12 },
  { id: "demo-sb16", sku: "SB-1601", qr_code: "SB-1601", name: "16 ft Stiffback", category: "strongback", quantity: 180, available: 95, reserved: 35, on_rental: 50, pending_inspection: 0, in_maintenance: 0, location: "Yard A", condition: "good", daily_rate: 10 },
  { id: "demo-tb", sku: "RCTB", qr_code: "RCTB", name: "Reechcraft Turnbuckle", category: "turnbuckle", quantity: 300, available: 180, reserved: 60, on_rental: 60, pending_inspection: 0, in_maintenance: 0, location: "Yard B", condition: "good", daily_rate: 8 },
  { id: "demo-wbb", sku: "WBY-002", qr_code: "WBY-002", name: "Gen 1 Walkboard Bracket", category: "walkboard_bracket", quantity: 200, available: 110, reserved: 45, on_rental: 45, pending_inspection: 0, in_maintenance: 0, location: "Yard B", condition: "good", daily_rate: 6 },
  { id: "demo-hr", sku: "HR-001", qr_code: "HR-001", name: "Gen 1 Handrail", category: "hand_rail", quantity: 200, available: 110, reserved: 45, on_rental: 45, pending_inspection: 0, in_maintenance: 0, location: "Yard B", condition: "good", daily_rate: 4 },
  { id: "demo-ext", sku: "EXT-001", qr_code: "EXT-001", name: "Reechcraft Extension", category: "tb_extension", quantity: 160, available: 80, reserved: 40, on_rental: 40, pending_inspection: 0, in_maintenance: 0, location: "Yard A", condition: "good", daily_rate: 3 },
];

const initialBookings = [
  {
    id: "demo-booking-community-hs", customer_name: "Community HS", customer_type: "company", job_site: "Nevada · Unit J1", job_address: "Nevada, TX",
    start_date: "2026-09-18T12:00:00Z", end_date: "2026-10-18T12:00:00Z", status: "confirmed",
    items: [{ equipment_id: "demo-sb20", sku: "SB-2001", qr_code: "SB-2001", name: "20 ft Stiffback", qty: 56, returned_qty: 0, daily_rate: 12 }],
    notes: "Waiting on permit. Planning demo record.", dispatched_rental_id: null,
  },
  {
    id: "demo-booking-ferris", customer_name: "Ferris", customer_type: "company", job_site: "Ferris", job_address: "Ferris, TX",
    start_date: "2026-09-28T12:00:00Z", end_date: "2026-10-28T12:00:00Z", status: "tentative",
    items: [{ equipment_id: "demo-sb16", sku: "SB-1601", qr_code: "SB-1601", name: "16 ft Stiffback", qty: 131, returned_qty: 0, daily_rate: 10 }],
    notes: "Date and final load remain tentative.", dispatched_rental_id: null,
  },
];
let bookings = Array.isArray(savedState?.bookings) ? savedState.bookings : initialBookings;
const initialRentals = [{
  id: "demo-rental-lakeside", customer_name: "Lakeside Residence", customer_type: "homeowner", primary_contact: "Morgan Lee",
  customer_phone: "(940) 555-0148", customer_email: "morgan@example.com", preferred_contact_method: "text",
  contact_permission: true, job_site: "Lakeside Residence", job_address: "412 Lakeview Dr, Denton, TX", gate_access_instructions: "Use east gate; call on arrival",
  delivery_notes: "Keep driveway clear", return_notes: "Pickup after 2 PM", start_date: "2026-08-22T12:00:00Z",
  due_date: "2026-09-05T12:00:00Z", deposit: 0, notes: "", status: "active", lat: null, lng: null,
  delivered_by: "Demo Driver", received_by: "", created_at: now(),
  communication_log: [{ id: "demo-comm-1", channel: "text", direction: "outgoing", summary: "Delivery window confirmed for 9–11 AM.", outcome: "Customer confirmed", created_by: "Nathan", created_at: now() }],
  lines: [{ equipment_id: "demo-sb20", sku: "SB-2001", qr_code: "SB-2001", name: "20 ft Stiffback", qty: 60, daily_rate: 12, delivered_qty: 60, returned_qty: 0, damaged_qty: 0 }],
}];
let rentals = (Array.isArray(savedState?.rentals) && savedState.rentals.length ? savedState.rentals : initialRentals).map((rental) => ({ customer_type: "company", job_address: "", ...rental }));
const initialContacts = [
  { id: "demo-contact-lakeside", company: "Lakeside Residence", contact: "Morgan Lee", phone: "(940) 555-0148", email: "morgan@example.com", business_address: "412 Lakeview Dr, Denton, TX", is_homeowner: true, follows_current_job: true, notes: "" },
  { id: "demo-contact-acme", company: "Acme ICF Supply", contact: "John D.", phone: "555-0100", email: "sales@acme-icf.com", business_address: "100 Industrial Way", is_homeowner: false, follows_current_job: false, notes: "" },
];
let contacts = Array.isArray(savedState?.contacts) && savedState.contacts.length ? savedState.contacts : initialContacts;
let dashboardItems = Array.isArray(savedState?.dashboardItems) ? savedState.dashboardItems : [];
let inventoryCounts = [];

const minutesAgo = (mins) => new Date(Date.now() - mins * 60000).toISOString();
const initialWhiteboardMessages = [
  { id: "demo-wb-1", thread_id: "dashboard", parent_id: null, body: "Community HS delivery is loaded, rolling out at 7 AM.", author_type: "user", author_id: "demo-driver", author_name: "Alex Rivera", author_avatar: "AR", agent_label: null, created_at: minutesAgo(60 * 26), edited_at: null, is_deleted: false, pinned: true, invocation_status: null, invocation_error: null, mentions: [], attachments: [], reply_count: 1 },
  { id: "demo-wb-2", thread_id: "dashboard", parent_id: "demo-wb-1", body: "Copy that, I'll meet the truck on site at 8.", author_type: "user", author_id: "demo-user", author_name: "Demo Operator", author_avatar: "DO", agent_label: null, created_at: minutesAgo(60 * 25), edited_at: null, is_deleted: false, pinned: false, invocation_status: null, invocation_error: null, mentions: [], attachments: [], reply_count: 0 },
  { id: "demo-wb-3", thread_id: "dashboard", parent_id: null, body: "@Nathan how many 20 ft stiffbacks are available right now?", author_type: "user", author_id: "demo-user", author_name: "Demo Operator", author_avatar: "DO", agent_label: null, created_at: minutesAgo(40), edited_at: null, is_deleted: false, pinned: false, invocation_status: null, invocation_error: null, mentions: [{ id: "m1", entity_type: "agent", entity_id: "nathan", handle: "Nathan", display_name: "Nathan" }], attachments: [], reply_count: 0 },
  { id: "demo-wb-4", thread_id: "dashboard", parent_id: null, body: "120 available in Yard A, plus 60 more on rental due back from Lakeside Residence on Sep 5.", author_type: "agent", author_id: "nathan", author_name: "Nathan", author_avatar: "N", agent_label: "AI Agent", created_at: minutesAgo(39), edited_at: null, is_deleted: false, pinned: false, invocation_status: "complete", invocation_error: null, mentions: [], attachments: [], reply_count: 0 },
  { id: "demo-wb-5", thread_id: "dashboard", parent_id: null, body: "Uploading the signed Ferris rental agreement.", author_type: "user", author_id: "demo-user", author_name: "Demo Operator", author_avatar: "DO", agent_label: null, created_at: minutesAgo(12), edited_at: null, is_deleted: false, pinned: false, invocation_status: null, invocation_error: null, mentions: [], attachments: [{ id: "demo-att-1", filename: "ferris-agreement-signed.pdf", content_type: "application/pdf", size: 182300 }], reply_count: 0 },
  { id: "demo-wb-6", thread_id: "dashboard", parent_id: null, body: "@Nathan flag any equipment overdue for return this week.", author_type: "user", author_id: "demo-ops2", author_name: "Jamie Cole", author_avatar: "JC", agent_label: null, created_at: minutesAgo(3), edited_at: null, is_deleted: false, pinned: false, invocation_status: "failed", invocation_error: "Agent timed out", mentions: [{ id: "m2", entity_type: "agent", entity_id: "nathan", handle: "Nathan", display_name: "Nathan" }], attachments: [], reply_count: 0 },
];
let whiteboardMessages = Array.isArray(savedState?.whiteboardMessages) ? savedState.whiteboardMessages : initialWhiteboardMessages;
const whiteboardMentionables = [
  { id: "nathan", handle: "Nathan", display_name: "Nathan", entity_type: "agent", label: "AI operations agent" },
  { id: "demo-ops2", handle: "jamie", display_name: "Jamie Cole", entity_type: "user", label: "Operations" },
  { id: "demo-driver", handle: "alex", display_name: "Alex Rivera", entity_type: "user", label: "Driver" },
];

const seededDispatches = [
  ...loadSeed("outbound_plan_seed.json").map((row) => ({
    id: row.source_key, direction: row.status === "active_rental" ? "inbound" : "outbound", planning_only: true, lines: [], truck: "", trailer: "", crew: "", driver_name: "", created_by: "Demo import", created_at: now(), updated_at: now(), ...row,
  })),
  ...loadSeed("inbound_plan_seed.json").map((row) => ({
    id: row.source_key, direction: "inbound", planning_only: true, lines: [], truck: "", trailer: "", crew: "", driver_name: "", created_by: "Demo import", created_at: now(), updated_at: now(), ...row,
  })),
];
const savedDispatches = new Map((Array.isArray(savedState?.dispatches) ? savedState.dispatches : []).map((item) => [item.id, item]));
const normalizeDeliveredPlan = (item) => item.planning_only && item.direction === "outbound" && ["completed", "partially_delivered", "active_rental"].includes(item.status)
  ? { ...item, direction: "inbound", status: "active_rental", rental_completed: false, completed_at: null, updated_at: now() }
  : item;
const dispatches = seededDispatches.map((item) => normalizeDeliveredPlan(savedDispatches.get(item.id) || item));

function persistState() {
  fs.mkdirSync(demoDataRoot, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ bookings, rentals, contacts, dispatches, dashboardItems, whiteboardMessages }, null, 2));
}

function contactWithCurrentJob(contact) {
  const key = (value) => String(value || "").trim().toLowerCase();
  const rental = (contact.follows_current_job || contact.is_homeowner) ? [...rentals].reverse().find((item) => item.status !== "returned" && (
    key(item.customer_email) === key(contact.email)
    || key(item.customer_phone) === key(contact.phone)
    || key(item.customer_name) === key(contact.company)
    || key(item.job_site) === key(contact.company)
  )) : null;
  return {
    ...contact,
    company: contact.is_homeowner && rental?.job_site ? rental.job_site : contact.company,
    current_job_site: rental?.job_site || "",
    current_job_address: rental ? rental.job_address || rental.job_site || "" : "",
    current_job_lat: rental?.lat ?? null,
    current_job_lng: rental?.lng ?? null,
    current_rental_id: rental?.id || null,
  };
}

const site = {
  brand_name: "Concrete Form",
  tagline: "ICF Field Tools",
  logo_base64: "",
  primary_color: "#FF6A00",
  company_address: "1586 Seaborn Dr, Ponder, TX 76259",
  company_phone: "",
  company_email: "",
  shop_lat: 33.1622357,
  shop_lng: -97.2596744,
};

function send(res, status, body) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Content-Type": "application/json",
  });
  res.end(body === undefined ? "" : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = "";
    req.on("data", (chunk) => { value += chunk; });
    req.on("end", () => {
      try { resolve(value ? JSON.parse(value) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

function capacityRows() {
  return equipment.map((item) => ({
    equipment_id: item.id, sku: item.sku, qr_code: item.qr_code, name: item.name, category: item.category,
    quantity: item.quantity, committed: item.reserved + item.on_rental, available: item.available,
  }));
}

function composeJobs() {
  const coveredBookingIds = new Set(rentals.map((rental) => rental.booking_id).filter(Boolean));
  const rentalJobs = rentals.map((rental) => {
    const booking = bookings.find((item) => item.id === rental.booking_id);
    const lines = (rental.lines || []).map((line) => {
      const delivered = line.delivered_qty ?? line.qty;
      const returned = line.returned_qty || 0;
      return {
        equipment_id: line.equipment_id, sku: line.sku, name: line.name,
        qty_ordered: line.qty, qty_delivered: delivered,
        qty_on_site: Math.max(0, delivered - returned),
        qty_returned: returned, qty_damaged: line.damaged_qty || 0,
      };
    });
    const inbound = dispatches.find((item) => !item.planning_only && item.direction === "inbound" && item.rental_id === rental.id && !["completed", "cancelled"].includes(item.status));
    const status = rental.status === "returned" ? "closed"
      : inbound?.status === "scheduled" ? "pickup_requested"
      : inbound ? "inbound" : "on_job";
    return {
      id: rental.id, booking_id: rental.booking_id || null, rental_id: rental.id,
      active_outbound_dispatch_id: null, active_inbound_dispatch_id: inbound?.id || null,
      status, customer_name: rental.customer_name, job_site: rental.job_site || "",
      start_date: rental.start_date || null, end_date: booking?.end_date || rental.due_date || null,
      lines, qty_outstanding: lines.reduce((sum, line) => sum + line.qty_on_site, 0),
      is_standalone_rental: !rental.booking_id, cancelled: false, created_at: rental.created_at || null,
    };
  });
  const bookingJobs = bookings.filter((booking) => !coveredBookingIds.has(booking.id)).map((booking) => {
    const outbound = dispatches.find((item) => !item.planning_only && item.direction === "outbound" && item.booking_id === booking.id && !["completed", "cancelled"].includes(item.status));
    const outboundStatus = outbound?.status;
    const status = booking.status === "cancelled" ? "closed"
      : ["ready", "loaded", "dispatched", "arrived"].includes(outboundStatus) ? "outbound"
      : ["scheduled", "staging"].includes(outboundStatus) ? "staging"
      : booking.status === "confirmed" ? "reserved" : "planned";
    return {
      id: booking.id, booking_id: booking.id, rental_id: null,
      active_outbound_dispatch_id: outbound?.id || null, active_inbound_dispatch_id: null,
      status, customer_name: booking.customer_name, job_site: booking.job_site || "",
      start_date: booking.start_date || null, end_date: booking.end_date || null,
      lines: (booking.items || []).map((line) => ({
        equipment_id: line.equipment_id, sku: line.sku, name: line.name,
        qty_ordered: line.qty, qty_delivered: 0, qty_on_site: 0, qty_returned: 0, qty_damaged: 0,
      })),
      qty_outstanding: 0, is_standalone_rental: false,
      cancelled: booking.status === "cancelled", created_at: booking.created_at || null,
    };
  });
  return [...rentalJobs, ...bookingJobs];
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  const route = url.pathname.replace(/\/$/, "") || "/";

  try {
    if (req.method === "GET" && route === "/api") return send(res, 200, { service: "MobileOps Demo API", mode: "local-demo" });
    if (req.method === "GET" && route === "/health") return send(res, 200, { status: "ok" });
    if (req.method === "GET" && route === "/api/auth/me") return send(res, 200, { id: "demo-user", email: "demo@mobileops.local", name: "Demo Operator", role: "admin" });
    if (req.method === "GET" && route === "/api/equipment") return send(res, 200, equipment);
    if (req.method === "GET" && route === "/api/bookings") return send(res, 200, bookings);
    if (req.method === "GET" && route === "/api/bookings/capacity") return send(res, 200, { target_date: url.searchParams.get("target_date"), rows: capacityRows() });
    if (req.method === "GET" && route === "/api/dispatches") return send(res, 200, dispatches);
    if (req.method === "GET" && route === "/api/rentals") return send(res, 200, rentals);
    if (req.method === "GET" && route === "/api/jobs") return send(res, 200, composeJobs());
    if (req.method === "GET" && route === "/api/site") return send(res, 200, site);
    if (req.method === "GET" && route === "/api/dashboard/stats") return send(res, 200, {
      total_quantity: equipment.reduce((sum, item) => sum + item.quantity, 0),
      total_available: equipment.reduce((sum, item) => sum + item.available, 0),
      total_reserved: equipment.reduce((sum, item) => sum + item.reserved, 0),
      total_on_rental: equipment.reduce((sum, item) => sum + item.on_rental, 0),
      total_pending_inspection: 0, returning_today: 0, active_rentals: rentals.length,
      open_maintenance: 0, open_shop_tasks: 0, shortage_count: 0, contacts_count: contacts.length, vendors_count: contacts.length,
      activity: [{ type: "demo", title: "Local demo data loaded", ts: now() }],
    });
    if (req.method === "GET" && route === "/api/dashboard/shortages") return send(res, 200, { rows: [] });
    if (req.method === "GET" && route === "/api/dashboard/items") return send(res, 200, dashboardItems.filter((item) => item.status === "open"));
    if (req.method === "GET" && route === "/api/inventory-counts") return send(res, 200, inventoryCounts);
    if (req.method === "GET" && route === "/api/contacts") return send(res, 200, contacts.map(contactWithCurrentJob));
    if (req.method === "GET" && ["/api/shop-tasks", "/api/maintenance", "/api/vendors", "/api/transfers", "/api/ledger-entries"].includes(route)) return send(res, 200, []);

    if (req.method === "POST" && route === "/api/contacts") {
      const body = await readBody(req);
      const contact = { id: `demo-contact-${randomUUID()}`, ...body, created_at: now() };
      contacts.push(contact);
      persistState();
      return send(res, 201, contactWithCurrentJob(contact));
    }
    const contactRoute = route.match(/^\/api\/contacts\/([^/]+)$/);
    if (contactRoute && req.method === "PUT") {
      const contact = contacts.find((item) => item.id === decodeURIComponent(contactRoute[1]));
      if (!contact) return send(res, 404, { detail: "Contact not found" });
      Object.assign(contact, await readBody(req));
      persistState();
      return send(res, 200, contactWithCurrentJob(contact));
    }
    if (contactRoute && req.method === "DELETE") {
      const index = contacts.findIndex((item) => item.id === decodeURIComponent(contactRoute[1]));
      if (index < 0) return send(res, 404, { detail: "Contact not found" });
      contacts.splice(index, 1);
      persistState();
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && route === "/api/yard-counts") {
      const body = await readBody(req);
      let item = equipment.find((entry) => entry.id === body.equipment_id)
        || equipment.find((entry) => entry.name.toLowerCase() === String(body.equipment_type || "").toLowerCase());
      const expected = item?.available || 0;
      if (!item) {
        item = { id: `demo-yard-${randomUUID()}`, sku: `YARD-${randomUUID().slice(0, 6)}`, qr_code: null, name: body.equipment_type, category: "strongback", quantity: body.quantity, available: body.quantity, reserved: 0, on_rental: 0, pending_inspection: 0, in_maintenance: 0, location: body.yard_location, condition: body.condition, notes: body.notes, daily_rate: 0 };
        equipment.push(item);
      } else {
        item.quantity += Number(body.quantity) - item.available;
        item.available = Number(body.quantity);
        item.location = body.yard_location;
        item.condition = body.condition;
        item.notes = body.notes || item.notes;
      }
      const count = { id: `demo-count-${randomUUID()}`, equipment_id: item.id, equipment_name: item.name, counted_qty: Number(body.quantity), expected_qty: expected, variance: Number(body.quantity) - expected, status: "reconciled", reason: "Authoritative yard count", counted_by: "Demo Operator", counted_at: now(), reconciled_by: "Demo Operator", reconciled_at: now(), condition: body.condition, yard_location: body.yard_location, notes: body.notes, authoritative: true };
      inventoryCounts.unshift(count);
      return send(res, 201, count);
    }

    const rentalCommunication = route.match(/^\/api\/rentals\/([^/]+)\/communications$/);
    if (rentalCommunication && req.method === "POST") {
      const rental = rentals.find((item) => item.id === decodeURIComponent(rentalCommunication[1]));
      if (!rental) return send(res, 404, { detail: "Rental not found" });
      const body = await readBody(req);
      if (body.direction === "outgoing" && !rental.contact_permission) return send(res, 409, { detail: "Outgoing contact is blocked until Contact Permission is enabled" });
      const entry = { id: `demo-comm-${randomUUID()}`, ...body, created_by: "Demo Operator", created_at: now() };
      rental.communication_log = [entry, ...(rental.communication_log || [])];
      persistState();
      return send(res, 201, entry);
    }

    if (req.method === "POST" && route === "/api/bookings") {
      const body = await readBody(req);
      const booking = { id: `demo-booking-${randomUUID()}`, dispatched_rental_id: null, ...body };
      bookings.push(booking);
      persistState();
      return send(res, 201, booking);
    }
    if (req.method === "POST" && route === "/api/dashboard/items") {
      const body = await readBody(req);
      if (!["delivery", "important", "order", "note"].includes(body.kind) || !String(body.title || "").trim()) {
        return send(res, 400, { detail: "A valid type and title are required" });
      }
      const item = {
        id: `demo-dashboard-${randomUUID()}`,
        kind: body.kind,
        title: String(body.title).trim(),
        details: String(body.details || "").trim(),
        due_date: body.due_date || null,
        status: "open",
        created_by: "Demo Operator",
        created_at: now(),
        completed_by: "",
        completed_at: null,
      };
      dashboardItems.unshift(item);
      persistState();
      return send(res, 201, item);
    }
    const dashboardItemStatus = route.match(/^\/api\/dashboard\/items\/([^/]+)\/status$/);
    if (req.method === "PATCH" && dashboardItemStatus) {
      const item = dashboardItems.find((entry) => entry.id === decodeURIComponent(dashboardItemStatus[1]));
      if (!item) return send(res, 404, { detail: "Dashboard item not found" });
      const body = await readBody(req);
      if (!["open", "done"].includes(body.status)) return send(res, 400, { detail: "Invalid status" });
      item.status = body.status;
      item.completed_by = body.status === "done" ? "Demo Operator" : "";
      item.completed_at = body.status === "done" ? now() : null;
      persistState();
      return send(res, 200, item);
    }
    const bookingDelete = route.match(/^\/api\/bookings\/([^/]+)$/);
    if (req.method === "DELETE" && bookingDelete) {
      bookings = bookings.filter((booking) => booking.id !== bookingDelete[1]);
      persistState();
      return send(res, 204);
    }
    const bookingDispatch = route.match(/^\/api\/bookings\/([^/]+)\/dispatch$/);
    if (req.method === "POST" && bookingDispatch) {
      const booking = bookings.find((item) => item.id === bookingDispatch[1]);
      if (!booking) return send(res, 404, { detail: "Booking not found" });
      let delivery = dispatches.find((item) => item.direction === "outbound" && item.booking_id === booking.id && item.status !== "cancelled");
      if (!delivery) {
        delivery = {
          id: `demo-delivery-${randomUUID()}`, direction: "outbound", status: "scheduled",
          scheduled_date: booking.start_date, date_confirmed: true,
          customer_name: booking.customer_name, customer_type: booking.customer_type || "company", job_site: booking.job_site || "", job_address: booking.job_address || "", lat: booking.lat ?? null, lng: booking.lng ?? null, booking_id: booking.id,
          rental_id: null, driver_name: "", truck: "", trailer: "", crew: "", notes: booking.notes || "",
          lines: (booking.items || []).map((line) => ({ equipment_id: line.equipment_id, sku: line.sku, name: line.name, qty: line.qty, delivered_qty: null, pickup_confirmed: false })),
          planning_only: false, created_by: "Demo Operator", created_at: now(), updated_at: now(),
        };
        dispatches.push(delivery);
      }
      persistState();
      return send(res, 201, delivery);
    }
    const rentalPickup = route.match(/^\/api\/rentals\/([^/]+)\/(schedule-pickup|complete)$/);
    if (req.method === "POST" && rentalPickup) {
      const rental = rentals.find((item) => item.id === decodeURIComponent(rentalPickup[1]));
      if (!rental) return send(res, 404, { detail: "Rental not found" });
      const body = await readBody(req);
      const adminCompleted = rentalPickup[2] === "complete";
      let pickup = dispatches.find((item) => item.direction === "inbound" && item.rental_id === rental.id && !["completed", "cancelled"].includes(item.status));
      if (pickup && !adminCompleted) return send(res, 400, { detail: "A pickup is already scheduled for this rental" });
      if (!pickup) {
        pickup = {
          id: `demo-pickup-${randomUUID()}`, direction: "inbound", status: "scheduled",
          rental_id: rental.id, rental_completed: adminCompleted,
          scheduled_date: body.scheduled_date || null, date_confirmed: !!body.scheduled_date,
          customer_name: rental.customer_name, customer_type: rental.customer_type || "company", job_site: rental.job_site || "", job_address: rental.job_address || "", driver_name: body.driver_name || "",
          truck: body.truck || "", trailer: body.trailer || "", crew: body.crew || "", notes: body.notes || "",
          lines: (rental.lines || []).filter((line) => (line.delivered_qty || line.qty) > (line.returned_qty || 0)).map((line) => ({
            equipment_id: line.equipment_id, sku: line.sku, name: line.name,
            qty: (line.delivered_qty || line.qty) - (line.returned_qty || 0),
          })),
          planning_only: false, created_by: "Demo Operator", created_at: now(), updated_at: now(),
        };
        dispatches.push(pickup);
      } else {
        Object.assign(pickup, {
          rental_completed: true,
          scheduled_date: body.scheduled_date || null,
          date_confirmed: !!body.scheduled_date,
          updated_at: now(),
        });
      }
      persistState();
      return send(res, 201, pickup);
    }
    const planningRentalComplete = route.match(/^\/api\/dispatches\/([^/]+)\/complete-rental$/);
    if (req.method === "POST" && planningRentalComplete) {
      const item = dispatches.find((dispatch) => dispatch.id === decodeURIComponent(planningRentalComplete[1]));
      if (!item) return send(res, 404, { detail: "Dispatch not found" });
      if (!item.planning_only || item.status !== "active_rental") return send(res, 400, { detail: "Only a delivered planning rental can be completed" });
      const body = await readBody(req);
      Object.assign(item, {
        direction: "inbound", status: "ready_for_pickup",
        scheduled_date: body.scheduled_date || null, date_confirmed: !!body.scheduled_date,
        updated_at: now(), completed_at: null,
      });
      persistState();
      return send(res, 200, item);
    }
    const dispatchTicketComplete = route.match(/^\/api\/dispatches\/([^/]+)\/complete-ticket$/);
    if (req.method === "POST" && dispatchTicketComplete) {
      const item = dispatches.find((dispatch) => dispatch.id === decodeURIComponent(dispatchTicketComplete[1]));
      if (!item) return send(res, 404, { detail: "Dispatch not found" });
      const body = await readBody(req);
      if (!Array.isArray(body.lines) || body.lines.length !== item.lines.length) return send(res, 400, { detail: "Every product on the ticket must be confirmed" });
      if (item.direction === "outbound") {
        if (body.lines.some((line) => line.delivered_qty == null)) return send(res, 400, { detail: "Enter every delivered quantity" });
        item.lines = item.lines.map((line, index) => ({ ...line, delivered_qty: Number(body.lines[index].delivered_qty) }));
        const rental = {
          id: `demo-rental-${randomUUID()}`, booking_id: item.booking_id || null,
          customer_name: item.customer_name, customer_type: item.customer_type || "company", customer_phone: "", customer_email: "", primary_contact: "",
          preferred_contact_method: "call", contact_permission: false, communication_log: [],
          job_site: item.job_site || "", job_address: item.job_address || "", start_date: item.scheduled_date || now(), due_date: null,
          status: "active", lines: item.lines.filter((line) => line.delivered_qty > 0).map((line) => ({
            equipment_id: line.equipment_id, sku: line.sku, name: line.name, qty: line.delivered_qty,
            delivered_qty: line.delivered_qty, returned_qty: 0, damaged_qty: 0, daily_rate: 0,
          })), lat: item.lat ?? null, lng: item.lng ?? null, notes: "", delivered_by: "Demo Operator", received_by: "",
        };
        rentals.push(rental);
        item.rental_id = rental.id;
        const booking = bookings.find((entry) => entry.id === item.booking_id);
        if (booking) {
          booking.status = "dispatched";
          booking.dispatched_rental_id = rental.id;
        }
      } else {
        if (body.lines.some((line) => !line.pickup_confirmed)) return send(res, 400, { detail: "Check every picked-up product" });
        item.lines = item.lines.map((line) => ({ ...line, pickup_confirmed: true }));
        const rental = rentals.find((entry) => entry.id === item.rental_id);
        if (rental) {
          rental.lines = rental.lines.map((line) => ({ ...line, returned_qty: line.delivered_qty || line.qty }));
          rental.status = "returned";
        }
        item.lines.forEach((line) => {
          const equipmentItem = equipment.find((entry) => entry.id === line.equipment_id);
          if (!equipmentItem) return;
          equipmentItem.on_rental = Math.max(0, Number(equipmentItem.on_rental || 0) - Number(line.qty || 0));
          equipmentItem.pending_inspection = Number(equipmentItem.pending_inspection || 0) + Number(line.qty || 0);
        });
      }
      item.status = "completed";
      item.completed_at = now();
      item.updated_at = now();
      persistState();
      return send(res, 200, item);
    }
    const dispatchStatus = route.match(/^\/api\/dispatches\/([^/]+)\/status$/);
    if (req.method === "PATCH" && dispatchStatus) {
      const item = dispatches.find((dispatch) => dispatch.id === decodeURIComponent(dispatchStatus[1]));
      if (!item) return send(res, 404, { detail: "Dispatch not found" });
      const body = await readBody(req);
      if (!item.planning_only && body.status === "completed") return send(res, 400, { detail: "Complete the driver ticket for every product" });
      if (item.planning_only && item.direction === "outbound" && body.status === "active_rental") {
        item.direction = "inbound";
        item.status = "active_rental";
        item.completed_at = null;
      } else if (item.planning_only && item.direction === "inbound" && item.status === "active_rental" && body.status === "ready_for_pickup") {
        item.status = "ready_for_pickup";
        item.completed_at = null;
      } else {
        item.status = body.status;
      }
      item.updated_at = now();
      if (["completed", "cancelled"].includes(body.status)) item.completed_at = now();
      persistState();
      return send(res, 200, item);
    }
    const dispatchAssign = route.match(/^\/api\/dispatches\/([^/]+)\/assign$/);
    if (req.method === "PATCH" && dispatchAssign) {
      const item = dispatches.find((dispatch) => dispatch.id === decodeURIComponent(dispatchAssign[1]));
      if (!item) return send(res, 404, { detail: "Dispatch not found" });
      const body = await readBody(req);
      Object.assign(item, body, {
        ...(Object.prototype.hasOwnProperty.call(body, "scheduled_date") ? { date_confirmed: !!body.scheduled_date } : {}),
        updated_at: now(),
      });
      persistState();
      return send(res, 200, item);
    }
    const equipmentInspect = route.match(/^\/api\/equipment\/([^/]+)\/inspect$/);
    if (req.method === "POST" && equipmentInspect) {
      const item = equipment.find((entry) => entry.id === decodeURIComponent(equipmentInspect[1]));
      if (!item) return send(res, 404, { detail: "Equipment not found" });
      const body = await readBody(req);
      const qty = Number(body.qty || 0);
      if (qty <= 0 || qty > Number(item.pending_inspection || 0)) return send(res, 400, { detail: "qty exceeds units pending inspection" });
      item.pending_inspection -= qty;
      if (body.outcome === "available") {
        item.available += qty;
        item.location = body.yard_location || "Yard";
      } else {
        item.in_maintenance = Number(item.in_maintenance || 0) + qty;
      }
      persistState();
      return send(res, 200, item);
    }

    if (req.method === "GET" && route === "/api/whiteboard/messages") {
      const limit = Number(url.searchParams.get("limit") || 80);
      return send(res, 200, whiteboardMessages.slice(-limit));
    }
    if (req.method === "GET" && route === "/api/whiteboard/mentionables") return send(res, 200, whiteboardMentionables);
    if (req.method === "GET" && route === "/api/whiteboard/unread") return send(res, 200, { count: 0 });
    if (req.method === "POST" && route === "/api/whiteboard/read") return send(res, 200, { ok: true });
    if (req.method === "POST" && route === "/api/whiteboard/messages") {
      const body = await readBody(req);
      if (!String(body.body || "").trim()) return send(res, 400, { detail: "Message body is required" });
      const message = {
        id: `demo-wb-${randomUUID()}`, thread_id: body.thread_id || "dashboard", parent_id: body.parent_id || null,
        body: String(body.body).trim(), author_type: "user", author_id: "demo-user", author_name: "Demo Operator", author_avatar: "DO",
        agent_label: null, created_at: now(), edited_at: null, is_deleted: false, pinned: false,
        invocation_status: null, invocation_error: null, mentions: [], attachments: [], reply_count: 0,
      };
      whiteboardMessages.push(message);
      if (body.parent_id) {
        const parent = whiteboardMessages.find((entry) => entry.id === body.parent_id);
        if (parent) parent.reply_count = (parent.reply_count || 0) + 1;
      }
      persistState();
      return send(res, 201, message);
    }
    const whiteboardAttachments = route.match(/^\/api\/whiteboard\/messages\/([^/]+)\/attachments$/);
    if (req.method === "POST" && whiteboardAttachments) {
      const message = whiteboardMessages.find((entry) => entry.id === decodeURIComponent(whiteboardAttachments[1]));
      if (!message) return send(res, 404, { detail: "Message not found" });
      return send(res, 200, message);
    }
    const whiteboardPin = route.match(/^\/api\/whiteboard\/messages\/([^/]+)\/pin$/);
    if (req.method === "PATCH" && whiteboardPin) {
      const message = whiteboardMessages.find((entry) => entry.id === decodeURIComponent(whiteboardPin[1]));
      if (!message) return send(res, 404, { detail: "Message not found" });
      const body = await readBody(req);
      message.pinned = !!body.pinned;
      persistState();
      return send(res, 200, message);
    }
    const whiteboardMessage = route.match(/^\/api\/whiteboard\/messages\/([^/]+)$/);
    if (req.method === "PATCH" && whiteboardMessage) {
      const message = whiteboardMessages.find((entry) => entry.id === decodeURIComponent(whiteboardMessage[1]));
      if (!message) return send(res, 404, { detail: "Message not found" });
      const body = await readBody(req);
      message.body = String(body.body || "").trim();
      message.edited_at = now();
      persistState();
      return send(res, 200, message);
    }
    if (req.method === "DELETE" && whiteboardMessage) {
      const message = whiteboardMessages.find((entry) => entry.id === decodeURIComponent(whiteboardMessage[1]));
      if (!message) return send(res, 404, { detail: "Message not found" });
      message.is_deleted = true;
      message.body = "";
      persistState();
      return send(res, 200, message);
    }

    return send(res, 404, { detail: `Demo route not implemented: ${req.method} ${route}` });
  } catch (error) {
    return send(res, 500, { detail: error.message || "Demo API error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MobileOps demo API ready at http://localhost:${PORT}`);
});
