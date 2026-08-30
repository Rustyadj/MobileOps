"""Concrete Form — FastAPI backend.

Single-file backend for an ICF/concrete contractor field-ops app.
Modules: Auth (JWT + RBAC), Equipment, Rentals, Bookings, Maintenance,
Vendors, Site Admin (brand + logo), Bracing Engine, Dashboard, Push relay.
"""
from __future__ import annotations

import csv
import asyncio
import io
import json
import logging
import math
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone, date
from enum import Enum
from pathlib import Path
from typing import Any, List, Optional

import httpx
from bson import ObjectId  # noqa: F401  (kept for type hints)
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException, Request, UploadFile, File, Response, WebSocket, WebSocketDisconnect, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import PlainTextResponse
from pymongo.errors import DuplicateKeyError
from jose import JWTError, jwt
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
from whiteboard_service import HermesNathanGateway, build_nathan_prompt, mentioned_handles, normalize_handle
from pydantic import BaseModel, EmailStr, Field, field_validator
from starlette.middleware.cors import CORSMiddleware

# ----------------------------- Config & DB --------------------------------
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
JWT_SECRET = os.environ["JWT_SECRET_KEY"]
JWT_REFRESH_SECRET = os.environ["JWT_REFRESH_SECRET_KEY"]
ACCESS_TTL_MIN = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MIN", "60"))
REFRESH_TTL_DAYS = int(os.environ.get("REFRESH_TOKEN_EXPIRE_DAYS", "30"))
ADMIN_EMAIL = os.environ["ADMIN_EMAIL"]
ADMIN_PASSWORD = os.environ["ADMIN_PASSWORD"]
# Self-service account creation through public /auth/signup is gated so a
# stranger with an email address can't hand themselves a crew account and
# start reading rentals/equipment/job-site data.
# Configure ONE of:
#   SIGNUP_ALLOWED_DOMAINS — comma-separated list of email domains ("acme.com,
#     acme-icf.com") that may self-provision a crew account.
#   SIGNUP_INVITE_CODES — comma-separated list of one-time-ish shared invite
#     codes; SignupReq.invite_code must match one.
# If neither is set, self-service signup is disabled entirely — accounts must
# be created by an admin via POST /auth/register.
SIGNUP_ALLOWED_DOMAINS = {
    d.strip().lower().lstrip("@")
    for d in os.environ.get("SIGNUP_ALLOWED_DOMAINS", "").split(",")
    if d.strip()
}
SIGNUP_INVITE_CODES = {
    c.strip() for c in os.environ.get("SIGNUP_INVITE_CODES", "").split(",") if c.strip()
}


def _signup_authorized(email: str, invite_code: Optional[str]) -> bool:
    domain = email.rsplit("@", 1)[-1].lower()
    if SIGNUP_ALLOWED_DOMAINS and domain in SIGNUP_ALLOWED_DOMAINS:
        return True
    if SIGNUP_INVITE_CODES and invite_code and invite_code.strip() in SIGNUP_INVITE_CODES:
        return True
    return False


client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("concrete_form")

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ----------------------------- Constants ----------------------------------
class Role(str, Enum):
    admin = "admin"
    foreman = "foreman"
    crew = "crew"


ROLE_ORDER = {Role.crew: 1, Role.foreman: 2, Role.admin: 3}

# Single source of truth for the Booking/Rental/Dispatch status literals.
# Plain string constants (not str Enum) on purpose — these values are stored
# directly in Mongo docs and round-tripped through pydantic `status: str`
# fields with no wire-format change; wrapping them in Enum risks Mongo/BSON
# or pydantic serializing something other than the plain string. Every value
# here is unchanged from what was previously hardcoded at each call site —
# this is a pure refactor, not a status redesign. Frontend mirror:
# frontend/src/domain/status.ts — keep the two in sync by hand.
class RentalStatus:
    ACTIVE = "active"
    PARTIALLY_RETURNED = "partially_returned"
    RETURNED = "returned"
    # Still committing inventory (on_rental) — not yet fully back.
    OPEN = (ACTIVE, PARTIALLY_RETURNED)
    ALL = (ACTIVE, PARTIALLY_RETURNED, RETURNED)


class BookingStatus:
    TENTATIVE = "tentative"
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"
    DISPATCHED = "dispatched"
    # Still holding a reservation (units sit in the "reserved" bucket).
    OPEN = (TENTATIVE, CONFIRMED)
    ALL = (TENTATIVE, CONFIRMED, CANCELLED, DISPATCHED)


class DispatchStatus:
    SCHEDULED = "scheduled"
    STAGING = "staging"
    READY = "ready"
    LOADED = "loaded"
    DISPATCHED = "dispatched"
    ARRIVED = "arrived"
    RETURNING = "returning"
    AT_YARD = "at_yard"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    # Planning-only reminder statuses — not part of DISPATCH_FLOWS, see
    # update_dispatch_status's `planning_only` branch.
    ACTIVE_RENTAL = "active_rental"
    READY_FOR_PICKUP = "ready_for_pickup"
    TERMINAL = (COMPLETED, CANCELLED)


# Dollar figures (rates, deposits, maintenance costs) are a pricing/business
# concern for foreman+ only — crew accounts don't need them and shouldn't see
# them. Zeroed rather than omitted so response shapes stay stable for clients.
def redact_money_for_crew(doc: dict, role: str) -> dict:
    if role == Role.crew.value:
        if "daily_rate" in doc:
            doc["daily_rate"] = 0.0
        if "deposit" in doc:
            doc["deposit"] = 0.0
        if "cost" in doc:
            doc["cost"] = 0.0
        for line in doc.get("lines") or []:
            if isinstance(line, dict) and "daily_rate" in line:
                line["daily_rate"] = 0.0
        for line in doc.get("items") or []:
            if isinstance(line, dict) and "daily_rate" in line:
                line["daily_rate"] = 0.0
    return doc

EQUIPMENT_CATEGORIES = [
    "tool",
    "strongback",
    "turnbuckle",
    "walkboard_bracket",
    "hand_rail",
    "tb_extension",
    "crankup_scaffold",
    "shoring_post",
    "icf_block_nudura",
    "icf_block_foxblocks",
    "icf_block_amvic",
    "icf_block_buildblock",
]

# The rental yard's canonical bulk-equipment catalog. Startup reconciliation
# inserts only missing SKUs and never changes counts/buckets on existing rows.
# `legacy_names` lets the six original generic seed records receive useful
# names while preserving every quantity already recorded against them.
BRACING_CATALOG = [
    ("SB-001", "Steel Stiffback — 8 ft", "strongback", ("8 ft Strongback",)),
    ("SB-1001", "Steel Stiffback — 10 ft", "strongback", ()),
    ("SB-1201", "Steel Stiffback — 12 ft", "strongback", ()),
    ("SB-1601", "Steel Stiffback — 16 ft", "strongback", ()),
    ("SB-2001", "Steel Stiffback — 20 ft", "strongback", ()),
    ("ASB-0801", "Aluminum Stiffback — 8 ft", "strongback", ()),
    ("ASB-0901", "Aluminum Stiffback — 9 ft", "strongback", ()),
    ("ASB-1201", "Aluminum Stiffback — 12 ft", "strongback", ()),

    ("TB-001", "Nudura Gen 1 Turnbuckle", "turnbuckle", ("Turnbuckle 10 ft",)),
    ("G2TB", "Nudura Gen 2 Green Turnbuckle", "turnbuckle", ()),
    ("G2TBY", "Nudura Gen 2 Yellow Turnbuckle", "turnbuckle", ()),
    ("RCTB", "ReachCraft Turnbuckle", "turnbuckle", ()),
    ("RCTBFT", "ReachCraft Fine Thread Turnbuckle", "turnbuckle", ()),
    ("RCTB02", "ReachCraft Large Turnbuckle", "turnbuckle", ()),

    ("WB-001", "Nudura Gen 1 Walk-Board Bracket", "walkboard_bracket", ("Walkboard Bracket",)),
    ("WB-002", "Nudura Gen 2 Green Walk-Board Bracket", "walkboard_bracket", ()),
    ("WBY-002", "Nudura Gen 2 Yellow Walk-Board Bracket", "walkboard_bracket", ()),
    ("RCWB", "ReachCraft Walk-Board Bracket", "walkboard_bracket", ()),
    ("RCWBFT", "ReachCraft Fine Thread Walk-Board Bracket", "walkboard_bracket", ()),
    ("RCWBLG", "ReachCraft Large Walk-Board Bracket", "walkboard_bracket", ()),

    ("HR-001", "Nudura Gen 1 Handrail", "hand_rail", ("Hand Rail (8 ft)",)),
    ("HR-002", "Nudura Gen 2 Green Handrail", "hand_rail", ()),
    ("HRY-002", "Nudura Gen 2 Yellow Handrail", "hand_rail", ()),
    ("RCHR", "ReachCraft Handrail", "hand_rail", ()),
    ("RCHRFT", "ReachCraft Fine Thread Handrail", "hand_rail", ()),
    ("RCHRLG", "ReachCraft Large Handrail", "hand_rail", ()),

    ("EXT", "Nudura Extension", "tb_extension", ()),
    ("EX-001", "ReachCraft Extension", "tb_extension", ("TB Extension",)),
    ("EXT-20", "20 ft Extension", "tb_extension", ()),

    ("CU-001", "Non Stop Heavy Duty Crank-Up", "crankup_scaffold", ("Crankup Scaffold",)),
    ("SP-001", "Shoring Post", "shoring_post", ()),
]

# These older six-digit asset tags were entered in the workbook's serial
# column even though they are QR/tool tags. The explicit allow-list avoids
# treating genuine numeric manufacturer serials as QR codes.
LEGACY_WORKBOOK_QR_CODES = {
    "256192", "252157", "252155", "252154", "401287", "401289",
    "401277", "401252", "401283", "401251", "401247", "401255",
    "403290", "401243", "401245", "403353", "403335",
}

BRACE_LENGTHS = [10, 12, 16, 20]  # ft

SHOP_ADDRESS = "1586 Seaborn Dr, Ponder, TX 76259"
SHOP_LAT = 33.1622357
SHOP_LNG = -97.2596744


def brace_length_for_height(h: float) -> Optional[int]:
    if h <= 10:
        return 10
    if h <= 12:
        return 12
    if h <= 16:
        return 16
    if h <= 20:
        return 20
    return None  # engineer required


# ----------------------------- Helpers ------------------------------------
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def gen_id() -> str:
    return str(uuid.uuid4())


def strip_id(d: dict) -> dict:
    d.pop("_id", None)
    return d


def hash_pwd(pwd: str) -> str:
    return pwd_ctx.hash(pwd)


def verify_pwd(pwd: str, h: str) -> bool:
    try:
        return pwd_ctx.verify(pwd, h)
    except Exception:
        return False


def make_token(sub: str, role: str, refresh: bool = False) -> str:
    if refresh:
        exp = now_utc() + timedelta(days=REFRESH_TTL_DAYS)
        secret = JWT_REFRESH_SECRET
        tok_type = "refresh"
    else:
        exp = now_utc() + timedelta(minutes=ACCESS_TTL_MIN)
        secret = JWT_SECRET
        tok_type = "access"
    payload = {"sub": sub, "role": role, "exp": exp, "type": tok_type, "jti": gen_id()}
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_token(token: str, refresh: bool = False) -> dict:
    secret = JWT_REFRESH_SECRET if refresh else JWT_SECRET
    return jwt.decode(token, secret, algorithms=["HS256"])


# ----------------------------- Models -------------------------------------
class UserPublic(BaseModel):
    id: str
    email: EmailStr
    name: str
    role: Role


class LoginReq(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


class RegisterReq(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: Role = Role.crew

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value


class SignupReq(BaseModel):
    email: EmailStr
    password: str
    name: str
    invite_code: Optional[str] = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value: Any) -> Any:
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        name = value.strip()
        if len(name) < 2:
            raise ValueError("Name must be at least 2 characters")
        if len(name) > 100:
            raise ValueError("Name must be 100 characters or fewer")
        return name

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if len(value) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(value.encode("utf-8")) > 72:
            raise ValueError("Password must be 72 bytes or fewer")
        return value


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserPublic


class RefreshReq(BaseModel):
    refresh_token: str


# Inventory ledger buckets. Every unit of an equipment SKU sits in exactly
# one bucket at a time; `quantity` (owned) always equals the sum of all of
# them. Movements between buckets are the unit of truth (see LedgerEntry) —
# available/reserved/etc. on the Equipment doc are a maintained cache of the
# ledger, not the source of it.
#
# staged/outbound/inbound are direction-specific job-dispatch buckets (see
# Dispatch below): staged = pulled for an outbound job but still on-site;
# outbound = loaded and left the yard, not yet delivered; inbound = picked
# up from the job, en route back, not yet checked in.
#
# in_transit is kept separately and ONLY for Inventory > Transfers
# (yard-to-yard relocation of stock, unrelated to a customer job) — it is
# deliberately never used to represent outbound/inbound job movement, so a
# unit's current bucket always answers "what job-relevant state is this in"
# unambiguously. Internal tool checkouts are tracked separately from customer
# rentals so the accountable foreman/project stays visible.
BUCKET_FIELDS = [
    "available", "reserved", "staged", "outbound", "on_rental", "inbound",
    "checked_out", "pending_inspection", "in_maintenance", "missing", "in_transit",
]


class Equipment(BaseModel):
    id: str = Field(default_factory=gen_id)
    sku: str
    qr_code: Optional[str] = None
    model: str = ""
    serial_number: str = ""
    name: str
    category: str
    condition: str = "good"  # good, fair, poor, broken
    location: str = ""  # primary/display location — see location_balances for the real split
    location_balances: dict[str, int] = Field(default_factory=dict)  # {location: available units there}
    daily_rate: float = 0.0
    quantity: int = 1  # owned
    available: int = 1
    reserved: int = 0
    staged: int = 0  # pulled for an outbound delivery, still at the yard
    outbound: int = 0  # loaded and left the yard, not yet delivered
    on_rental: int = 0
    checked_out: int = 0  # internal tool checkout, separate from customer rentals
    checked_out_to: str = ""  # project foreman / project assignment label
    inbound: int = 0  # picked up from the job, en route back, not yet checked in
    in_transit: int = 0  # yard-to-yard Transfers only — see BUCKET_FIELDS note above
    pending_inspection: int = 0  # returned, awaiting inspection before going back to available
    in_maintenance: int = 0  # confirmed damaged / open maintenance ticket
    missing: int = 0  # unaccounted for at last physical count
    tracking_type: str = "bulk"  # "bulk" (pooled qty) or "serialized" (individually tracked units)
    notes: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class EquipmentCreate(BaseModel):
    # `sku` remains an internal compatibility key for rental/booking line
    # snapshots. Operators identify serialized tools by `qr_code` instead.
    sku: str = ""
    qr_code: Optional[str] = None
    model: str = ""
    serial_number: str = ""
    name: str
    category: str
    condition: str = "good"
    location: str = ""
    daily_rate: float = 0.0
    quantity: int = 1
    available: Optional[int] = None
    tracking_type: str = "bulk"
    notes: str = ""


def equipment_identifier_sku(qr_code: Optional[str], serial_number: str = "", fallback: str = "") -> str:
    """Build a stable internal key without exposing SKU as the tool identity."""
    qr = (qr_code or "").strip()
    serial = serial_number.strip()
    if qr:
        return f"QR-{qr}"
    if serial:
        return f"SER-{serial}"
    return fallback or f"TOOL-{gen_id()[:8].upper()}"


class LedgerEntry(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    qty: int
    from_bucket: str  # one of BUCKET_FIELDS, or "owned" for received/initial stock
    to_bucket: str
    reason: str  # rental_created, rental_returned, inspection_pass, damage_reported,
                 # maintenance_resolved, booking_reserved, booking_released,
                 # reconciliation, transfer, received, ...
    location: str = ""
    rental_id: Optional[str] = None
    booking_id: Optional[str] = None
    note: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class SerialUnit(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    serial_no: str
    status: str = "available"  # available, reserved, on_rental, in_transit, maintenance, missing
    location: str = ""
    rental_id: Optional[str] = None
    booking_id: Optional[str] = None
    notes: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class SerialUnitCreate(BaseModel):
    serial_no: str
    status: str = "available"
    location: str = ""
    notes: str = ""


class SerialUnitUpdate(BaseModel):
    status: Optional[str] = None
    location: Optional[str] = None
    notes: Optional[str] = None


class InventoryCount(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    equipment_name: str = ""
    counted_qty: int
    expected_qty: int  # equipment.available at time of count
    variance: int  # counted_qty - expected_qty
    status: str = "pending"  # pending, reconciled
    reason: str = ""
    counted_by: str = ""
    counted_at: datetime = Field(default_factory=now_utc)
    reconciled_by: str = ""
    reconciled_at: Optional[datetime] = None
    condition: str = ""
    yard_location: str = ""
    notes: str = ""
    authoritative: bool = False


class InventoryCountCreate(BaseModel):
    counted_qty: int


class YardCountCreate(BaseModel):
    equipment_id: Optional[str] = None
    equipment_type: str
    quantity: int = Field(ge=0)
    condition: str = "good"
    yard_location: str = "Yard"
    notes: str = ""


class ReconcileBody(BaseModel):
    reason: str


class ToolCheckoutBody(BaseModel):
    checked_out_to: str
    qty: int = 1


class ToolCheckinBody(BaseModel):
    qty: int = 1


class Transfer(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    equipment_name: str = ""
    qty: int
    from_location: str = ""
    to_location: str
    status: str = "in_transit"  # in_transit, received
    note: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=now_utc)
    received_by: str = ""
    received_at: Optional[datetime] = None


class TransferCreate(BaseModel):
    qty: int
    to_location: str
    note: str = ""


# ----------------------------- Dispatch / Movements -------------------------
# A Dispatch is a scheduled physical movement of equipment: OUTBOUND
# (shop/yard -> job) or INBOUND (job -> shop/yard). It drives the equipment
# ledger through direction-specific bucket stages as it progresses, and is
# the single sanctioned path between a booking's reservation and an active
# rental (outbound), and between an active rental and inspection (inbound).
#
# Status flows (validated per direction — see DISPATCH_FLOWS):
#   outbound: scheduled -> staging -> ready -> loaded -> dispatched -> arrived -> completed
#   inbound:  scheduled -> dispatched -> arrived -> loaded -> returning -> at_yard -> completed
# "cancelled" is reachable from any non-terminal status in either flow.
#
# Each status maps to the bucket its lines' units currently sit in (see
# dispatch_bucket_for_status). A status transition moves qty from the old
# bucket to the new one in one ledger entry — so cancelling from any point
# in either flow always resolves to a single correct ledger move back to
# the flow's starting bucket, not a special-cased rollback per stage.
DISPATCH_FLOWS = {
    "outbound": [
        DispatchStatus.SCHEDULED, DispatchStatus.STAGING, DispatchStatus.READY,
        DispatchStatus.LOADED, DispatchStatus.DISPATCHED, DispatchStatus.ARRIVED,
        DispatchStatus.COMPLETED,
    ],
    "inbound": [
        DispatchStatus.SCHEDULED, DispatchStatus.DISPATCHED, DispatchStatus.ARRIVED,
        DispatchStatus.LOADED, DispatchStatus.RETURNING, DispatchStatus.AT_YARD,
        DispatchStatus.COMPLETED,
    ],
}


def dispatch_bucket_for_status(direction: str, status: str) -> str:
    if direction == "outbound":
        return {
            "scheduled": "reserved", "staging": "reserved",
            "ready": "staged", "loaded": "staged",
            "dispatched": "outbound", "arrived": "outbound",
            "completed": "on_rental",
        }[status]
    return {
        "scheduled": "on_rental", "dispatched": "on_rental", "arrived": "on_rental",
        "loaded": "inbound", "returning": "inbound", "at_yard": "inbound",
        "completed": "pending_inspection",
    }[status]


class DispatchLine(BaseModel):
    equipment_id: str
    sku: str
    name: str
    qty: int = Field(gt=0)  # must be positive — see RentalLine.qty
    delivered_qty: Optional[int] = Field(default=None, ge=0)
    pickup_confirmed: bool = False


class DispatchTicketLine(BaseModel):
    line_index: int = Field(ge=0)
    equipment_id: str
    delivered_qty: Optional[int] = Field(default=None, ge=0)
    pickup_confirmed: bool = False


class DispatchTicketComplete(BaseModel):
    lines: List[DispatchTicketLine]


class Dispatch(BaseModel):
    id: str = Field(default_factory=gen_id)
    direction: str  # "outbound" | "inbound"
    status: str = "scheduled"
    scheduled_date: Optional[datetime] = None
    customer_name: str
    customer_type: str = "company"  # company | homeowner
    job_site: str = ""
    job_address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    rental_id: Optional[str] = None
    # True only after an admin closes the delivered job from Active Rentals.
    # A foreman may schedule a pickup earlier without ending the active phase.
    rental_completed: bool = False
    booking_id: Optional[str] = None
    driver_name: str = ""
    truck: str = ""
    trailer: str = ""
    crew: str = ""
    lines: List[DispatchLine] = Field(default_factory=list)
    # Planning-only reminder imports belong on the Dispatch calendar but are
    # deliberately not inventory movements. Their free-form requirements can
    # contain tentative sizes/quantities that must be confirmed before stock
    # is reserved through a normal Dispatch.
    planning_only: bool = False
    requirements: List[str] = Field(default_factory=list)
    source_key: Optional[str] = None
    source_date_text: str = ""
    date_confirmed: bool = True
    raw_text: str = ""
    notes: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=now_utc)
    updated_at: datetime = Field(default_factory=now_utc)
    started_at: Optional[datetime] = None
    arrived_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class DispatchCreate(BaseModel):
    direction: str
    scheduled_date: Optional[datetime] = None
    customer_name: str
    customer_type: str = "company"
    job_site: str = ""
    job_address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    rental_id: Optional[str] = None
    booking_id: Optional[str] = None
    driver_name: str = ""
    truck: str = ""
    trailer: str = ""
    crew: str = ""
    lines: List[DispatchLine] = []
    notes: str = ""


class DispatchStatusUpdate(BaseModel):
    status: str


class DispatchAssignUpdate(BaseModel):
    driver_name: Optional[str] = None
    truck: Optional[str] = None
    trailer: Optional[str] = None
    crew: Optional[str] = None
    scheduled_date: Optional[datetime] = None
    notes: Optional[str] = None


class RentalLine(BaseModel):
    equipment_id: str
    sku: str
    qr_code: Optional[str] = None
    name: str
    qty: int = Field(gt=0)  # ordered — must be positive: apply_ledger_entry silently no-ops on qty<=0, so a
    # zero/negative line would let it slip past an aggregated availability check without being applied
    daily_rate: float
    delivered_qty: int = 0  # 0 means "not yet set" — resolved to qty by resolve_delivered_qty() below
    returned_qty: int = 0
    damaged_qty: int = 0


def resolve_delivered_qty(line: RentalLine) -> int:
    """delivered_qty defaults to the ordered qty — there's no separate
    'loaded/delivered' confirmation step tracked yet, so a line is delivered
    in full the moment the rental is created unless told otherwise."""
    return line.delivered_qty if line.delivered_qty > 0 else line.qty


class CommunicationLogEntry(BaseModel):
    id: str = Field(default_factory=gen_id)
    channel: str  # call, text, email, in_person, other
    direction: str = "outgoing"  # outgoing, incoming
    summary: str
    outcome: str = ""
    trigger_key: str = ""
    created_by: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class CommunicationLogCreate(BaseModel):
    channel: str
    direction: str = "outgoing"
    summary: str
    outcome: str = ""
    trigger_key: str = ""


class Rental(BaseModel):
    id: str = Field(default_factory=gen_id)
    customer_name: str
    customer_phone: str = ""
    customer_email: str = ""
    primary_contact: str = ""
    preferred_contact_method: str = "call"
    delivery_notes: str = ""
    return_notes: str = ""
    gate_access_instructions: str = ""
    contact_permission: bool = False
    customer_type: str = "company"  # company | homeowner
    job_site: str = ""
    job_address: str = ""
    start_date: datetime
    due_date: Optional[datetime] = None  # legacy — kept optional for backward-compat with old records
    deposit: float = 0.0
    notes: str = ""
    lines: List[RentalLine] = []
    status: str = RentalStatus.ACTIVE  # see RentalStatus
    # Back-reference to the booking this rental was dispatched from, if any —
    # forward-looking only (see Phase 0 backfill in on_startup for existing
    # rows). Null is expected and normal for a standalone/walk-in rental
    # created directly via POST /rentals with no booking behind it — that is
    # not an error case, the Job composition must treat it as a legitimate
    # rental-only job.
    booking_id: Optional[str] = None
    delivered_by: str = ""
    received_by: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    communication_log: List[CommunicationLogEntry] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=now_utc)


class RentalCreate(BaseModel):
    customer_name: str
    customer_phone: str = ""
    customer_email: str = ""
    primary_contact: str = ""
    preferred_contact_method: str = "call"
    delivery_notes: str = ""
    return_notes: str = ""
    gate_access_instructions: str = ""
    contact_permission: bool = False
    customer_type: str = "company"
    job_site: str = ""
    job_address: str = ""
    start_date: datetime
    due_date: Optional[datetime] = None
    deposit: float = 0.0
    notes: str = ""
    lines: List[RentalLine]
    lat: Optional[float] = None
    lng: Optional[float] = None
    booking_id: Optional[str] = None


class LocationUpdate(BaseModel):
    lat: float
    lng: float


class GeocodeResult(BaseModel):
    lat: float
    lng: float
    display_name: str


class ReturnLine(BaseModel):
    equipment_id: str
    qty: int
    damaged_qty: int = 0  # of `qty`, how many came back visibly damaged — routed straight to maintenance instead of inspection


class SchedulePickupCreate(BaseModel):
    scheduled_date: Optional[datetime] = None
    driver_name: str = ""
    truck: str = ""
    trailer: str = ""
    crew: str = ""
    notes: str = ""


class Booking(BaseModel):
    id: str = Field(default_factory=gen_id)
    customer_name: str
    customer_type: str = "company"
    job_site: str = ""
    job_address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    start_date: datetime
    end_date: datetime
    status: str = BookingStatus.TENTATIVE  # see BookingStatus
    items: List[RentalLine] = []
    notes: str = ""
    dispatched_rental_id: Optional[str] = None
    created_at: datetime = Field(default_factory=now_utc)


class BookingCreate(BaseModel):
    customer_name: str
    customer_type: str = "company"
    job_site: str = ""
    job_address: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    start_date: datetime
    end_date: datetime
    status: str = BookingStatus.TENTATIVE
    items: List[RentalLine] = []
    notes: str = ""


class BookingStatusUpdate(BaseModel):
    status: str  # tentative, confirmed, cancelled — see BookingStatus


class Maintenance(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    equipment_name: str = ""
    issue: str
    action_taken: str = ""
    cost: float = 0.0
    qty: int = 1  # how many units of this equipment the ticket takes out of service
    status: str = "open"  # open, in_progress, resolved
    serviced_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now_utc)


class MaintenanceCreate(BaseModel):
    equipment_id: str
    issue: str
    action_taken: str = ""
    cost: float = 0.0
    qty: int = 1
    status: str = "open"
    serviced_at: Optional[datetime] = None


class ChecklistItem(BaseModel):
    text: str
    done: bool = False


SHOP_TASK_STATUSES = ["to_do", "in_progress", "blocked", "done"]
SHOP_TASK_TYPES = ["general", "repair", "staging", "inspection"]


class ShopTask(BaseModel):
    id: str = Field(default_factory=gen_id)
    title: str
    description: str = ""
    task_type: str = "general"  # general, repair, staging, inspection
    status: str = "to_do"  # to_do, in_progress, blocked, done
    priority: str = "normal"  # low, normal, high
    assignee: str = ""
    due_date: Optional[datetime] = None
    notes: str = ""
    checklist: List[ChecklistItem] = []
    qty: int = 0  # units of equipment this task represents (repair/staging tasks)
    related_rental_id: Optional[str] = None
    related_booking_id: Optional[str] = None
    related_equipment_id: Optional[str] = None
    created_by: str = ""
    completed_by: str = ""
    completed_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now_utc)


class ShopTaskCreate(BaseModel):
    title: str
    description: str = ""
    task_type: str = "general"
    status: str = "to_do"
    priority: str = "normal"
    assignee: str = ""
    due_date: Optional[datetime] = None
    notes: str = ""
    checklist: List[ChecklistItem] = []
    qty: int = 0
    related_rental_id: Optional[str] = None
    related_booking_id: Optional[str] = None
    related_equipment_id: Optional[str] = None


class ShopTaskStatusUpdate(BaseModel):
    status: str


DASHBOARD_ITEM_KINDS = ["delivery", "important", "order", "note"]
DASHBOARD_ITEM_STATUSES = ["open", "done"]


class DashboardItem(BaseModel):
    id: str = Field(default_factory=gen_id)
    kind: str = "important"
    title: str
    details: str = ""
    due_date: Optional[datetime] = None
    status: str = "open"
    created_by: str = ""
    created_at: datetime = Field(default_factory=now_utc)
    completed_by: str = ""
    completed_at: Optional[datetime] = None


class DashboardItemCreate(BaseModel):
    kind: str = "important"
    title: str = Field(min_length=1, max_length=200)
    details: str = Field(default="", max_length=2000)
    due_date: Optional[datetime] = None


class DashboardItemStatusUpdate(BaseModel):
    status: str


class WhiteboardMessageCreate(BaseModel):
    body: str = Field(min_length=1, max_length=8000)
    thread_id: str = Field(default="dashboard", min_length=1, max_length=120)
    parent_id: Optional[str] = None
    context_type: Optional[str] = Field(default=None, max_length=40)
    context_id: Optional[str] = Field(default=None, max_length=120)


class WhiteboardMessageEdit(BaseModel):
    body: str = Field(min_length=1, max_length=8000)


class WhiteboardReadUpdate(BaseModel):
    thread_id: str = Field(default="dashboard", min_length=1, max_length=120)


class Vendor(BaseModel):
    id: str = Field(default_factory=gen_id)
    name: str
    contact_name: str = ""
    phone: str = ""
    email: str = ""
    address: str = ""
    categories: List[str] = []  # e.g. ["NUDURA","Fox","Amvic"]
    freight_terms: str = ""
    truck_capacity: str = ""  # ft of block per truck
    lead_time_days: int = 0
    notes: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class VendorCreate(BaseModel):
    name: str
    contact_name: str = ""
    phone: str = ""
    email: str = ""
    address: str = ""
    categories: List[str] = []
    freight_terms: str = ""
    truck_capacity: str = ""
    lead_time_days: int = 0
    notes: str = ""


class Contact(BaseModel):
    id: str = Field(default_factory=gen_id)
    company: str
    contact: str = ""
    phone: str = ""
    email: str = ""
    business_address: str = ""
    is_homeowner: bool = False
    follows_current_job: bool = False
    current_job_site: str = ""
    current_job_address: str = ""
    current_job_lat: Optional[float] = None
    current_job_lng: Optional[float] = None
    current_rental_id: Optional[str] = None
    notes: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class ContactCreate(BaseModel):
    company: str
    contact: str = ""
    phone: str = ""
    email: str = ""
    business_address: str = ""
    is_homeowner: bool = False
    follows_current_job: bool = False
    notes: str = ""


class SiteSettings(BaseModel):
    brand_name: str = "Concrete Form"
    tagline: str = "ICF Field Tools"
    logo_base64: str = ""  # data URI
    primary_color: str = "#FF6A00"
    company_address: str = SHOP_ADDRESS
    company_phone: str = ""
    company_email: str = ""
    shop_lat: float = SHOP_LAT
    shop_lng: float = SHOP_LNG


# Bracing engine
class WallRun(BaseModel):
    name: str = "Run"
    corners: int = 0
    linear_ft: float = 0.0
    wall_height: float = 8.0


class BracingRequest(BaseModel):
    runs: List[WallRun]


class RunResult(BaseModel):
    name: str
    corners: int
    linear_ft: float
    wall_height: float
    strongbacks: int
    braces: int
    brace_length: Optional[int]
    engineer_required: bool


class BracingResult(BaseModel):
    runs: List[RunResult]
    total_strongbacks: int
    total_braces: int
    braces_by_length: dict
    engineer_required: bool


class InspectBody(BaseModel):
    qty: int
    outcome: str  # "available" or "damaged"
    yard_location: str = "Yard"
    note: str = ""


# ----------------------------- Inventory Ledger ----------------------------
_TRANSACTIONS_SUPPORTED: Optional[bool] = None  # cached probe result; None = not yet probed


class InsufficientStockError(HTTPException):
    def __init__(self, equipment_id: str, bucket: str, requested: int) -> None:
        super().__init__(409, f"Not enough {bucket} stock for equipment {equipment_id} to move {requested} units")


async def apply_ledger_entry(
    equipment_id: str,
    qty: int,
    from_bucket: str,
    to_bucket: str,
    reason: str,
    *,
    location: str = "",
    rental_id: Optional[str] = None,
    booking_id: Optional[str] = None,
    note: str = "",
    created_by: str = "",
    session: Any = None,
) -> None:
    """Move `qty` units of `equipment_id` from one bucket to another,
    conditionally/atomically updating the equipment doc's cached bucket
    counts and recording a LedgerEntry for audit history.

    `from_bucket` / `to_bucket` are entries of BUCKET_FIELDS, or "owned" for
    entries that change total ownership rather than move between buckets
    (e.g. a fresh receipt goes owned -> available; a write-off goes
    missing -> owned). "owned" only ever touches `quantity`, never a bucket
    field, so ownership changes never fabricate or destroy bucket units.

    The update is conditional: any field this call would decrement must
    already hold at least `qty`, enforced by the Mongo filter (not a
    read-then-write check), so concurrent callers can never drive a bucket
    negative or over-allocate stock that isn't really there. If the caller
    passed a `session` (an active Mongo transaction), the equipment update
    and the ledger insert commit or abort together.
    """
    if qty <= 0:
        return
    inc: dict[str, int] = {}
    if from_bucket == "owned":
        inc["quantity"] = inc.get("quantity", 0) + qty
    else:
        if from_bucket not in BUCKET_FIELDS:
            raise ValueError(f"Unknown bucket: {from_bucket}")
        inc[from_bucket] = inc.get(from_bucket, 0) - qty
    if to_bucket == "owned":
        inc["quantity"] = inc.get("quantity", 0) - qty
    else:
        if to_bucket not in BUCKET_FIELDS:
            raise ValueError(f"Unknown bucket: {to_bucket}")
        inc[to_bucket] = inc.get(to_bucket, 0) + qty

    filt: dict[str, Any] = {"id": equipment_id}
    for field, delta in inc.items():
        if delta < 0:
            filt[field] = {"$gte": -delta}

    result = await db.equipment.update_one(filt, {"$inc": inc}, session=session)
    if result.matched_count == 0:
        # Either the equipment doesn't exist, or the source bucket doesn't
        # have enough units — distinguish for a clearer error.
        if not await db.equipment.find_one({"id": equipment_id}, {"_id": 1}, session=session):
            raise HTTPException(404, "Equipment not found")
        raise InsufficientStockError(equipment_id, from_bucket, qty)

    entry = LedgerEntry(
        equipment_id=equipment_id, qty=qty, from_bucket=from_bucket, to_bucket=to_bucket,
        reason=reason, location=location, rental_id=rental_id, booking_id=booking_id,
        note=note, created_by=created_by,
    )
    await db.ledger_entries.insert_one(entry.model_dump(), session=session)


async def run_in_transaction(fn):
    """Run `fn(session)` inside a Mongo multi-document transaction when the
    deployment supports one (replica set / sharded cluster). Standalone
    MongoDB instances (local dev, some test sandboxes) don't support
    transactions at all, so we probe once and transparently fall back to
    running `fn(None)` without a session — the per-call conditional filter in
    apply_ledger_entry still prevents over-allocation either way; the
    transaction only adds all-or-nothing rollback across multiple ledger
    moves in one request (e.g. a multi-line rental)."""
    global _TRANSACTIONS_SUPPORTED
    if _TRANSACTIONS_SUPPORTED is False:
        return await fn(None)
    try:
        async with await client.start_session() as session:
            async def _cb(s):
                return await fn(s)
            result = await session.with_transaction(_cb)
            _TRANSACTIONS_SUPPORTED = True
            return result
    except HTTPException:
        raise
    except Exception as e:
        msg = str(e)
        if "Transaction numbers" in msg or "IllegalOperation" in msg or "replica set" in msg.lower():
            _TRANSACTIONS_SUPPORTED = False
            return await fn(None)
        raise


# ----------------------------- Idempotency (offline sync) -------------------
# The mobile app's offline mutation queue retries a request whenever it
# can't confirm the previous attempt landed (dropped response, app killed
# mid-request, reconnect racing a timeout) — without a dedup key, that retry
# would create a second rental, double-apply a checkout, etc. A client that
# opts in sends a stable `Idempotency-Key` header (the queued mutation's own
# id, unique for the life of that queue entry); this stores the first
# successful response keyed on (key, endpoint) and replays it verbatim on
# a repeat, without re-running the handler's side effects.
IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 3600  # long enough to outlast any realistic offline session


async def idem_key(idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key")) -> Optional[str]:
    return idempotency_key


async def idempotent(key: Optional[str], endpoint: str, fn):
    """Run `fn()` (a zero-arg async callable) with idempotency-key dedup.

    No key -> just runs `fn()`, same as before this existed (opt-in, not a
    behavior change for any existing caller). With a key: a stored response
    for (key, endpoint) is returned verbatim without re-running `fn`;
    otherwise `fn` runs and, only on success, its result is cached. A
    request that raises is never cached — a genuine failure should be
    retryable on its own terms, not permanently pinned to an error.
    """
    if not key:
        return await fn()
    existing = await db.idempotency_keys.find_one({"key": key, "endpoint": endpoint})
    if existing:
        return existing["response_body"]
    result = await fn()
    try:
        await db.idempotency_keys.insert_one({
            "key": key, "endpoint": endpoint,
            "response_body": jsonable_encoder(result),
            "created_at": now_utc(),
        })
    except DuplicateKeyError:
        # Lost a race with a concurrent identical request — that request's
        # cached response is equally valid; nothing to do.
        pass
    return result


# ----------------------------- Job DTO (composition seam) -------------------
# Canonical shape for the unified Booking + Rental + Dispatch lifecycle the
# future Jobs UI will present. This is a *read composition*, not a stored
# document — no collection backs it, and no endpoint serves it yet: this is
# an additive, non-breaking step that only defines the shape and the pure
# derivation rule. The composing /jobs endpoint and the Jobs UI come later,
# once this contract is settled. Mirrored on the frontend at
# frontend/src/domain/job.ts — keep the two in sync by hand.
#
# Lifecycle: Planned -> Reserved -> Staging -> Outbound -> On Job ->
# Pickup Requested -> Inbound -> Inspection -> Closed. This status is always
# DERIVED from booking.status + the linked outbound dispatch's status +
# rental.status + the linked inbound dispatch's status — never stored — so
# there is exactly one place (derive_job_status) that can compute it, instead
# of the nine call sites a stored-and-copied status would eventually need to
# stay in sync.
#
# Partial return is deliberately NOT a lifecycle stage here: a rental with an
# open balance (some units still on site) is still JobStatus.ON_JOB — how
# much is still out is the quantity condition `qty_outstanding`, not a
# status. This mirrors RentalStatus.PARTIALLY_RETURNED existing as a status
# on the underlying Rental (that field isn't being changed by Phase 0) while
# the composed Job view treats it as a quantity, per the plan agreed with
# product.
class JobStatus(str, Enum):
    PLANNED = "planned"
    RESERVED = "reserved"
    STAGING = "staging"
    OUTBOUND = "outbound"
    ON_JOB = "on_job"
    PICKUP_REQUESTED = "pickup_requested"
    INBOUND = "inbound"
    INSPECTION = "inspection"
    CLOSED = "closed"


def derive_job_status(
    booking_status: Optional[str],
    outbound_status: Optional[str],
    rental_status: Optional[str],
    inbound_status: Optional[str],
    has_pending_inspection: bool = False,
) -> JobStatus:
    """Pure function, no DB access — the future /jobs endpoint supplies each
    argument from its own query and this just maps them to one of the nine
    lifecycle stages. Precedence: once a rental exists its state (and any
    live inbound dispatch on it) always wins over the booking's own status,
    since a rental existing means the booking's job already happened
    regardless of what the booking doc still says (a confirmed booking whose
    dispatch completed sits at status='dispatched' forever, per
    update_booking_status's guard against managing a dispatched booking
    directly).

    Args:
        booking_status: Booking.status, or None if there's no booking (a
            standalone/walk-in rental, or a booking that was never made).
        outbound_status: status of the booking's linked *live*
            (non-cancelled) outbound Dispatch, or None if there isn't one.
        rental_status: Rental.status, or None if no rental exists yet.
        inbound_status: status of the rental's linked *live* inbound
            Dispatch (a scheduled pickup), or None if none is scheduled.
        has_pending_inspection: True if any ledger-tracked units from this
            rental are still sitting in the pending_inspection bucket
            (computed by the caller from ledger_entries filtered by
            rental_id — this function stays pure and DB-free).
    """
    if rental_status is not None:
        if rental_status == RentalStatus.RETURNED:
            return JobStatus.INSPECTION if has_pending_inspection else JobStatus.CLOSED
        # active or partially_returned — an open balance is a quantity
        # condition (qty_outstanding on the Job DTO), not a separate status.
        if inbound_status in (DispatchStatus.DISPATCHED, DispatchStatus.ARRIVED, DispatchStatus.LOADED, DispatchStatus.RETURNING, DispatchStatus.AT_YARD):
            return JobStatus.INBOUND
        if inbound_status == DispatchStatus.SCHEDULED:
            return JobStatus.PICKUP_REQUESTED
        return JobStatus.ON_JOB

    if booking_status == BookingStatus.CANCELLED:
        return JobStatus.CLOSED
    if outbound_status in (DispatchStatus.READY, DispatchStatus.LOADED, DispatchStatus.DISPATCHED, DispatchStatus.ARRIVED):
        return JobStatus.OUTBOUND
    if outbound_status in (DispatchStatus.SCHEDULED, DispatchStatus.STAGING):
        return JobStatus.STAGING
    if booking_status == BookingStatus.CONFIRMED:
        return JobStatus.RESERVED
    return JobStatus.PLANNED


class JobLine(BaseModel):
    equipment_id: str
    sku: str
    name: str
    qty_ordered: int
    qty_delivered: int
    qty_on_site: int
    qty_returned: int
    qty_damaged: int


class Job(BaseModel):
    """Composed, read-only view over one Booking + Rental + Dispatch chain.
    Not a stored document — the future /jobs endpoint builds this by joining
    the relevant collections at read time; nothing here is persisted as-is.
    Field names deliberately echo Booking/Rental so the Jobs UI can share
    formatting logic with the screens it's meant to replace.

    NOTE on `id`: there is no merged collection, so nothing gives a job one
    stable identifier across its whole lifecycle — it is booking_id before
    dispatch and rental_id after. This DTO uses rental_id when one exists,
    else booking_id, as a provisional stand-in; anything that needs a truly
    stable per-job key across the Outbound transition (a bookmarked URL, a
    push notification reference) will need that decided explicitly before
    the /jobs endpoint ships.
    """
    id: str
    booking_id: Optional[str] = None
    rental_id: Optional[str] = None
    active_outbound_dispatch_id: Optional[str] = None
    active_inbound_dispatch_id: Optional[str] = None
    status: JobStatus
    customer_name: str
    job_site: str = ""
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None  # from Booking; None once there's no booking behind the job
    lines: List[JobLine] = []
    # Sum of qty_on_site across lines. >0 alongside rental_status ==
    # "partially_returned" is what "partial return" means here — a quantity
    # condition read off the lines, not a lifecycle stage of its own.
    qty_outstanding: int = 0
    is_standalone_rental: bool = False  # rental_id set, booking_id is None — a legitimate walk-in job, not an error
    cancelled: bool = False  # the underlying booking was cancelled and no rental was ever created
    created_at: Optional[datetime] = None


# ----------------------------- Auth Deps ----------------------------------
async def get_current_user(request: Request) -> UserPublic:
    auth = request.headers.get("Authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = auth.split(" ", 1)[1]
    try:
        payload = decode_token(token, refresh=False)
    except JWTError:
        raise HTTPException(401, "Invalid or expired token")
    if payload.get("type") != "access":
        raise HTTPException(401, "Wrong token type")
    uid = payload.get("sub")
    user = await db.users.find_one({"id": uid})
    if not user:
        raise HTTPException(401, "User not found")
    return UserPublic(id=user["id"], email=user["email"], name=user["name"], role=Role(user["role"]))


def require_role(min_role: Role):
    async def dep(user: UserPublic = Depends(get_current_user)) -> UserPublic:
        if ROLE_ORDER[user.role] < ROLE_ORDER[min_role]:
            raise HTTPException(403, "Insufficient privileges")
        return user
    return dep


class WhiteboardRealtimeHub:
    """Process-local fan-out for the single production API instance."""

    def __init__(self) -> None:
        self.connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def add(self, socket: WebSocket) -> None:
        async with self._lock:
            self.connections.add(socket)

    async def remove(self, socket: WebSocket) -> None:
        async with self._lock:
            self.connections.discard(socket)

    async def broadcast(self, event: dict) -> None:
        stale: list[WebSocket] = []
        for socket in tuple(self.connections):
            try:
                await socket.send_json(jsonable_encoder(event))
            except Exception:
                stale.append(socket)
        if stale:
            async with self._lock:
                for socket in stale:
                    self.connections.discard(socket)


whiteboard_hub = WhiteboardRealtimeHub()
nathan_gateway = HermesNathanGateway()


async def user_from_access_token(token: str) -> UserPublic:
    try:
        payload = decode_token(token, refresh=False)
    except JWTError as exc:
        raise HTTPException(401, "Invalid or expired token") from exc
    if payload.get("type") != "access":
        raise HTTPException(401, "Wrong token type")
    user = await db.users.find_one({"id": payload.get("sub")})
    if not user:
        raise HTTPException(401, "User not found")
    return UserPublic(id=user["id"], email=user["email"], name=user["name"], role=Role(user["role"]))


# ----------------------------- App ----------------------------------------
app = FastAPI(title="Concrete Form API")
api = APIRouter(prefix="/api")

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Root health endpoints — Kubernetes liveness/readiness probes hit these at "/".
# Without them the pod gets restarted every N probes → restart loop in prod.
@app.get("/")
async def liveness():
    return {"status": "ok", "service": "concrete-form"}


@app.get("/health")
async def health():
    return {"status": "ok"}


@api.get("/")
async def api_root():
    return {"service": "Concrete Form API", "version": "1.0.0"}


# ----------------------------- Auth ---------------------------------------
@api.post("/auth/register", response_model=UserPublic, status_code=201)
async def register(body: RegisterReq, _user: UserPublic = Depends(require_role(Role.admin))):
    existing = await db.users.find_one({"email": body.email})
    if existing:
        raise HTTPException(400, "Email already registered")
    doc = {
        "id": gen_id(),
        "email": body.email,
        "name": body.name,
        "password_hash": hash_pwd(body.password),
        "role": body.role.value,
        "failed_attempts": 0,
        "lock_until": None,
        "created_at": now_utc(),
    }
    await db.users.insert_one(doc)
    return UserPublic(id=doc["id"], email=doc["email"], name=doc["name"], role=Role(doc["role"]))


@api.post("/auth/signup", response_model=TokenPair, status_code=201)
async def signup(body: SignupReq):
    """Create a least-privileged account and sign it in immediately.

    Gated: only an allowed email domain or a valid invite code may self-
    provision. Without SIGNUP_ALLOWED_DOMAINS / SIGNUP_INVITE_CODES configured,
    self-service signup is closed and accounts must come from an admin via
    POST /auth/register."""
    if not _signup_authorized(str(body.email), body.invite_code):
        raise HTTPException(403, "Sign-up is invite-only. Contact an administrator for access.")
    existing = await db.users.find_one({"email": body.email})
    if existing:
        raise HTTPException(409, "Email already registered")
    doc = {
        "id": gen_id(),
        "email": str(body.email),
        "name": body.name,
        "password_hash": hash_pwd(body.password),
        "role": Role.crew.value,
        "failed_attempts": 0,
        "lock_until": None,
        "created_at": now_utc(),
    }
    await db.users.insert_one(doc)
    access = make_token(doc["id"], doc["role"], refresh=False)
    refresh = make_token(doc["id"], doc["role"], refresh=True)
    pub = UserPublic(id=doc["id"], email=doc["email"], name=doc["name"], role=Role(doc["role"]))
    return TokenPair(access_token=access, refresh_token=refresh, user=pub)


@api.post("/auth/login", response_model=TokenPair)
async def login(body: LoginReq):
    user = await db.users.find_one({"email": body.email})
    if not user:
        raise HTTPException(401, "Invalid credentials")
    lock_until = user.get("lock_until")
    if lock_until and lock_until > now_utc().replace(tzinfo=None):
        raise HTTPException(403, "Account temporarily locked")
    if not verify_pwd(body.password, user["password_hash"]):
        failed = user.get("failed_attempts", 0) + 1
        upd: dict[str, Any] = {"failed_attempts": failed}
        if failed >= 5:
            upd["lock_until"] = (now_utc() + timedelta(minutes=15)).replace(tzinfo=None)
        await db.users.update_one({"id": user["id"]}, {"$set": upd})
        raise HTTPException(401, "Invalid credentials")
    await db.users.update_one({"id": user["id"]}, {"$set": {"failed_attempts": 0, "lock_until": None}})
    access = make_token(user["id"], user["role"], refresh=False)
    refresh = make_token(user["id"], user["role"], refresh=True)
    pub = UserPublic(id=user["id"], email=user["email"], name=user["name"], role=Role(user["role"]))
    return TokenPair(access_token=access, refresh_token=refresh, user=pub)


@api.post("/auth/refresh", response_model=TokenPair)
async def refresh_token(body: RefreshReq):
    try:
        payload = decode_token(body.refresh_token, refresh=True)
    except JWTError:
        raise HTTPException(401, "Invalid refresh token")
    if payload.get("type") != "refresh":
        raise HTTPException(401, "Wrong token type")
    user = await db.users.find_one({"id": payload.get("sub")})
    if not user:
        raise HTTPException(401, "User not found")
    access = make_token(user["id"], user["role"], refresh=False)
    new_refresh = make_token(user["id"], user["role"], refresh=True)
    pub = UserPublic(id=user["id"], email=user["email"], name=user["name"], role=Role(user["role"]))
    return TokenPair(access_token=access, refresh_token=new_refresh, user=pub)


@api.get("/auth/me", response_model=UserPublic)
async def me(user: UserPublic = Depends(get_current_user)):
    return user


@api.get("/auth/users", response_model=List[UserPublic])
async def list_users(_: UserPublic = Depends(require_role(Role.admin))):
    docs = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    return [UserPublic(id=d["id"], email=d["email"], name=d["name"], role=Role(d["role"])) for d in docs]


# ----------------------------- Equipment ----------------------------------
@api.get("/equipment", response_model=List[Equipment])
async def list_equipment(user: UserPublic = Depends(get_current_user)):
    docs = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    return [Equipment(**redact_money_for_crew(d, user.role.value)) for d in docs]


@api.post("/equipment", response_model=Equipment, status_code=201)
async def create_equipment(body: EquipmentCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    qr_code = (body.qr_code or "").strip() or None
    if qr_code and await db.equipment.find_one({"qr_code": qr_code}):
        raise HTTPException(409, "QR code already assigned")
    available = body.available if body.available is not None else body.quantity
    eq = Equipment(
        sku=body.sku.strip() or equipment_identifier_sku(qr_code, body.serial_number),
        qr_code=qr_code, model=body.model.strip(), serial_number=body.serial_number.strip(),
        name=body.name, category=body.category,
        condition=body.condition, location=body.location,
        location_balances={body.location: available} if available > 0 else {},
        daily_rate=body.daily_rate, quantity=body.quantity,
        available=available,
        tracking_type=body.tracking_type,
        notes=body.notes,
    )
    await db.equipment.insert_one(eq.model_dump())
    if eq.available > 0:
        entry = LedgerEntry(
            equipment_id=eq.id, qty=eq.available, from_bucket="owned", to_bucket="available",
            reason="received", location=eq.location, note="Initial stock", created_by=user.name,
        )
        await db.ledger_entries.insert_one(entry.model_dump())
    return eq


@api.put("/equipment/{eq_id}", response_model=Equipment)
async def update_equipment(eq_id: str, body: EquipmentCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Equipment not found")
    upd = body.model_dump()
    upd["qr_code"] = (body.qr_code or "").strip() or None
    upd["model"] = body.model.strip()
    upd["serial_number"] = body.serial_number.strip()
    upd["sku"] = body.sku.strip() or doc["sku"]
    if upd["qr_code"]:
        duplicate = await db.equipment.find_one({"qr_code": upd["qr_code"], "id": {"$ne": eq_id}})
        if duplicate:
            raise HTTPException(409, "QR code already assigned")
    if upd.get("available") is None:
        upd["available"] = doc["available"]
    # A manual edit sets the whole record, including collapsing any
    # location split a transfer had created — this form only exposes one
    # location field, so it can't express a partial split.
    upd["location_balances"] = {upd["location"]: upd["available"]} if upd["available"] > 0 else {}
    await db.equipment.update_one({"id": eq_id}, {"$set": upd})
    new_doc = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    return Equipment(**new_doc)


@api.delete("/equipment/{eq_id}")
async def delete_equipment(eq_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    res = await db.equipment.delete_one({"id": eq_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Equipment not found")
    return {"ok": True}


@api.get("/equipment/export.csv", response_class=PlainTextResponse)
async def export_equipment_csv(_: UserPublic = Depends(get_current_user)):
    docs = await db.equipment.find({}, {"_id": 0}).to_list(5000)
    buf = io.StringIO()
    writer = csv.writer(buf)
    columns = [
        "qr_code", "name", "model", "serial_number", "category", "condition",
        "location", "checked_out_to", "quantity", *BUCKET_FIELDS, "daily_rate",
        "tracking_type", "notes", "internal_sku",
    ]
    writer.writerow(columns)
    for d in docs:
        row = {column: d.get(column, "") for column in columns}
        row["internal_sku"] = d.get("sku", "")
        writer.writerow([row[column] for column in columns])
    return PlainTextResponse(
        buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": 'attachment; filename="equipment.csv"'},
    )


@api.post("/equipment/import.csv")
async def import_equipment_csv(file: UploadFile = File(...), _: UserPublic = Depends(require_role(Role.foreman))):
    data = (await file.read()).decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(data))
    if not reader.fieldnames:
        raise HTTPException(400, "CSV is empty or has no header row")
    reader.fieldnames = [(field or "").strip() for field in reader.fieldnames]
    if not ({"name", "Tool"} & set(reader.fieldnames)):
        raise HTTPException(400, "CSV must include a name or Tool column")

    count = 0
    errors: list[str] = []
    for row_number, raw_row in enumerate(reader, start=2):
        try:
            row = {(key or "").strip(): (value or "").strip() for key, value in raw_row.items()}

            def int_value(field: str, default: int = 0) -> int:
                value = row.get(field, "")
                return int(float(value)) if value != "" else default

            qr_code = (row.get("qr_code") or row.get("QR Code") or "").strip() or None
            serial_number = (row.get("serial_number") or row.get("Serial Number") or "").strip()
            internal_sku = (row.get("sku") or row.get("internal_sku") or "").strip() or equipment_identifier_sku(qr_code, serial_number)
            checked_out_to = (row.get("checked_out_to") or "").strip()
            quantity = int_value("quantity", 1)
            checked_out = int_value("checked_out", quantity if checked_out_to else 0)
            available = int_value("available", 0 if checked_out else quantity)
            bucket_values = {
                field: int_value(field, checked_out if field == "checked_out" else available if field == "available" else 0)
                for field in BUCKET_FIELDS
            }
            if quantity < 0 or any(value < 0 for value in bucket_values.values()):
                raise ValueError("quantity and inventory bucket values cannot be negative")

            eq = Equipment(
                sku=internal_sku,
                qr_code=qr_code,
                model=(row.get("model") or row.get("Model") or "").strip(),
                serial_number=serial_number,
                name=(row.get("name") or row.get("Tool") or "").strip() or "Item",
                category=row.get("category", "tool").strip() or "tool",
                condition=row.get("condition","good").strip(),
                location=row.get("location","").strip(),
                daily_rate=float(row.get("daily_rate") or 0),
                quantity=quantity,
                **bucket_values,
                checked_out_to=checked_out_to,
                location_balances={row.get("location", "").strip(): available} if available > 0 and row.get("location", "").strip() else {},
                tracking_type=row.get("tracking_type", "").strip() or ("serialized" if qr_code or serial_number else "bulk"),
                notes=row.get("notes","").strip(),
            )
            selector = {"qr_code": qr_code} if qr_code else {"sku": eq.sku}
            equipment_data = eq.model_dump()
            equipment_id = equipment_data.pop("id")
            created_at = equipment_data.pop("created_at")
            await db.equipment.update_one(
                selector,
                {"$set": equipment_data, "$setOnInsert": {"id": equipment_id, "created_at": created_at}},
                upsert=True,
            )
            count += 1
        except Exception as e:
            message = f"Row {row_number}: {e}"
            errors.append(message)
            logger.warning("CSV row skipped: %s", message)
    if count == 0:
        raise HTTPException(400, errors[0] if errors else "CSV has no data rows")
    return {"imported": count, "skipped": len(errors), "errors": errors[:20]}


@api.get("/equipment/qr/{qr_code}", response_model=Equipment)
async def equipment_by_qr(qr_code: str, _: UserPublic = Depends(get_current_user)):
    doc = await db.equipment.find_one({"qr_code": qr_code.strip()}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "QR code not assigned to equipment")
    return Equipment(**doc)


@api.post("/equipment/{eq_id}/checkout", response_model=Equipment)
async def checkout_tool(
    eq_id: str, body: ToolCheckoutBody, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
        if not eq:
            raise HTTPException(404, "Equipment not found")
        assignee = body.checked_out_to.strip()
        if not assignee:
            raise HTTPException(400, "Project foreman is required")
        if body.qty <= 0 or body.qty > eq.get("available", 0):
            raise HTTPException(400, "qty exceeds available tools")
        await apply_ledger_entry(eq_id, body.qty, "available", "checked_out", "tool_checkout", note=f"Checked out to {assignee}", created_by=user.name)
        await db.equipment.update_one({"id": eq_id}, {"$set": {"checked_out_to": assignee, "location": ""}})
        return Equipment(**await db.equipment.find_one({"id": eq_id}, {"_id": 0}))

    return await idempotent(idempotency_key, "checkout_tool", _run)


@api.post("/equipment/{eq_id}/checkin", response_model=Equipment)
async def checkin_tool(
    eq_id: str, body: ToolCheckinBody, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
        if not eq:
            raise HTTPException(404, "Equipment not found")
        if body.qty <= 0 or body.qty > eq.get("checked_out", 0):
            raise HTTPException(400, "qty exceeds checked-out tools")
        await apply_ledger_entry(eq_id, body.qty, "checked_out", "available", "tool_checkin", location="Yard", note=f"Checked in from {eq.get('checked_out_to') or 'field'}", created_by=user.name)
        remaining = eq.get("checked_out", 0) - body.qty
        await db.equipment.update_one({"id": eq_id}, {"$set": {"checked_out_to": eq.get("checked_out_to", "") if remaining else "", "location": "Yard" if remaining == 0 else ""}})
        return Equipment(**await db.equipment.find_one({"id": eq_id}, {"_id": 0}))

    return await idempotent(idempotency_key, "checkin_tool", _run)


@api.get("/equipment/{eq_id}/breakdown")
async def equipment_breakdown(eq_id: str, _: UserPublic = Depends(get_current_user)):
    """Where every owned unit of this SKU currently sits: yard stock, each
    outstanding rental line, each active reservation, and the in-transit /
    pending-inspection / maintenance / missing buckets."""
    eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not eq:
        raise HTTPException(404, "Equipment not found")
    rows: List[dict] = []
    available = eq.get("available", 0)
    balances: dict[str, int] = {k: v for k, v in (eq.get("location_balances") or {}).items() if v > 0}
    tracked = sum(balances.values())
    if tracked < available:
        # available grew (a return, reconciliation, inspection pass, ...)
        # through a path that doesn't attribute location — rather than hide
        # those units from the breakdown, book the untracked remainder to
        # the equipment's primary location so the rows still sum to
        # `available`.
        fallback_loc = eq.get("location") or "Yard"
        balances[fallback_loc] = balances.get(fallback_loc, 0) + (available - tracked)
    for loc, qty in balances.items():
        if qty > 0:
            rows.append({"qty": qty, "label": loc or "Yard", "kind": "yard"})
    if eq.get("checked_out", 0) > 0:
        rows.append({"qty": eq["checked_out"], "label": f"Checked out to {eq.get('checked_out_to') or 'project foreman'}", "kind": "checked_out"})

    rentals = await db.rentals.find(
        {"status": {"$in": list(RentalStatus.OPEN)}, "lines.equipment_id": eq_id}, {"_id": 0}
    ).to_list(1000)
    for r in rentals:
        for line in r.get("lines", []):
            if line["equipment_id"] != eq_id:
                continue
            delivered = line.get("delivered_qty") or line["qty"]
            outstanding = delivered - line.get("returned_qty", 0)
            if outstanding > 0:
                label = f"{r.get('job_site') or r['customer_name']} / Rental #{r['id'][:6]}"
                rows.append({"qty": outstanding, "label": label, "kind": "rental", "rental_id": r["id"]})

    bookings = await db.bookings.find(
        {"status": {"$in": list(BookingStatus.OPEN)}, "items.equipment_id": eq_id}, {"_id": 0}
    ).to_list(1000)
    for b in bookings:
        for item in b.get("items", []):
            if item["equipment_id"] != eq_id:
                continue
            sd = b.get("start_date")
            if isinstance(sd, str):
                try:
                    sd = datetime.fromisoformat(sd.replace("Z", "+00:00"))
                except Exception:
                    sd = None
            date_label = sd.strftime("%b %d") if isinstance(sd, datetime) else ""
            label = f"Reserved / {b.get('job_site') or b['customer_name']}" + (f" / {date_label}" if date_label else "")
            rows.append({"qty": item["qty"], "label": label, "kind": "reserved", "booking_id": b["id"]})

    # Booking-linked outbound dispatches are already fully represented by the
    # booking row above (its qty comes from booking.items, independent of
    # which bucket the units currently sit in) — adding a raw staged/outbound
    # bucket row for those would double-count them. Inbound dispatches always
    # require a rental_id, so they're always covered by a rental row the same
    # way. The one gap is a *standalone* outbound dispatch (no booking_id) —
    # nothing else accounts for those units, so surface them explicitly.
    standalone_dispatches = await db.dispatches.find(
        {"direction": "outbound", "booking_id": None, "status": {"$nin": list(DispatchStatus.TERMINAL)}, "lines.equipment_id": eq_id},
        {"_id": 0},
    ).to_list(1000)
    for d in standalone_dispatches:
        for line in d.get("lines", []):
            if line["equipment_id"] != eq_id or line["qty"] <= 0:
                continue
            label = f"Dispatch / {d.get('job_site') or d.get('customer_name', '')}"
            rows.append({"qty": line["qty"], "label": label, "kind": "outbound", "dispatch_id": d["id"]})

    if eq.get("in_transit", 0) > 0:
        rows.append({"qty": eq["in_transit"], "label": "In Transit", "kind": "in_transit"})
    if eq.get("pending_inspection", 0) > 0:
        rows.append({"qty": eq["pending_inspection"], "label": "Pending Inspection", "kind": "pending_inspection"})
    if eq.get("in_maintenance", 0) > 0:
        rows.append({"qty": eq["in_maintenance"], "label": "Maintenance", "kind": "maintenance"})
    if eq.get("missing", 0) > 0:
        rows.append({"qty": eq["missing"], "label": "Missing / Unaccounted", "kind": "missing"})

    return {"equipment_id": eq_id, "quantity": eq.get("quantity", 0), "rows": rows}


@api.get("/equipment/{eq_id}/ledger", response_model=List[LedgerEntry])
async def equipment_ledger(eq_id: str, _: UserPublic = Depends(get_current_user)):
    docs = await db.ledger_entries.find({"equipment_id": eq_id}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return [LedgerEntry(**d) for d in docs]


@api.post("/equipment/{eq_id}/inspect", response_model=Equipment)
async def inspect_equipment(
    eq_id: str, body: InspectBody, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
        if not eq:
            raise HTTPException(404, "Equipment not found")
        if body.qty <= 0 or body.qty > eq.get("pending_inspection", 0):
            raise HTTPException(400, "qty exceeds units pending inspection")
        if body.outcome not in ("available", "damaged"):
            raise HTTPException(400, "outcome must be 'available' or 'damaged'")
        to_bucket = "available" if body.outcome == "available" else "in_maintenance"
        reason = "inspection_pass" if body.outcome == "available" else "damage_reported"
        yard_location = body.yard_location.strip() or "Yard"
        if "." in yard_location or "$" in yard_location:
            raise HTTPException(400, "Yard location cannot contain '.' or '$'")
        await apply_ledger_entry(
            eq_id, body.qty, "pending_inspection", to_bucket, reason,
            location=yard_location, note=body.note, created_by=user.name,
        )
        if body.outcome == "available":
            await db.equipment.update_one(
                {"id": eq_id},
                {
                    "$inc": {f"location_balances.{yard_location}": body.qty},
                    "$set": {"location": yard_location},
                },
            )
        if body.outcome == "damaged":
            task = ShopTask(
                title=f"Repair {body.qty} {eq.get('name', '')}", task_type="repair", priority="high",
                qty=body.qty, related_equipment_id=eq_id,
                notes=body.note or "Failed inspection after return.", created_by=user.name,
            )
            await db.shop_tasks.insert_one(task.model_dump())
        new_doc = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
        return Equipment(**new_doc)

    return await idempotent(idempotency_key, "inspect_equipment", _run)


# ----------------------------- Physical inventory counts -------------------
@api.post("/equipment/{eq_id}/count", response_model=InventoryCount, status_code=201)
async def create_inventory_count(
    eq_id: str, body: InventoryCountCreate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    """Record a physical yard count against the system's expected available
    count. This never changes inventory by itself — it only creates a
    Variance for an authorized person to reconcile with a reason."""
    async def _run():
        eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
        if not eq:
            raise HTTPException(404, "Equipment not found")
        expected = eq.get("available", 0)
        count = InventoryCount(
            equipment_id=eq_id, equipment_name=eq.get("name", ""),
            counted_qty=body.counted_qty, expected_qty=expected,
            variance=body.counted_qty - expected, counted_by=user.name,
        )
        await db.inventory_counts.insert_one(count.model_dump())
        return count

    return await idempotent(idempotency_key, "create_inventory_count", _run)


@api.get("/inventory-counts", response_model=List[InventoryCount])
async def list_inventory_counts(_: UserPublic = Depends(get_current_user)):
    docs = await db.inventory_counts.find({}, {"_id": 0}).sort("counted_at", -1).to_list(500)
    return [InventoryCount(**d) for d in docs]


def _yard_count_category(equipment_type: str) -> str:
    value = equipment_type.lower().replace("-", " ")
    if "scaffold" in value:
        return "crankup_scaffold"
    if "shoring" in value or "shore post" in value:
        return "shoring_post"
    if "turnbuckle" in value or "turn buckle" in value:
        return "turnbuckle"
    if "walkboard" in value or "walk board" in value or "bracket" in value:
        return "walkboard_bracket"
    if "handrail" in value or "hand rail" in value:
        return "hand_rail"
    if "extension" in value:
        return "tb_extension"
    return "strongback"


@api.post("/yard-counts", response_model=InventoryCount, status_code=201)
async def create_authoritative_yard_count(
    body: YardCountCreate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    """Set the physical count for one equipment type at one yard location.

    Only the available-at-yard quantity is reconciled. Units reserved, staged,
    moving, on rent, awaiting inspection, or in repair keep their existing
    buckets. A newly observed type is added as owned stock; a shortfall moves
    to ``missing`` rather than disappearing from ownership.
    """
    async def _run():
        equipment_type = body.equipment_type.strip()
        yard_location = body.yard_location.strip() or "Yard"
        if not equipment_type:
            raise HTTPException(400, "Equipment type is required")
        if body.condition not in ("good", "fair", "poor", "broken"):
            raise HTTPException(400, "Condition must be good, fair, poor, or broken")

        eq = None
        if body.equipment_id:
            eq = await db.equipment.find_one({"id": body.equipment_id}, {"_id": 0})
            if not eq:
                raise HTTPException(404, "Equipment not found")
        else:
            eq = await db.equipment.find_one(
                {"name": {"$regex": f"^{re.escape(equipment_type)}$", "$options": "i"}},
                {"_id": 0},
            )

        async def _do(session):
            if not eq:
                slug = re.sub(r"[^A-Z0-9]+", "-", equipment_type.upper()).strip("-")[:18] or "BRACING"
                created = Equipment(
                    sku=f"YARD-{slug}-{gen_id()[:6].upper()}",
                    name=equipment_type,
                    category=_yard_count_category(equipment_type),
                    condition=body.condition,
                    location=yard_location,
                    location_balances={yard_location: body.quantity} if body.quantity else {},
                    quantity=body.quantity,
                    available=body.quantity,
                    tracking_type="bulk",
                    notes=body.notes,
                )
                await db.equipment.insert_one(created.model_dump(), session=session)
                if body.quantity:
                    entry = LedgerEntry(
                        equipment_id=created.id, qty=body.quantity,
                        from_bucket="owned", to_bucket="available",
                        reason="yard_count", location=yard_location,
                        note=body.notes or "Initial authoritative yard count",
                        created_by=user.name,
                    )
                    await db.ledger_entries.insert_one(entry.model_dump(), session=session)
                count = InventoryCount(
                    equipment_id=created.id, equipment_name=created.name,
                    counted_qty=body.quantity, expected_qty=0, variance=body.quantity,
                    status="reconciled", reason="Authoritative yard count",
                    counted_by=user.name, reconciled_by=user.name, reconciled_at=now_utc(),
                    condition=body.condition, yard_location=yard_location,
                    notes=body.notes, authoritative=True,
                )
                await db.inventory_counts.insert_one(count.model_dump(), session=session)
                return count

            available = int(eq.get("available", 0))
            balances = {key: int(value) for key, value in (eq.get("location_balances") or {}).items() if int(value) > 0}
            tracked = sum(balances.values())
            if tracked < available:
                fallback = eq.get("location") or "Yard"
                balances[fallback] = balances.get(fallback, 0) + (available - tracked)
            elif tracked > available:
                # Older rental/booking paths predate per-location balances and
                # can leave their last yard split larger than the current
                # available bucket. Normalize the stale split before applying
                # this count; the available bucket remains the ledger truth.
                excess = tracked - available
                preferred = eq.get("location") or yard_location
                keys = ([preferred] if preferred in balances else []) + [key for key in sorted(balances) if key != preferred]
                for key in keys:
                    reduction = min(excess, balances[key])
                    balances[key] -= reduction
                    excess -= reduction
                    if excess == 0:
                        break
                balances = {key: value for key, value in balances.items() if value > 0}
            previous_at_location = balances.get(yard_location, 0)
            balances[yard_location] = body.quantity
            balances = {key: value for key, value in balances.items() if value > 0}
            target_available = available - previous_at_location + body.quantity
            variance = target_available - available

            if variance < 0:
                await apply_ledger_entry(
                    eq["id"], -variance, "available", "missing", "yard_count",
                    location=yard_location, note=body.notes or "Physical count shortfall",
                    created_by=user.name, session=session,
                )
            elif variance > 0:
                recovered = min(variance, int(eq.get("missing", 0)))
                if recovered:
                    await apply_ledger_entry(
                        eq["id"], recovered, "missing", "available", "yard_count_found",
                        location=yard_location, note=body.notes or "Previously missing stock found",
                        created_by=user.name, session=session,
                    )
                if variance > recovered:
                    await apply_ledger_entry(
                        eq["id"], variance - recovered, "owned", "available", "yard_count",
                        location=yard_location, note=body.notes or "Physical count surplus",
                        created_by=user.name, session=session,
                    )

            equipment_update: dict[str, Any] = {
                "condition": body.condition,
                "location": yard_location,
                "location_balances": balances,
            }
            if body.notes:
                equipment_update["notes"] = body.notes
            await db.equipment.update_one({"id": eq["id"]}, {"$set": equipment_update}, session=session)
            count = InventoryCount(
                equipment_id=eq["id"], equipment_name=eq.get("name", equipment_type),
                counted_qty=body.quantity, expected_qty=previous_at_location,
                variance=body.quantity - previous_at_location,
                status="reconciled", reason="Authoritative yard count",
                counted_by=user.name, reconciled_by=user.name, reconciled_at=now_utc(),
                condition=body.condition, yard_location=yard_location,
                notes=body.notes, authoritative=True,
            )
            await db.inventory_counts.insert_one(count.model_dump(), session=session)
            return count

        return await run_in_transaction(_do)

    return await idempotent(idempotency_key, "create_authoritative_yard_count", _run)


@api.post("/inventory-counts/{count_id}/reconcile", response_model=InventoryCount)
async def reconcile_inventory_count(
    count_id: str, body: ReconcileBody, user: UserPublic = Depends(require_role(Role.admin)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        if not body.reason.strip():
            raise HTTPException(400, "A reason is required to reconcile a variance")
        doc = await db.inventory_counts.find_one({"id": count_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Count not found")
        if doc["status"] == "reconciled":
            raise HTTPException(400, "Already reconciled")
        variance = doc["variance"]
        if variance < 0:
            # counted fewer than expected — the shortfall is unaccounted, not gone from ownership.
            await apply_ledger_entry(
                doc["equipment_id"], -variance, "available", "missing", "reconciliation",
                note=body.reason, created_by=user.name,
            )
        elif variance > 0:
            # counted more than expected — surplus stock that was never logged as received.
            await apply_ledger_entry(
                doc["equipment_id"], variance, "owned", "available", "reconciliation",
                note=body.reason, created_by=user.name,
            )
        await db.inventory_counts.update_one(
            {"id": count_id},
            {"$set": {"status": "reconciled", "reason": body.reason, "reconciled_by": user.name, "reconciled_at": now_utc()}},
        )
        new_doc = await db.inventory_counts.find_one({"id": count_id}, {"_id": 0})
        return InventoryCount(**new_doc)

    return await idempotent(idempotency_key, "reconcile_inventory_count", _run)


# ----------------------------- Transfers ------------------------------------
@api.get("/transfers", response_model=List[Transfer])
async def list_transfers(_: UserPublic = Depends(get_current_user)):
    docs = await db.transfers.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Transfer(**d) for d in docs]


@api.post("/equipment/{eq_id}/transfer", response_model=Transfer, status_code=201)
async def create_transfer(eq_id: str, body: TransferCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    """Move `qty` available units of this SKU to another yard. Units sit in
    the in_transit bucket until received at the destination. Bulk equipment
    tracks available stock per location (`location_balances`), so a partial
    transfer only moves units out of the specific yard they're leaving —
    it never relabels the whole available pool."""
    eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not eq:
        raise HTTPException(404, "Equipment not found")
    from_location = eq.get("location", "")
    balances: dict[str, int] = dict(eq.get("location_balances") or {})
    at_source = balances.get(from_location, 0)
    if body.qty <= 0 or body.qty > at_source:
        raise HTTPException(400, f"qty exceeds available units at {from_location or 'this location'}")
    to_location = body.to_location.strip()
    if not to_location:
        raise HTTPException(400, "to_location is required")

    transfer = Transfer(
        equipment_id=eq_id, equipment_name=eq.get("name", ""), qty=body.qty,
        from_location=from_location, to_location=to_location,
        note=body.note, created_by=user.name,
    )

    async def _do(session):
        await db.transfers.insert_one(transfer.model_dump(), session=session)
        await apply_ledger_entry(
            eq_id, body.qty, "available", "in_transit", "transfer",
            location=to_location, note=body.note, created_by=user.name, session=session,
        )
        # Decrement the specific source location's balance — conditional on
        # it still holding enough, so a concurrent transfer from the same
        # yard can't double-spend the same units.
        result = await db.equipment.update_one(
            {"id": eq_id, f"location_balances.{from_location}": {"$gte": body.qty}},
            {"$inc": {f"location_balances.{from_location}": -body.qty}},
            session=session,
        )
        if result.matched_count == 0:
            raise HTTPException(409, f"Not enough stock at {from_location or 'this location'} to transfer")

    await run_in_transaction(_do)
    return transfer


@api.post("/transfers/{transfer_id}/receive", response_model=Transfer)
async def receive_transfer(
    transfer_id: str, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        doc = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Transfer not found")
        if doc["status"] == "received":
            raise HTTPException(400, "Already received")
        to_location = doc["to_location"]

        async def _do(session):
            await apply_ledger_entry(
                doc["equipment_id"], doc["qty"], "in_transit", "available", "transfer",
                location=to_location, note=f"Received at {to_location}", created_by=user.name, session=session,
            )
            # Credit the destination location's own balance — the units that
            # left one yard land in this one; every other location's balance
            # (including any still in transit) is untouched.
            await db.equipment.update_one(
                {"id": doc["equipment_id"]},
                {"$inc": {f"location_balances.{to_location}": doc["qty"]}},
                session=session,
            )
            await db.transfers.update_one(
                {"id": transfer_id},
                {"$set": {"status": "received", "received_by": user.name, "received_at": now_utc()}},
                session=session,
            )

        await run_in_transaction(_do)

        # `location` (the single display/default location) tracks whichever
        # location now holds the most available stock — informational only;
        # location_balances is the source of truth for "what's where".
        eq = await db.equipment.find_one({"id": doc["equipment_id"]}, {"_id": 0})
        balances: dict[str, int] = eq.get("location_balances") or {}
        if balances:
            top_location = max(balances, key=lambda loc: balances[loc])
            if top_location != eq.get("location"):
                await db.equipment.update_one({"id": doc["equipment_id"]}, {"$set": {"location": top_location}})

        new_doc = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
        return Transfer(**new_doc)

    return await idempotent(idempotency_key, "receive_transfer", _run)


# ----------------------------- Dispatch / Movements --------------------------
async def _set_dispatch_status(doc: dict, new_status: str, user: UserPublic) -> dict:
    """Apply one status transition (including 'cancelled') to a dispatch doc:
    moves its lines' qty between the buckets dispatch_bucket_for_status maps
    the old and new status to, stamps the relevant timestamp, and — for an
    outbound dispatch completing without an existing rental — creates the
    Rental and marks any linked booking dispatched. Persists the change and
    returns the updated doc (mutates `doc` in place too, so callers fast-
    forwarding through several stages can just keep passing it back in)."""
    direction = doc["direction"]
    flow = DISPATCH_FLOWS[direction]
    current = doc["status"]
    if new_status == DispatchStatus.COMPLETED:
        if direction == "outbound":
            if any(line.get("delivered_qty") is None for line in doc["lines"]):
                raise HTTPException(400, "Enter the delivered quantity for every product before completing the delivery ticket")
            if not any(int(line.get("delivered_qty") or 0) > 0 for line in doc["lines"]):
                raise HTTPException(400, "At least one delivered quantity must be greater than zero")
            if any(int(line.get("delivered_qty") or 0) > int(line["qty"]) for line in doc["lines"]):
                raise HTTPException(400, "Delivered quantity cannot exceed the loaded quantity")
        elif any(not line.get("pickup_confirmed", False) for line in doc["lines"]):
            raise HTTPException(400, "Check every picked-up product before completing the pickup ticket")
    old_bucket = dispatch_bucket_for_status(direction, current)
    if new_status == DispatchStatus.CANCELLED:
        if direction == "outbound" and not doc.get("booking_id"):
            # This dispatch made its own available -> reserved reservation on
            # create (no booking backing it) — cancelling must release it all
            # the way back to available, not leave it stuck in reserved.
            new_bucket = "available"
        else:
            new_bucket = dispatch_bucket_for_status(direction, flow[0])
    else:
        new_bucket = dispatch_bucket_for_status(direction, new_status)

    now = now_utc()
    upd: dict = {"status": new_status, "updated_at": now}
    if new_status == DispatchStatus.DISPATCHED and not doc.get("started_at"):
        upd["started_at"] = now
    if new_status == DispatchStatus.ARRIVED and not doc.get("arrived_at"):
        upd["arrived_at"] = now
    if new_status in DispatchStatus.TERMINAL:
        upd["completed_at"] = now

    if direction == "outbound" and new_status == DispatchStatus.COMPLETED:
        # Only the driver-counted quantity becomes the Rental. Anything that
        # was loaded but not delivered is released back to available stock.
        for line in doc["lines"]:
            delivered_qty = int(line.get("delivered_qty") or 0)
            if delivered_qty > 0:
                await apply_ledger_entry(
                    line["equipment_id"], delivered_qty, old_bucket, new_bucket,
                    "dispatch_outbound_completed", location=doc.get("job_site", ""),
                    rental_id=doc.get("rental_id"), booking_id=doc.get("booking_id"), created_by=user.name,
                )
            remainder = int(line["qty"]) - delivered_qty
            if remainder > 0:
                await apply_ledger_entry(
                    line["equipment_id"], remainder, old_bucket, "available",
                    "delivery_quantity_reconciled", location="Yard",
                    booking_id=doc.get("booking_id"), created_by=user.name,
                )
    elif old_bucket != new_bucket:
        for line in doc["lines"]:
            await apply_ledger_entry(
                line["equipment_id"], line["qty"], old_bucket, new_bucket,
                f"dispatch_{direction}_{new_status}", location=doc.get("job_site", ""),
                rental_id=doc.get("rental_id"), booking_id=doc.get("booking_id"), created_by=user.name,
            )

    if direction == "outbound" and new_status == DispatchStatus.COMPLETED and not doc.get("rental_id"):
        rental = Rental(
            customer_name=doc["customer_name"], customer_type=doc.get("customer_type", "company"),
            job_site=doc.get("job_site", ""), job_address=doc.get("job_address", ""),
            start_date=doc.get("scheduled_date") or now_utc(), notes=doc.get("notes", ""),
            lines=[
                RentalLine(
                    equipment_id=l["equipment_id"], sku=l["sku"], name=l["name"],
                    qty=int(l["delivered_qty"]), delivered_qty=int(l["delivered_qty"]), daily_rate=0,
                )
                for l in doc["lines"] if int(l.get("delivered_qty") or 0) > 0
            ],
            booking_id=doc.get("booking_id"),
        )
        await db.rentals.insert_one(rental.model_dump())
        await sync_contact_from_rental(rental)
        upd["rental_id"] = rental.id
        if doc.get("booking_id"):
            await db.bookings.update_one({"id": doc["booking_id"]}, {"$set": {"status": BookingStatus.DISPATCHED, "dispatched_rental_id": rental.id}})

    if direction == "inbound" and new_status == DispatchStatus.COMPLETED and doc.get("rental_id"):
        # The truck physically picked these units up off the job — that's a
        # return event. Credit it against the rental's lines the same way
        # partial_return does, so the rental's outstanding/returned math and
        # status stay correct regardless of which path (desk return vs.
        # scheduled pickup) brought the units back.
        rdoc = await db.rentals.find_one({"id": doc["rental_id"]}, {"_id": 0})
        if rdoc:
            rental = Rental(**rdoc)
            for dline in doc["lines"]:
                for rline in rental.lines:
                    if rline.equipment_id == dline["equipment_id"]:
                        remaining = resolve_delivered_qty(rline) - rline.returned_qty
                        rline.returned_qty += min(dline["qty"], remaining)
                        break
            all_returned = all(l.returned_qty >= resolve_delivered_qty(l) for l in rental.lines)
            any_returned = any(l.returned_qty > 0 for l in rental.lines)
            rental.status = RentalStatus.RETURNED if all_returned else (RentalStatus.PARTIALLY_RETURNED if any_returned else RentalStatus.ACTIVE)
            await db.rentals.update_one({"id": doc["rental_id"]}, {"$set": rental.model_dump()})

    await db.dispatches.update_one({"id": doc["id"]}, {"$set": upd})
    doc.update(upd)
    return doc


@api.get("/dispatches", response_model=List[Dispatch])
async def list_dispatches(
    direction: Optional[str] = None,
    status: Optional[str] = None,
    rental_id: Optional[str] = None,
    booking_id: Optional[str] = None,
    _: UserPublic = Depends(get_current_user),
):
    query: dict = {}
    if direction:
        query["direction"] = direction
    if status:
        query["status"] = status
    if rental_id:
        query["rental_id"] = rental_id
    if booking_id:
        query["booking_id"] = booking_id
    docs = await db.dispatches.find(query, {"_id": 0}).sort("scheduled_date", 1).to_list(2000)
    return [Dispatch(**d) for d in docs]


@api.get("/dispatches/{d_id}", response_model=Dispatch)
async def get_dispatch(d_id: str, _: UserPublic = Depends(get_current_user)):
    doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Dispatch not found")
    return Dispatch(**doc)


@api.post("/dispatches", response_model=Dispatch, status_code=201)
async def create_dispatch(body: DispatchCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    if body.direction not in DISPATCH_FLOWS:
        raise HTTPException(400, "direction must be 'outbound' or 'inbound'")
    if not body.lines:
        raise HTTPException(400, "Dispatch needs at least one equipment line")
    if body.direction == "inbound":
        if not body.rental_id:
            raise HTTPException(400, "Inbound dispatch requires rental_id — it can only pick up units already on that rental")
        existing = await db.dispatches.find_one(
            {"rental_id": body.rental_id, "direction": "inbound", "status": {"$nin": list(DispatchStatus.TERMINAL)}}, {"_id": 0}
        )
        if existing:
            raise HTTPException(400, "A pickup is already scheduled for this rental")
        rdoc = await db.rentals.find_one({"id": body.rental_id}, {"_id": 0})
        if not rdoc:
            raise HTTPException(404, "Rental not found")
        rental = Rental(**rdoc)
        outstanding_by_eq: dict = {}
        for rline in rental.lines:
            outstanding_by_eq[rline.equipment_id] = outstanding_by_eq.get(rline.equipment_id, 0) + max(0, resolve_delivered_qty(rline) - rline.returned_qty)
        needed: dict = {}
        for line in body.lines:
            needed[line.equipment_id] = needed.get(line.equipment_id, 0) + line.qty
        for eq_id, qty in needed.items():
            if qty > outstanding_by_eq.get(eq_id, 0):
                raise HTTPException(400, f"Pickup qty for {eq_id} exceeds what's still outstanding on that rental")

    dispatch = Dispatch(
        **body.model_dump(),
        date_confirmed=body.scheduled_date is not None,
        created_by=user.name,
    )
    if dispatch.customer_type == "homeowner" and dispatch.job_site.strip():
        dispatch.customer_name = dispatch.job_site.strip()
    starting_bucket = dispatch_bucket_for_status(dispatch.direction, dispatch.status)

    if dispatch.direction == "outbound" and not dispatch.booking_id:
        # No booking behind this dispatch to have already reserved the units
        # — reserve them from available right now, so the dispatch's own
        # bucket (starting_bucket == "reserved") is actually backed by stock.
        # Aggregate qty per equipment_id first — two lines for the same SKU
        # must be checked against their combined demand, not independently.
        needed: dict = {}
        for line in dispatch.lines:
            needed[line.equipment_id] = needed.get(line.equipment_id, 0) + line.qty
        for eq_id, qty in needed.items():
            eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
            if not eq or eq.get("available", 0) < qty:
                raise HTTPException(400, f"Not enough available {eq.get('name', eq_id) if eq else eq_id} to schedule this dispatch")
        for line in dispatch.lines:
            await apply_ledger_entry(
                line.equipment_id, line.qty, "available", starting_bucket, "dispatch_scheduled",
                location=dispatch.job_site, booking_id=dispatch.booking_id, created_by=user.name,
            )

    await db.dispatches.insert_one(dispatch.model_dump())
    return dispatch


@api.patch("/dispatches/{d_id}/assign", response_model=Dispatch)
async def assign_dispatch(d_id: str, body: DispatchAssignUpdate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Dispatch not found")
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    # An explicitly-cleared pickup date is meaningful: it returns the item to
    # the unconfirmed state instead of silently retaining the previous date.
    if "scheduled_date" in body.model_fields_set:
        upd["scheduled_date"] = body.scheduled_date
        upd["date_confirmed"] = body.scheduled_date is not None
    if upd:
        upd["updated_at"] = now_utc()
        await db.dispatches.update_one({"id": d_id}, {"$set": upd})
    new_doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
    return Dispatch(**new_doc)


@api.patch("/dispatches/{d_id}/status", response_model=Dispatch)
async def update_dispatch_status(
    d_id: str, body: DispatchStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Dispatch not found")
        current = doc["status"]
        if current in DispatchStatus.TERMINAL:
            raise HTTPException(400, f"Dispatch already {current}")

        if doc.get("planning_only"):
            now = now_utc()
            if body.status == DispatchStatus.CANCELLED:
                update = {"status": DispatchStatus.CANCELLED, "updated_at": now, "completed_at": now}
            elif doc["direction"] == "outbound" and body.status == DispatchStatus.ACTIVE_RENTAL:
                # A delivered planning reminder enters the Active Rentals view.
                # Direction remains an internal movement field; dispatch lists
                # hide this phase until an admin completes the rental.
                update = {"direction": "inbound", "status": DispatchStatus.ACTIVE_RENTAL, "updated_at": now, "completed_at": None}
            elif doc["direction"] == "inbound" and current == DispatchStatus.ACTIVE_RENTAL and body.status == DispatchStatus.READY_FOR_PICKUP:
                if user.role != Role.admin:
                    raise HTTPException(403, "Only an admin can complete an active rental")
                update = {"status": DispatchStatus.READY_FOR_PICKUP, "updated_at": now, "completed_at": None}
            elif doc["direction"] == "inbound" and body.status == DispatchStatus.COMPLETED:
                update = {"status": DispatchStatus.COMPLETED, "updated_at": now, "completed_at": now}
            else:
                raise HTTPException(400, "Invalid planning-item status transition")
            await db.dispatches.update_one({"id": d_id}, {"$set": update})
            updated_plan = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
            return Dispatch(**updated_plan)

        flow = DISPATCH_FLOWS[doc["direction"]]
        new_status = body.status
        if new_status != DispatchStatus.CANCELLED:
            if new_status not in flow:
                raise HTTPException(400, f"Invalid status for a {doc['direction']} dispatch")
            cur_idx = flow.index(current)
            new_idx = flow.index(new_status)
            if new_idx != cur_idx + 1:
                raise HTTPException(400, f"Cannot jump from '{current}' to '{new_status}' — next step is '{flow[cur_idx + 1]}'")

        updated = await _set_dispatch_status(doc, new_status, user)
        return Dispatch(**updated)

    return await idempotent(idempotency_key, "update_dispatch_status", _run)


@api.post("/dispatches/{d_id}/complete-ticket", response_model=Dispatch)
async def complete_dispatch_ticket(
    d_id: str,
    body: DispatchTicketComplete,
    user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    """Complete the final delivery/pickup step with a per-product driver
    attestation. Outbound lines require a counted delivered quantity; inbound
    lines require a checked pickup confirmation."""
    async def _run():
        doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Dispatch not found")
        if doc.get("planning_only"):
            raise HTTPException(400, "Planning reminders do not use physical delivery tickets")
        flow = DISPATCH_FLOWS[doc["direction"]]
        if doc["status"] != flow[-2]:
            raise HTTPException(400, f"Ticket can only be completed from '{flow[-2]}'")
        if len(body.lines) != len(doc["lines"]):
            raise HTTPException(400, "Every product on the ticket must be confirmed")

        confirmations = {line.line_index: line for line in body.lines}
        if len(confirmations) != len(doc["lines"]):
            raise HTTPException(400, "Each product must be confirmed exactly once")
        verified_lines = []
        for index, raw_line in enumerate(doc["lines"]):
            confirmation = confirmations.get(index)
            if not confirmation or confirmation.equipment_id != raw_line["equipment_id"]:
                raise HTTPException(400, "Ticket product confirmation does not match the dispatch")
            line = DispatchLine(**raw_line)
            if doc["direction"] == "outbound":
                if confirmation.delivered_qty is None:
                    raise HTTPException(400, "Enter the delivered quantity for every product")
                if confirmation.delivered_qty > line.qty:
                    raise HTTPException(400, f"Delivered quantity for {line.name} exceeds the loaded quantity")
                line.delivered_qty = confirmation.delivered_qty
            else:
                if not confirmation.pickup_confirmed:
                    raise HTTPException(400, f"Confirm {line.name} was picked up")
                line.pickup_confirmed = True
            verified_lines.append(line.model_dump())

        doc["lines"] = verified_lines
        await db.dispatches.update_one(
            {"id": d_id},
            {"$set": {"lines": verified_lines, "updated_at": now_utc()}},
        )
        updated = await _set_dispatch_status(doc, DispatchStatus.COMPLETED, user)
        return Dispatch(**updated)

    return await idempotent(idempotency_key, "complete_dispatch_ticket", _run)


async def _create_outbound_dispatch_for_booking(doc: dict, user: UserPublic) -> Optional[dict]:
    """Create the linked outbound Dispatch for a just-confirmed booking. The
    booking's own reservation already moved units available -> reserved on
    booking creation, so this does NOT touch buckets — create_dispatch skips
    its reserve step whenever booking_id is set. No-ops (returns None) if a
    live (non-cancelled) outbound dispatch is already linked to this booking,
    so re-confirming or a retried call never double-creates one."""
    if not doc.get("items"):
        return None
    existing = await db.dispatches.find_one(
        {"booking_id": doc["id"], "direction": "outbound", "status": {"$ne": DispatchStatus.CANCELLED}}, {"_id": 0}
    )
    if existing:
        return existing
    dispatch = Dispatch(
        direction="outbound",
        scheduled_date=doc.get("start_date"),
        customer_name=doc["customer_name"],
        customer_type=doc.get("customer_type", "company"),
        job_site=doc.get("job_site", ""),
        job_address=doc.get("job_address", ""),
        lat=doc.get("lat"),
        lng=doc.get("lng"),
        booking_id=doc["id"],
        lines=[DispatchLine(**item) for item in doc["items"]],
        created_by=user.name,
    )
    await db.dispatches.insert_one(dispatch.model_dump())
    return dispatch.model_dump()


async def _on_booking_confirmed(doc: dict, user: UserPublic) -> None:
    """Side effects of a booking becoming confirmed: a staging ShopTask and
    the linked outbound Dispatch. Shared by update_booking_status (the
    tentative/cancelled -> confirmed transition) and create_booking (a
    booking created directly with status='confirmed', which never goes
    through that transition) so neither path silently skips it."""
    bk_id = doc["id"]
    existing = await db.shop_tasks.find_one({"related_booking_id": bk_id, "task_type": "staging"})
    if not existing and doc.get("items"):
        job = doc.get("job_site") or doc.get("customer_name", "")
        checklist = [ChecklistItem(text=f"{item['qty']} {item['name']}") for item in doc["items"]]
        task = ShopTask(
            title=f"Stage {job} rental", task_type="staging", priority="normal",
            due_date=doc.get("start_date"), checklist=checklist,
            related_booking_id=bk_id, created_by=user.name,
        )
        await db.shop_tasks.insert_one(task.model_dump())
    await _create_outbound_dispatch_for_booking(doc, user)


async def _cancel_linked_outbound_dispatch(bk_id: str, user: UserPublic) -> None:
    """If a booking has a live (non-completed/cancelled) linked outbound
    Dispatch, cancel it first. A booking staying 'confirmed' does not mean
    its units are still sitting in 'reserved' — the linked Dispatch may have
    already moved them into staged/outbound/on_rental. Cancelling the
    Dispatch here rolls them back to 'reserved' from whatever bucket they're
    actually in (the same rollback _set_dispatch_status already does for any
    dispatch cancellation), so the caller's own reserved -> available release
    is then operating on units that are genuinely in 'reserved'."""
    doc = await db.dispatches.find_one(
        {"booking_id": bk_id, "direction": "outbound", "status": {"$nin": list(DispatchStatus.TERMINAL)}}, {"_id": 0}
    )
    if doc:
        await _set_dispatch_status(doc, DispatchStatus.CANCELLED, user)


# ----------------------------- Serialized units -----------------------------
@api.get("/equipment/{eq_id}/serials", response_model=List[SerialUnit])
async def list_serial_units(eq_id: str, _: UserPublic = Depends(get_current_user)):
    docs = await db.serial_units.find({"equipment_id": eq_id}, {"_id": 0}).sort("serial_no", 1).to_list(2000)
    return [SerialUnit(**d) for d in docs]


@api.post("/equipment/{eq_id}/serials", response_model=SerialUnit, status_code=201)
async def create_serial_unit(eq_id: str, body: SerialUnitCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not eq:
        raise HTTPException(404, "Equipment not found")
    unit = SerialUnit(equipment_id=eq_id, **body.model_dump())
    await db.serial_units.insert_one(unit.model_dump())
    return unit


@api.put("/serials/{serial_id}", response_model=SerialUnit)
async def update_serial_unit(serial_id: str, body: SerialUnitUpdate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.serial_units.find_one({"id": serial_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Serial unit not found")
    upd = {k: v for k, v in body.model_dump().items() if v is not None}
    if upd:
        await db.serial_units.update_one({"id": serial_id}, {"$set": upd})
    new_doc = await db.serial_units.find_one({"id": serial_id}, {"_id": 0})
    return SerialUnit(**new_doc)


@api.delete("/serials/{serial_id}")
async def delete_serial_unit(serial_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    res = await db.serial_units.delete_one({"id": serial_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Serial unit not found")
    return {"ok": True}


# ----------------------------- Rentals ------------------------------------
@api.get("/rentals", response_model=List[Rental])
async def list_rentals(user: UserPublic = Depends(get_current_user)):
    docs = await db.rentals.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Rental(**redact_money_for_crew(d, user.role.value)) for d in docs]


@api.get("/rental-contact-actions")
async def list_rental_contact_actions(_: UserPublic = Depends(get_current_user)):
    """Return status-driven customer follow-ups that have not been logged yet.

    Nathan can poll this read-only queue. The queue does not send anything;
    contact permission remains explicit and every completed call/text/email is
    written back to the rental's communication log with its trigger key.
    """
    rentals = await db.rentals.find({}, {"_id": 0}).to_list(2000)
    dispatches = await db.dispatches.find(
        {"planning_only": {"$ne": True}, "rental_id": {"$type": "string"}}, {"_id": 0}
    ).to_list(4000)
    by_rental: dict[str, list[dict]] = {}
    for dispatch in dispatches:
        by_rental.setdefault(dispatch["rental_id"], []).append(dispatch)

    actions: list[dict[str, Any]] = []
    now = now_utc()
    for doc in rentals:
        logged = {entry.get("trigger_key") for entry in doc.get("communication_log", []) if entry.get("trigger_key")}
        common = {
            "rental_id": doc["id"],
            "company_homeowner_name": doc.get("customer_name", ""),
            "primary_contact": doc.get("primary_contact", ""),
            "phone": doc.get("customer_phone", ""),
            "email": doc.get("customer_email", ""),
            "preferred_contact_method": doc.get("preferred_contact_method", "call"),
            "contact_permission": bool(doc.get("contact_permission", False)),
            "job_site": doc.get("job_site", ""),
            "job_address": doc.get("job_address", ""),
            "customer_type": doc.get("customer_type", "company"),
        }
        linked = by_rental.get(doc["id"], [])
        for dispatch in linked:
            if dispatch.get("direction") == "outbound" and dispatch.get("status") == DispatchStatus.SCHEDULED:
                trigger_key = f"outbound_scheduled:{dispatch['id']}"
                if trigger_key not in logged:
                    actions.append({**common, "event": "outbound_scheduled", "trigger_key": trigger_key, "dispatch_id": dispatch["id"], "suggested_action": "Confirm delivery details"})
            if dispatch.get("direction") == "outbound" and dispatch.get("status") == DispatchStatus.COMPLETED:
                trigger_key = f"delivery_complete:{dispatch['id']}"
                if trigger_key not in logged:
                    actions.append({**common, "event": "delivery_complete", "trigger_key": trigger_key, "dispatch_id": dispatch["id"], "suggested_action": "Send delivery receipt and update"})
            if dispatch.get("direction") == "inbound" and dispatch.get("status") == DispatchStatus.SCHEDULED:
                trigger_key = f"inbound_scheduled:{dispatch['id']}"
                if trigger_key not in logged:
                    actions.append({**common, "event": "inbound_scheduled", "trigger_key": trigger_key, "dispatch_id": dispatch["id"], "suggested_action": "Confirm pickup details"})

        due = doc.get("due_date")
        if isinstance(due, str):
            try:
                due = datetime.fromisoformat(due.replace("Z", "+00:00"))
            except ValueError:
                due = None
        if isinstance(due, datetime):
            if due.tzinfo is None:
                due = due.replace(tzinfo=timezone.utc)
            trigger_key = f"return_overdue:{doc['id']}:{due.date().isoformat()}"
            if doc.get("status") in RentalStatus.OPEN and due < now and trigger_key not in logged:
                actions.append({**common, "event": "return_overdue", "trigger_key": trigger_key, "suggested_action": "Follow up about the overdue return"})
    return {"items": actions, "count": len(actions)}


@api.get("/rentals/{rental_id}/communications", response_model=List[CommunicationLogEntry])
async def list_rental_communications(rental_id: str, _: UserPublic = Depends(get_current_user)):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0, "communication_log": 1})
    if not doc:
        raise HTTPException(404, "Rental not found")
    entries = [CommunicationLogEntry(**entry) for entry in doc.get("communication_log", [])]
    return sorted(entries, key=lambda entry: entry.created_at, reverse=True)


@api.post("/rentals/{rental_id}/communications", response_model=CommunicationLogEntry, status_code=201)
async def create_rental_communication(
    rental_id: str, body: CommunicationLogCreate,
    user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        if body.channel not in ("call", "text", "email", "in_person", "other"):
            raise HTTPException(400, "Unsupported communication channel")
        if body.direction not in ("outgoing", "incoming"):
            raise HTTPException(400, "Direction must be outgoing or incoming")
        if not body.summary.strip():
            raise HTTPException(400, "Communication summary is required")
        rental = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
        if not rental:
            raise HTTPException(404, "Rental not found")
        if body.direction == "outgoing" and not rental.get("contact_permission", False):
            raise HTTPException(409, "Outgoing contact is blocked until Contact Permission is enabled")
        entry = CommunicationLogEntry(
            **{**body.model_dump(), "summary": body.summary.strip()}, created_by=user.name
        )
        await db.rentals.update_one(
            {"id": rental_id},
            {"$push": {"communication_log": {"$each": [entry.model_dump()], "$position": 0}}},
        )
        return entry

    return await idempotent(idempotency_key, "create_rental_communication", _run)


@api.post("/rentals", response_model=Rental, status_code=201)
async def create_rental(
    body: RentalCreate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        rental = Rental(**body.model_dump())
        if rental.customer_type == "homeowner" and rental.job_site.strip():
            rental.customer_name = rental.job_site.strip()

        async def _do(session):
            for line in rental.lines:
                await apply_ledger_entry(
                    line.equipment_id, line.qty, "available", "on_rental", "rental_created",
                    location=rental.job_site, rental_id=rental.id, created_by=user.name, session=session,
                )
            await db.rentals.insert_one(rental.model_dump(), session=session)
            await sync_contact_from_rental(rental, session=session)

        # All lines allocate or none do — otherwise a shortfall on line 2 of 3
        # would leave line 1's stock already committed with no rental to show
        # for it (over-allocation with no paper trail).
        await run_in_transaction(_do)
        return rental

    return await idempotent(idempotency_key, "create_rental", _run)


@api.post("/rentals/{rental_id}/return", response_model=Rental)
async def partial_return(
    rental_id: str, returns: List[ReturnLine] = Body(...), user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Rental not found")
        rental = Rental(**doc)
        for ret in returns:
            for line in rental.lines:
                if line.equipment_id == ret.equipment_id:
                    # returned_qty already counts every physically-returned unit,
                    # damaged or not — damaged_qty is a subset marker, not an
                    # additional deduction.
                    remaining = resolve_delivered_qty(line) - line.returned_qty
                    qty_back = min(ret.qty, remaining)
                    damaged = min(ret.damaged_qty, qty_back)
                    clean = qty_back - damaged
                    line.returned_qty += qty_back
                    line.damaged_qty += damaged
                    if clean > 0:
                        await apply_ledger_entry(
                            line.equipment_id, clean, "on_rental", "pending_inspection", "rental_returned",
                            rental_id=rental_id, created_by=user.name,
                        )
                    if damaged > 0:
                        await apply_ledger_entry(
                            line.equipment_id, damaged, "on_rental", "in_maintenance", "damage_reported",
                            rental_id=rental_id, created_by=user.name,
                        )
                        task = ShopTask(
                            title=f"Repair {damaged} {line.name}", task_type="repair", priority="high",
                            qty=damaged, related_rental_id=rental_id, related_equipment_id=line.equipment_id,
                            notes=f"Reported damaged on return from {rental.customer_name}.", created_by=user.name,
                        )
                        await db.shop_tasks.insert_one(task.model_dump())
        all_returned = all(l.returned_qty >= resolve_delivered_qty(l) for l in rental.lines)
        any_returned = any(l.returned_qty > 0 for l in rental.lines)
        rental.status = RentalStatus.RETURNED if all_returned else (RentalStatus.PARTIALLY_RETURNED if any_returned else RentalStatus.ACTIVE)
        await db.rentals.update_one({"id": rental_id}, {"$set": rental.model_dump()})
        return rental

    return await idempotent(idempotency_key, "partial_return", _run)


async def _create_pickup_dispatch(
    rental_id: str,
    body: SchedulePickupCreate,
    user: UserPublic,
    *,
    rental_completed: bool = False,
) -> Dispatch:
    """Create the inbound Dispatch that sends a truck back out to a job to
    collect a rental's still-outstanding units. Lines are derived from what's
    actually left on site (delivered - returned) — already-returned lines are
    skipped so the driver isn't sent to pick up units that came back some
    other way (e.g. a desk return)."""
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")
    rental = Rental(**doc)
    if rental.status == RentalStatus.RETURNED:
        raise HTTPException(400, "Rental is already fully returned — nothing left to pick up")
    existing = await db.dispatches.find_one(
        {"rental_id": rental_id, "direction": "inbound", "status": {"$nin": list(DispatchStatus.TERMINAL)}}, {"_id": 0}
    )
    if existing:
        raise HTTPException(400, "A pickup is already scheduled for this rental")

    lines = []
    for line in rental.lines:
        outstanding = resolve_delivered_qty(line) - line.returned_qty
        if outstanding > 0:
            lines.append(DispatchLine(equipment_id=line.equipment_id, sku=line.sku, name=line.name, qty=outstanding))
    if not lines:
        raise HTTPException(400, "Nothing outstanding to pick up on this rental")

    dispatch = Dispatch(
        direction="inbound",
        scheduled_date=body.scheduled_date,
        date_confirmed=body.scheduled_date is not None,
        customer_name=rental.customer_name,
        customer_type=rental.customer_type,
        job_site=rental.job_site,
        job_address=rental.job_address,
        lat=rental.lat, lng=rental.lng,
        rental_id=rental_id,
        rental_completed=rental_completed,
        driver_name=body.driver_name, truck=body.truck, trailer=body.trailer, crew=body.crew,
        lines=lines,
        notes=body.notes,
        created_by=user.name,
    )
    await db.dispatches.insert_one(dispatch.model_dump())
    return dispatch


@api.post("/rentals/{rental_id}/schedule-pickup", response_model=Dispatch, status_code=201)
async def schedule_pickup(rental_id: str, body: SchedulePickupCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    """Foreman pickup scheduling path used when a field crew knows a rental
    needs collection before an admin closes it from Active Rentals."""
    return await _create_pickup_dispatch(rental_id, body, user)


@api.post("/rentals/{rental_id}/complete", response_model=Dispatch, status_code=201)
async def complete_active_rental(
    rental_id: str,
    body: SchedulePickupCreate,
    user: UserPublic = Depends(require_role(Role.admin)),
):
    """Admin operational close: remove the job from Active Rentals by
    creating its inbound pickup movement. The rental and inventory remain
    active/on_rental until the physical inbound dispatch is checked in."""
    existing = await db.dispatches.find_one(
        {"rental_id": rental_id, "direction": "inbound", "status": {"$nin": list(DispatchStatus.TERMINAL)}}, {"_id": 0}
    )
    if existing:
        update = {
            "rental_completed": True,
            "scheduled_date": body.scheduled_date,
            "date_confirmed": body.scheduled_date is not None,
            "updated_at": now_utc(),
        }
        await db.dispatches.update_one({"id": existing["id"]}, {"$set": update})
        existing.update(update)
        return Dispatch(**existing)
    return await _create_pickup_dispatch(rental_id, body, user, rental_completed=True)


@api.post("/dispatches/{d_id}/complete-rental", response_model=Dispatch)
async def complete_planning_rental(
    d_id: str,
    body: SchedulePickupCreate,
    _: UserPublic = Depends(require_role(Role.admin)),
):
    """Move a delivered planning-only reminder from Active Rentals into
    Inbound without creating a Rental or touching inventory buckets."""
    doc = await db.dispatches.find_one({"id": d_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Dispatch not found")
    if not doc.get("planning_only") or doc.get("status") != DispatchStatus.ACTIVE_RENTAL:
        raise HTTPException(400, "Only a delivered planning rental can be completed")
    now = now_utc()
    update = {
        "direction": "inbound",
        "status": DispatchStatus.READY_FOR_PICKUP,
        "scheduled_date": body.scheduled_date,
        "date_confirmed": body.scheduled_date is not None,
        "notes": body.notes or doc.get("notes", ""),
        "updated_at": now,
        "completed_at": None,
    }
    await db.dispatches.update_one({"id": d_id}, {"$set": update})
    doc.update(update)
    return Dispatch(**doc)


@api.patch("/rentals/{rental_id}/location", response_model=Rental)
async def update_rental_location(rental_id: str, body: LocationUpdate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")
    await db.rentals.update_one({"id": rental_id}, {"$set": {"lat": body.lat, "lng": body.lng}})
    new_doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    return Rental(**new_doc)


@api.put("/rentals/{rental_id}", response_model=Rental)
async def update_rental(rental_id: str, body: RentalCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")

    # Compute per-equipment outstanding (still on_rental) quantities old vs new
    # to rebalance the ledger — only the portion still out on rental moves;
    # units already returned/damaged for this rental are left alone.
    old_by_eq: dict[str, int] = {}
    for line in doc.get("lines", []):
        # returned_qty already counts every physically-returned unit, damaged
        # or not — damaged_qty is a subset marker, not an additional deduction.
        delivered = line.get("delivered_qty") or line["qty"]
        remaining = delivered - line.get("returned_qty", 0)
        old_by_eq[line["equipment_id"]] = old_by_eq.get(line["equipment_id"], 0) + remaining

    new_by_eq: dict[str, int] = {}
    for line in body.lines:
        new_by_eq[line.equipment_id] = new_by_eq.get(line.equipment_id, 0) + line.qty

    async def _rebalance(session):
        for eq_id in set(old_by_eq) | set(new_by_eq):
            delta = new_by_eq.get(eq_id, 0) - old_by_eq.get(eq_id, 0)  # +ve means MORE committed
            if delta > 0:
                await apply_ledger_entry(eq_id, delta, "available", "on_rental", "rental_updated", rental_id=rental_id, created_by=user.name, session=session)
            elif delta < 0:
                await apply_ledger_entry(eq_id, -delta, "on_rental", "available", "rental_updated", rental_id=rental_id, created_by=user.name, session=session)

    await run_in_transaction(_rebalance)

    # Preserve returned_qty/damaged_qty per equipment_id (clamped to new qty).
    old_returned: dict[str, int] = {l["equipment_id"]: l.get("returned_qty", 0) for l in doc.get("lines", [])}
    old_damaged: dict[str, int] = {l["equipment_id"]: l.get("damaged_qty", 0) for l in doc.get("lines", [])}
    upd = body.model_dump()
    if upd.get("customer_type") == "homeowner" and str(upd.get("job_site", "")).strip():
        upd["customer_name"] = str(upd["job_site"]).strip()
    for line in upd["lines"]:
        line["returned_qty"] = min(old_returned.get(line["equipment_id"], 0), line["qty"])
        line["damaged_qty"] = min(old_damaged.get(line["equipment_id"], 0), line["qty"])

    # Recompute status.
    if not upd["lines"]:
        upd["status"] = RentalStatus.ACTIVE
    else:
        all_ret = all(l["returned_qty"] >= (l.get("delivered_qty") or l["qty"]) for l in upd["lines"])
        any_ret = any(l["returned_qty"] > 0 for l in upd["lines"])
        upd["status"] = RentalStatus.RETURNED if all_ret else (RentalStatus.PARTIALLY_RETURNED if any_ret else RentalStatus.ACTIVE)

    # Preserve id, created_at, the communication log, and a legacy due date
    # when an older edit client does not send one.
    upd["id"] = rental_id
    upd["created_at"] = doc.get("created_at", now_utc())
    if upd.get("due_date") is None and doc.get("due_date") is not None:
        upd["due_date"] = doc["due_date"]
    # RentalCreate.booking_id defaults to None on every edit payload from the
    # existing UI (it doesn't send this field) — a bare model_dump() would
    # silently null out a booking-originated rental's linkage on its first
    # edit. Preserve whatever's already on the doc unless the caller actually
    # passed a booking_id.
    if not upd.get("booking_id") and doc.get("booking_id"):
        upd["booking_id"] = doc["booking_id"]
    # Older clients know only customer_name/phone/email/job_site. Do not erase
    # the richer contact card merely because such a client edited equipment or
    # notes on the rental.
    for field in (
        "primary_contact", "preferred_contact_method", "delivery_notes",
        "return_notes", "gate_access_instructions", "contact_permission",
    ):
        if field not in body.model_fields_set and field in doc:
            upd[field] = doc[field]

    await db.rentals.update_one({"id": rental_id}, {"$set": upd})
    new_doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    await sync_contact_from_rental(new_doc)
    return Rental(**new_doc)


@api.delete("/rentals/{rental_id}")
async def delete_rental(rental_id: str, user: UserPublic = Depends(require_role(Role.admin))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    # restore inventory: only the still-on_rental portion returns to available.
    # returned_qty already counts every physically-returned unit, damaged or
    # not — damaged_qty is a subset marker, not an additional deduction.
    for line in doc.get("lines", []):
        delivered = line.get("delivered_qty") or line["qty"]
        remaining = delivered - line.get("returned_qty", 0)
        if remaining > 0:
            await apply_ledger_entry(
                line["equipment_id"], remaining, "on_rental", "available", "rental_deleted",
                rental_id=rental_id, created_by=user.name,
            )
    await db.rentals.delete_one({"id": rental_id})
    return {"ok": True}


# ----------------------------- Bookings -----------------------------------
@api.get("/bookings", response_model=List[Booking])
async def list_bookings(user: UserPublic = Depends(get_current_user)):
    docs = await db.bookings.find({}, {"_id": 0}).sort("start_date", 1).to_list(1000)
    return [Booking(**redact_money_for_crew(d, user.role.value)) for d in docs]


@api.post("/bookings", response_model=Booking, status_code=201)
async def create_booking(body: BookingCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    bk = Booking(**body.model_dump())
    if bk.customer_type == "homeowner" and bk.job_site.strip():
        bk.customer_name = bk.job_site.strip()
    if bk.status != BookingStatus.CANCELLED:
        needed: dict = {}
        for item in bk.items:
            needed[item.equipment_id] = needed.get(item.equipment_id, 0) + item.qty
        for eq_id, qty in needed.items():
            eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
            if not eq or eq.get("available", 0) < qty:
                raise HTTPException(400, f"Not enough available {eq.get('name', eq_id) if eq else eq_id} to reserve this booking")
    await db.bookings.insert_one(bk.model_dump())
    if bk.status != BookingStatus.CANCELLED:
        for item in bk.items:
            await apply_ledger_entry(
                item.equipment_id, item.qty, "available", "reserved", "booking_reserved",
                location=bk.job_site, booking_id=bk.id, created_by=user.name,
            )
    if bk.status == BookingStatus.CONFIRMED:
        await _on_booking_confirmed(bk.model_dump(), user)
    return bk


@api.patch("/bookings/{bk_id}/status", response_model=Booking)
async def update_booking_status(bk_id: str, body: BookingStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Booking not found")
    if doc.get("status") == BookingStatus.DISPATCHED:
        raise HTTPException(400, "Booking already dispatched to a rental — manage it from the rental instead")
    if body.status not in (BookingStatus.TENTATIVE, BookingStatus.CONFIRMED, BookingStatus.CANCELLED):
        raise HTTPException(400, "Invalid status")
    was_active = doc.get("status") != BookingStatus.CANCELLED
    will_be_active = body.status != BookingStatus.CANCELLED
    if was_active and not will_be_active:
        await _cancel_linked_outbound_dispatch(bk_id, user)
        for item in doc.get("items", []):
            await apply_ledger_entry(
                item["equipment_id"], item["qty"], "reserved", "available", "booking_released",
                booking_id=bk_id, created_by=user.name,
            )
    elif not was_active and will_be_active:
        for item in doc.get("items", []):
            await apply_ledger_entry(
                item["equipment_id"], item["qty"], "available", "reserved", "booking_reserved",
                location=doc.get("job_site", ""), booking_id=bk_id, created_by=user.name,
            )
    if body.status == BookingStatus.CONFIRMED and doc.get("status") != BookingStatus.CONFIRMED:
        await _on_booking_confirmed(doc, user)
    await db.bookings.update_one({"id": bk_id}, {"$set": {"status": body.status}})
    new_doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    return Booking(**new_doc)


@api.delete("/bookings/{bk_id}")
async def delete_booking(bk_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    # A dispatched booking's units already moved reserved -> on_rental under
    # the rental it created — nothing is left in "reserved" to release.
    if doc and doc.get("status") not in (BookingStatus.CANCELLED, BookingStatus.DISPATCHED):
        await _cancel_linked_outbound_dispatch(bk_id, user)
        for item in doc.get("items", []):
            await apply_ledger_entry(
                item["equipment_id"], item["qty"], "reserved", "available", "booking_released",
                booking_id=bk_id, created_by=user.name,
            )
    await db.bookings.delete_one({"id": bk_id})
    return {"ok": True}


@api.post("/bookings/{bk_id}/dispatch", response_model=Dispatch, status_code=201)
async def dispatch_booking(bk_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    """Open a confirmed booking's linked outbound delivery. Completion must
    happen from the delivery ticket after the driver counts every product;
    this endpoint intentionally cannot bypass that verification gate."""
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Booking not found")
    if doc.get("status") != BookingStatus.CONFIRMED:
        raise HTTPException(400, "Only a confirmed booking can be dispatched")
    if not doc.get("items"):
        raise HTTPException(400, "Booking has no equipment to dispatch")

    dispatch_doc = await _create_outbound_dispatch_for_booking(doc, user)
    return Dispatch(**dispatch_doc)


@api.get("/bookings/capacity")
async def capacity_check(target_date: str, _: UserPublic = Depends(get_current_user)):
    """Return per-equipment availability for a given date."""
    try:
        d = datetime.fromisoformat(target_date)
    except Exception:
        raise HTTPException(400, "target_date must be ISO")
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    rentals = await db.rentals.find({"status": {"$in": list(RentalStatus.OPEN)}}, {"_id": 0}).to_list(1000)
    bookings = await db.bookings.find({"status": {"$in": list(BookingStatus.OPEN)}}, {"_id": 0}).to_list(1000)
    usage: dict[str, int] = {}
    # Active rentals commit inventory until returned (no due_date used).
    # returned_qty already counts every physically-returned unit, damaged or
    # not — damaged_qty is a subset marker, not an additional deduction.
    for r in rentals:
        for line in r.get("lines", []):
            delivered = line.get("delivered_qty") or line["qty"]
            rem = delivered - line.get("returned_qty", 0)
            if rem > 0:
                usage[line["equipment_id"]] = usage.get(line["equipment_id"], 0) + rem
    for b in bookings:
        sd, ed = b["start_date"], b["end_date"]
        if isinstance(sd, str): sd = datetime.fromisoformat(sd.replace("Z","+00:00"))
        if isinstance(ed, str): ed = datetime.fromisoformat(ed.replace("Z","+00:00"))
        if sd.date() <= d.date() <= ed.date():
            for line in b.get("items", []):
                usage[line["equipment_id"]] = usage.get(line["equipment_id"], 0) + line["qty"]
    out = []
    for e in equipment:
        committed = usage.get(e["id"], 0)
        out.append({
            "equipment_id": e["id"], "sku": e["sku"], "qr_code": e.get("qr_code"), "name": e["name"],
            "category": e["category"], "quantity": e["quantity"],
            "committed": committed, "available": max(e["quantity"] - committed, 0),
        })
    return {"date": d.date().isoformat(), "rows": out}


@api.get("/dashboard/shortages")
async def dashboard_shortages(days: int = 14, _: UserPublic = Depends(get_current_user)):
    """Scan the next `days` days for dates where committed demand (active
    rentals + tentative/confirmed bookings) exceeds owned quantity for any
    SKU, and name the jobs driving that demand."""
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    eq_by_id = {e["id"]: e for e in equipment}
    rentals = await db.rentals.find({"status": {"$in": list(RentalStatus.OPEN)}}, {"_id": 0}).to_list(1000)
    bookings = await db.bookings.find({"status": {"$in": list(BookingStatus.OPEN)}}, {"_id": 0}).to_list(1000)

    today = now_utc().date()
    shortages = []
    for offset in range(max(days, 0)):
        d = today + timedelta(days=offset)
        usage: dict[str, int] = {}
        jobs: dict[str, List[str]] = {}
        for r in rentals:
            for line in r.get("lines", []):
                delivered = line.get("delivered_qty") or line["qty"]
                rem = delivered - line.get("returned_qty", 0)
                if rem > 0:
                    usage[line["equipment_id"]] = usage.get(line["equipment_id"], 0) + rem
                    jobs.setdefault(line["equipment_id"], []).append(r.get("job_site") or r["customer_name"])
        for b in bookings:
            sd, ed = b["start_date"], b["end_date"]
            if isinstance(sd, str): sd = datetime.fromisoformat(sd.replace("Z", "+00:00"))
            if isinstance(ed, str): ed = datetime.fromisoformat(ed.replace("Z", "+00:00"))
            if sd.date() <= d <= ed.date():
                for item in b.get("items", []):
                    usage[item["equipment_id"]] = usage.get(item["equipment_id"], 0) + item["qty"]
                    jobs.setdefault(item["equipment_id"], []).append(b.get("job_site") or b["customer_name"])
        for eq_id, used in usage.items():
            eq = eq_by_id.get(eq_id)
            if not eq:
                continue
            short = used - eq["quantity"]
            if short > 0:
                shortages.append({
                    "date": d.isoformat(), "equipment_id": eq_id, "sku": eq["sku"], "qr_code": eq.get("qr_code"), "name": eq["name"],
                    "shortage": short, "demand": used, "owned": eq["quantity"],
                    "jobs": sorted(set(jobs.get(eq_id, []))),
                })
    return {"rows": shortages}


# ----------------------------- Jobs (composition seam, read-only) ----------
# Phase 1 of the Bookings/Rentals unification: a read-only endpoint that
# composes the Job DTO (defined above, near derive_job_status) from the
# existing bookings/rentals/dispatches collections. No new collection, no
# write path, no change to any existing endpoint's behavior — this can be
# deployed and rolled back independently of everything else.
def _build_job_line_from_rental(line: RentalLine) -> JobLine:
    delivered = resolve_delivered_qty(line)
    return JobLine(
        equipment_id=line.equipment_id, sku=line.sku, name=line.name,
        qty_ordered=line.qty, qty_delivered=delivered,
        qty_on_site=max(0, delivered - line.returned_qty),
        qty_returned=line.returned_qty, qty_damaged=line.damaged_qty,
    )


def _build_job_line_from_booking_item(item: RentalLine) -> JobLine:
    # Nothing has physically moved yet for a reservation — delivered/on-site/
    # returned/damaged are all zero until a dispatch (and then a rental)
    # exists for this booking.
    return JobLine(
        equipment_id=item.equipment_id, sku=item.sku, name=item.name,
        qty_ordered=item.qty, qty_delivered=0, qty_on_site=0, qty_returned=0, qty_damaged=0,
    )


async def _compose_jobs() -> List[Job]:
    """Join bookings, rentals, and their live linked dispatches at read time
    into the unified Job view. One Job per booking-or-rental chain: a rental
    that came from a booking replaces that booking's entry (the rental is
    the richer, more current source of truth once it exists); a booking with
    no rental yet gets its own entry; a standalone/walk-in rental (no
    booking_id) gets its own entry too.

    KNOWN GAP: has_pending_inspection is always False here. Distinguishing
    JobStatus.INSPECTION from JobStatus.CLOSED for a fully-returned rental
    requires knowing whether any of ITS units are still sitting in the
    pending_inspection bucket — but pending_inspection is a pooled
    per-equipment bucket, not tracked per rental or per unit, and
    inspect_equipment's ledger entry that clears it doesn't (can't, under
    the current bucket model) say which rental(s) the qty it's resolving
    came from. A heuristic net-sum over ledger_entries.rental_id was
    considered and rejected: entries INTO pending_inspection carry rental_id
    but the resolving entry OUT of it doesn't, so the sum would only ever
    grow — every rental would show INSPECTION forever after its first
    return, which is worse than the current always-CLOSED simplification.
    Fixing this for real needs inspect_equipment to attribute resolved qty
    back to originating rental(s), which the pooled-bucket model doesn't
    support today.
    """
    booking_docs = await db.bookings.find({}, {"_id": 0}).to_list(2000)
    rental_docs = await db.rentals.find({}, {"_id": 0}).to_list(2000)
    dispatch_docs = await db.dispatches.find({"planning_only": {"$ne": True}}, {"_id": 0}).to_list(4000)

    bookings = [Booking(**d) for d in booking_docs]
    rentals = [Rental(**d) for d in rental_docs]
    dispatches = [Dispatch(**d) for d in dispatch_docs]
    bookings_by_id = {b.id: b for b in bookings}

    live_outbound_by_booking: dict[str, Dispatch] = {}
    live_inbound_by_rental: dict[str, Dispatch] = {}
    for d in dispatches:
        if d.status in DispatchStatus.TERMINAL:
            continue
        if d.direction == "outbound" and d.booking_id:
            live_outbound_by_booking[d.booking_id] = d
        elif d.direction == "inbound" and d.rental_id:
            live_inbound_by_rental[d.rental_id] = d

    jobs: List[Job] = []
    covered_booking_ids: set[str] = set()

    for r in rentals:
        if r.booking_id:
            covered_booking_ids.add(r.booking_id)
        booking = bookings_by_id.get(r.booking_id) if r.booking_id else None
        dispatch = live_inbound_by_rental.get(r.id)
        lines = [_build_job_line_from_rental(l) for l in r.lines]
        status = derive_job_status(
            booking_status=booking.status if booking else None,
            outbound_status=None,
            rental_status=r.status,
            inbound_status=dispatch.status if dispatch else None,
            has_pending_inspection=False,
        )
        jobs.append(Job(
            id=r.id, booking_id=r.booking_id, rental_id=r.id,
            active_outbound_dispatch_id=None,
            active_inbound_dispatch_id=dispatch.id if dispatch else None,
            status=status, customer_name=r.customer_name, job_site=r.job_site,
            start_date=r.start_date, end_date=booking.end_date if booking else None,
            lines=lines, qty_outstanding=sum(l.qty_on_site for l in lines),
            is_standalone_rental=r.booking_id is None,
            cancelled=False, created_at=r.created_at,
        ))

    for b in bookings:
        if b.id in covered_booking_ids:
            continue
        dispatch = live_outbound_by_booking.get(b.id)
        lines = [_build_job_line_from_booking_item(item) for item in b.items]
        status = derive_job_status(
            booking_status=b.status,
            outbound_status=dispatch.status if dispatch else None,
            rental_status=None,
            inbound_status=None,
            has_pending_inspection=False,
        )
        jobs.append(Job(
            id=b.id, booking_id=b.id, rental_id=None,
            active_outbound_dispatch_id=dispatch.id if dispatch else None,
            active_inbound_dispatch_id=None,
            status=status, customer_name=b.customer_name, job_site=b.job_site,
            start_date=b.start_date, end_date=b.end_date,
            lines=lines, qty_outstanding=0,
            is_standalone_rental=False,
            cancelled=b.status == BookingStatus.CANCELLED, created_at=b.created_at,
        ))

    return jobs


@api.get("/jobs", response_model=List[Job])
async def list_jobs(_: UserPublic = Depends(get_current_user)):
    return await _compose_jobs()


@api.get("/jobs/{job_id}", response_model=Job)
async def get_job(job_id: str, _: UserPublic = Depends(get_current_user)):
    # O(compose everything, then filter) — matches the existing style of
    # other read endpoints in this file (e.g. equipment_breakdown) and is
    # fine at this shop's data volume; not something to scale past as-is.
    for job in await _compose_jobs():
        if job.id == job_id:
            return job
    raise HTTPException(404, "Job not found")


# ----------------------------- Maintenance --------------------------------
@api.get("/maintenance", response_model=List[Maintenance])
async def list_maintenance(user: UserPublic = Depends(get_current_user)):
    docs = await db.maintenance.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Maintenance(**redact_money_for_crew(d, user.role.value)) for d in docs]


@api.post("/maintenance", response_model=Maintenance, status_code=201)
async def create_maintenance(body: MaintenanceCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    eq = await db.equipment.find_one({"id": body.equipment_id}, {"_id": 0})
    name = eq["name"] if eq else ""
    m = Maintenance(**body.model_dump(), equipment_name=name)
    await db.maintenance.insert_one(m.model_dump())
    return m


@api.put("/maintenance/{m_id}", response_model=Maintenance)
async def update_maintenance(m_id: str, body: MaintenanceCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.maintenance.find_one({"id": m_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    upd = body.model_dump()
    await db.maintenance.update_one({"id": m_id}, {"$set": upd})
    new_doc = await db.maintenance.find_one({"id": m_id}, {"_id": 0})
    return Maintenance(**new_doc)


@api.delete("/maintenance/{m_id}")
async def delete_maintenance(m_id: str, _: UserPublic = Depends(require_role(Role.foreman))):
    await db.maintenance.delete_one({"id": m_id})
    return {"ok": True}


# ----------------------------- Shop tasks -----------------------------------
@api.get("/shop-tasks", response_model=List[ShopTask])
async def list_shop_tasks(_: UserPublic = Depends(get_current_user)):
    docs = await db.shop_tasks.find({}, {"_id": 0}).sort("created_at", -1).to_list(2000)
    return [ShopTask(**d) for d in docs]


@api.post("/shop-tasks", response_model=ShopTask, status_code=201)
async def create_shop_task(body: ShopTaskCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    if body.status not in SHOP_TASK_STATUSES:
        raise HTTPException(400, "Invalid status")
    if body.task_type not in SHOP_TASK_TYPES:
        raise HTTPException(400, "Invalid task_type")
    task = ShopTask(**body.model_dump(), created_by=user.name)
    if task.status == "done":
        task.completed_by = user.name
        task.completed_at = now_utc()
    await db.shop_tasks.insert_one(task.model_dump())
    return task


@api.put("/shop-tasks/{task_id}", response_model=ShopTask)
async def update_shop_task(task_id: str, body: ShopTaskCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.shop_tasks.find_one({"id": task_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Task not found")
    if body.status not in SHOP_TASK_STATUSES:
        raise HTTPException(400, "Invalid status")
    if body.task_type not in SHOP_TASK_TYPES:
        raise HTTPException(400, "Invalid task_type")
    upd = body.model_dump()
    # status transitions go through PATCH /shop-tasks/{id}/status so completion
    # linkage (repair -> available, completed_by/at) always runs — don't let a
    # plain field edit silently change status here.
    upd["status"] = doc["status"]
    await db.shop_tasks.update_one({"id": task_id}, {"$set": upd})
    new_doc = await db.shop_tasks.find_one({"id": task_id}, {"_id": 0})
    return ShopTask(**new_doc)


@api.patch("/shop-tasks/{task_id}/status", response_model=ShopTask)
async def update_shop_task_status(
    task_id: str, body: ShopTaskStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        doc = await db.shop_tasks.find_one({"id": task_id}, {"_id": 0})
        if not doc:
            raise HTTPException(404, "Task not found")
        if body.status not in SHOP_TASK_STATUSES:
            raise HTTPException(400, "Invalid status")
        was_done = doc["status"] == "done"
        will_be_done = body.status == "done"
        upd: dict = {"status": body.status}
        if will_be_done and not was_done:
            upd["completed_by"] = user.name
            upd["completed_at"] = now_utc()
            # Repair complete -> the units it took out of service go back to available.
            # Clamp to what's actually sitting in maintenance so a task whose qty
            # doesn't line up with real inventory (e.g. a manually-entered task)
            # can never drive the bucket negative.
            if doc.get("task_type") == "repair" and doc.get("related_equipment_id") and doc.get("qty", 0) > 0:
                eq = await db.equipment.find_one({"id": doc["related_equipment_id"]}, {"_id": 0})
                movable = min(doc["qty"], eq.get("in_maintenance", 0)) if eq else 0
                if movable > 0:
                    await apply_ledger_entry(
                        doc["related_equipment_id"], movable, "in_maintenance", "available", "maintenance_resolved",
                        note=f"Shop task: {doc.get('title', '')}", created_by=user.name,
                    )
        elif was_done and not will_be_done:
            upd["completed_by"] = ""
            upd["completed_at"] = None
        await db.shop_tasks.update_one({"id": task_id}, {"$set": upd})
        new_doc = await db.shop_tasks.find_one({"id": task_id}, {"_id": 0})
        return ShopTask(**new_doc)

    return await idempotent(idempotency_key, "update_shop_task_status", _run)


@api.delete("/shop-tasks/{task_id}")
async def delete_shop_task(task_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    res = await db.shop_tasks.delete_one({"id": task_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Task not found")
    return {"ok": True}


# ----------------------------- Contacts / legacy Vendors ------------------
def _contact_key(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def _phone_key(value: str) -> str:
    return "".join(character for character in (value or "") if character.isdigit())


def _contact_current_rental(contact: dict, rentals: list[dict]) -> Optional[dict]:
    company = _contact_key(contact.get("company") or contact.get("name", ""))
    person = _contact_key(contact.get("contact") or contact.get("contact_name", ""))
    email = _contact_key(contact.get("email", ""))
    phone = _phone_key(contact.get("phone", ""))
    for rental in rentals:
        if email and email == _contact_key(rental.get("customer_email", "")):
            return rental
        if phone and phone == _phone_key(rental.get("customer_phone", "")):
            return rental
        if company and company in {
            _contact_key(rental.get("customer_name", "")),
            _contact_key(rental.get("job_site", "")),
        }:
            return rental
        if person and person == _contact_key(rental.get("primary_contact", "")):
            return rental
    return None


def _contact_from_doc(doc: dict, rentals: list[dict]) -> Contact:
    is_homeowner = bool(doc.get("is_homeowner", False))
    follows_current_job = bool(doc.get("follows_current_job", False)) or is_homeowner
    rental = _contact_current_rental(doc, rentals) if follows_current_job else None
    stored_company = doc.get("company") or doc.get("name", "")
    company = rental.get("job_site", "") if is_homeowner and rental and rental.get("job_site") else stored_company
    job_address = ""
    if rental:
        job_address = rental.get("job_address") or rental.get("job_site", "")
    return Contact(
        id=doc["id"],
        company=company,
        contact=doc.get("contact") or doc.get("contact_name", ""),
        phone=doc.get("phone", ""),
        email=doc.get("email", ""),
        business_address=doc.get("business_address") or doc.get("address", ""),
        is_homeowner=is_homeowner,
        follows_current_job=follows_current_job,
        current_job_site=rental.get("job_site", "") if rental else "",
        current_job_address=job_address,
        current_job_lat=rental.get("lat") if rental else None,
        current_job_lng=rental.get("lng") if rental else None,
        current_rental_id=rental.get("id") if rental else None,
        notes=doc.get("notes", ""),
        created_at=doc.get("created_at", now_utc()),
    )


async def sync_contact_from_rental(rental: Rental | dict, *, session=None) -> None:
    """Keep the directory linked to the newest customer job without
    replacing a company's permanent business address."""
    doc = rental.model_dump() if isinstance(rental, Rental) else rental
    is_homeowner = doc.get("customer_type") == "homeowner"
    company = doc.get("job_site", "") if is_homeowner else doc.get("customer_name", "")
    if not company:
        return
    selectors = [{"company": company}, {"name": company}]
    if doc.get("customer_email"):
        selectors.append({"email": doc["customer_email"]})
    if doc.get("customer_phone"):
        selectors.append({"phone": doc["customer_phone"]})
    existing = await db.vendors.find_one({"$or": selectors}, {"_id": 0}, session=session)
    update = {
        "company": company,
        "name": company,
        "is_homeowner": is_homeowner,
        "follows_current_job": True,
    }
    if doc.get("primary_contact"):
        update.update({"contact": doc["primary_contact"], "contact_name": doc["primary_contact"]})
    if doc.get("customer_phone"):
        update["phone"] = doc["customer_phone"]
    if doc.get("customer_email"):
        update["email"] = doc["customer_email"]
    if is_homeowner and doc.get("job_address"):
        update.update({"business_address": doc["job_address"], "address": doc["job_address"]})
    if existing:
        await db.vendors.update_one({"id": existing["id"]}, {"$set": update}, session=session)
    else:
        contact = {
            "id": gen_id(),
            **update,
            "contact": update.get("contact", ""),
            "contact_name": update.get("contact_name", ""),
            "phone": update.get("phone", ""),
            "email": update.get("email", ""),
            "business_address": update.get("business_address", ""),
            "address": update.get("address", ""),
            "notes": "",
            "categories": [],
            "freight_terms": "",
            "truck_capacity": "",
            "lead_time_days": 0,
            "created_at": now_utc(),
        }
        await db.vendors.insert_one(contact, session=session)


async def sync_contacts_from_existing_rentals() -> int:
    rentals = await db.rentals.find({}, {"_id": 0}).sort("created_at", 1).to_list(5000)
    for rental in rentals:
        await sync_contact_from_rental(rental)
    return len(rentals)


@api.get("/contacts", response_model=List[Contact])
async def list_contacts(_: UserPublic = Depends(get_current_user)):
    docs = await db.vendors.find({}, {"_id": 0}).to_list(2000)
    rentals = await db.rentals.find(
        {"status": {"$in": list(RentalStatus.OPEN)}}, {"_id": 0}
    ).sort("start_date", -1).to_list(2000)
    return sorted((_contact_from_doc(doc, rentals) for doc in docs), key=lambda contact: contact.company.lower())


@api.post("/contacts", response_model=Contact, status_code=201)
async def create_contact(body: ContactCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    if not body.company.strip():
        raise HTTPException(400, "Company or job-site name is required")
    contact = Contact(**body.model_dump())
    stored = {
        **contact.model_dump(exclude={"current_job_site", "current_job_address", "current_job_lat", "current_job_lng", "current_rental_id"}),
        "name": contact.company,
        "contact_name": contact.contact,
        "address": contact.business_address,
        "categories": [],
        "freight_terms": "",
        "truck_capacity": "",
        "lead_time_days": 0,
    }
    await db.vendors.insert_one(stored)
    return contact


@api.put("/contacts/{contact_id}", response_model=Contact)
async def update_contact(contact_id: str, body: ContactCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    if not body.company.strip():
        raise HTTPException(400, "Company or job-site name is required")
    update = {
        **body.model_dump(),
        "name": body.company,
        "contact_name": body.contact,
        "address": body.business_address,
    }
    result = await db.vendors.update_one({"id": contact_id}, {"$set": update})
    if result.matched_count == 0:
        raise HTTPException(404, "Contact not found")
    doc = await db.vendors.find_one({"id": contact_id}, {"_id": 0})
    rentals = await db.rentals.find(
        {"status": {"$in": list(RentalStatus.OPEN)}}, {"_id": 0}
    ).sort("start_date", -1).to_list(2000)
    return _contact_from_doc(doc, rentals)


@api.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    result = await db.vendors.delete_one({"id": contact_id})
    if result.deleted_count == 0:
        raise HTTPException(404, "Contact not found")
    return {"ok": True}


# Legacy endpoints remain available for older mobile clients during the
# Vendors -> Contacts rename. They use the same records and are not a second
# source of truth.
@api.get("/vendors", response_model=List[Vendor])
async def list_vendors(_: UserPublic = Depends(get_current_user)):
    docs = await db.vendors.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    return [Vendor(**d) for d in docs]


@api.post("/vendors", response_model=Vendor, status_code=201)
async def create_vendor(body: VendorCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    v = Vendor(**body.model_dump())
    await db.vendors.insert_one(v.model_dump())
    return v


@api.put("/vendors/{v_id}", response_model=Vendor)
async def update_vendor(v_id: str, body: VendorCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    upd = body.model_dump()
    await db.vendors.update_one({"id": v_id}, {"$set": upd})
    doc = await db.vendors.find_one({"id": v_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    return Vendor(**doc)


@api.delete("/vendors/{v_id}")
async def delete_vendor(v_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    await db.vendors.delete_one({"id": v_id})
    return {"ok": True}


# ----------------------------- Site Admin ---------------------------------
@api.get("/site", response_model=SiteSettings)
async def get_site(_: UserPublic = Depends(get_current_user)):
    doc = await db.site.find_one({"_id": "settings"})
    if not doc:
        return SiteSettings()
    doc.pop("_id", None)
    return SiteSettings(**doc)


@api.put("/site", response_model=SiteSettings)
async def update_site(body: SiteSettings, _: UserPublic = Depends(require_role(Role.admin))):
    await db.site.update_one({"_id": "settings"}, {"$set": body.model_dump()}, upsert=True)
    return body


# ----------------------------- Bracing Engine -----------------------------
@api.post("/bracing/calculate", response_model=BracingResult)
async def bracing_calc(body: BracingRequest, _: UserPublic = Depends(get_current_user)):
    runs_out: List[RunResult] = []
    counts: dict[int, int] = {}
    engineer = False
    for r in body.runs:
        bl = brace_length_for_height(r.wall_height)
        braces = math.ceil(max(r.linear_ft, 0) / 4.0) if r.linear_ft > 0 else 0
        sb = max(r.corners, 0)
        eng = bl is None
        if eng:
            engineer = True
        else:
            counts[bl] = counts.get(bl, 0) + braces
        runs_out.append(RunResult(
            name=r.name, corners=r.corners, linear_ft=r.linear_ft,
            wall_height=r.wall_height, strongbacks=sb,
            braces=braces, brace_length=bl, engineer_required=eng,
        ))
    total_sb = sum(r.strongbacks for r in runs_out)
    total_braces = sum(r.braces for r in runs_out if not r.engineer_required)
    return BracingResult(
        runs=runs_out, total_strongbacks=total_sb,
        total_braces=total_braces, braces_by_length=counts,
        engineer_required=engineer,
    )


# ----------------------------- Dashboard ----------------------------------
@api.get("/dashboard/items", response_model=List[DashboardItem])
async def list_dashboard_items(_: UserPublic = Depends(get_current_user)):
    docs = await db.dashboard_items.find(
        {"status": "open"}, {"_id": 0},
    ).sort([("due_date", 1), ("created_at", -1)]).to_list(500)
    return [DashboardItem(**doc) for doc in docs]


@api.post("/dashboard/items", response_model=DashboardItem, status_code=201)
async def create_dashboard_item(
    body: DashboardItemCreate,
    user: UserPublic = Depends(require_role(Role.foreman)),
):
    if body.kind not in DASHBOARD_ITEM_KINDS:
        raise HTTPException(400, "Invalid dashboard item kind")
    if not body.title.strip():
        raise HTTPException(400, "Title is required")
    item = DashboardItem(
        **body.model_dump(),
        title=body.title.strip(),
        details=body.details.strip(),
        created_by=user.name,
    )
    await db.dashboard_items.insert_one(item.model_dump())
    return item


@api.patch("/dashboard/items/{item_id}/status", response_model=DashboardItem)
async def update_dashboard_item_status(
    item_id: str,
    body: DashboardItemStatusUpdate,
    user: UserPublic = Depends(require_role(Role.foreman)),
):
    if body.status not in DASHBOARD_ITEM_STATUSES:
        raise HTTPException(400, "Invalid dashboard item status")
    doc = await db.dashboard_items.find_one({"id": item_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Dashboard item not found")
    update: dict[str, Any] = {"status": body.status}
    if body.status == "done":
        update.update({"completed_by": user.name, "completed_at": now_utc()})
    else:
        update.update({"completed_by": "", "completed_at": None})
    await db.dashboard_items.update_one({"id": item_id}, {"$set": update})
    updated = await db.dashboard_items.find_one({"id": item_id}, {"_id": 0})
    return DashboardItem(**updated)


# ----------------------------- Whiteboard --------------------------------
WHITEBOARD_EDIT_WINDOW = timedelta(minutes=15)
WHITEBOARD_ATTACHMENT_LIMIT = 8 * 1024 * 1024
WHITEBOARD_NATHAN = {
    "id": "nathan2", "handle": "Nathan", "normalized_handle": "nathan",
    "display_name": "Nathan", "entity_type": "agent", "label": "AI Agent",
}
whiteboard_background_tasks: set[asyncio.Task] = set()


async def whiteboard_audit(action: str, actor: UserPublic | dict, message_id: str, details: Optional[dict] = None) -> None:
    await db.whiteboard_audit.insert_one({
        "id": gen_id(), "action": action, "message_id": message_id,
        "actor_id": str(actor.get("id") if isinstance(actor, dict) else actor.id),
        "actor_name": str(actor.get("name") if isinstance(actor, dict) else actor.name),
        "timestamp": now_utc(), "details": details or {},
    })


async def resolve_whiteboard_mentions(body: str) -> list[dict]:
    handles = mentioned_handles(body)
    if not handles:
        return []
    users = await db.users.find({}, {"_id": 0, "id": 1, "name": 1, "email": 1}).to_list(1000)
    directory: dict[str, dict] = {
        "nathan": WHITEBOARD_NATHAN,
        "everyone": {
            "id": "everyone", "handle": "everyone", "normalized_handle": "everyone",
            "display_name": "Everyone", "entity_type": "group", "label": "Team",
        },
    }
    for user in users:
        candidates = [normalize_handle(user.get("name", "")), normalize_handle(user.get("email", "").split("@", 1)[0])]
        handle = next((candidate for candidate in candidates if candidate), "")
        for candidate in candidates:
            if candidate and candidate not in directory:
                directory[candidate] = {
                    "id": user["id"], "handle": handle, "normalized_handle": candidate,
                    "display_name": user.get("name") or user.get("email"),
                    "entity_type": "user", "label": "Employee",
                }
    return [directory[handle] for handle in handles if handle in directory]


async def hydrate_whiteboard_messages(docs: list[dict]) -> list[dict]:
    if not docs:
        return []
    ids = [doc["id"] for doc in docs]
    mentions = await db.whiteboard_mentions.find({"message_id": {"$in": ids}}, {"_id": 0}).to_list(5000)
    attachments = await db.whiteboard_attachments.find({"message_id": {"$in": ids}}, {"_id": 0}).to_list(5000)
    reply_counts: dict[str, int] = {}
    async for row in db.whiteboard_messages.aggregate([
        {"$match": {"parent_id": {"$in": ids}}}, {"$group": {"_id": "$parent_id", "count": {"$sum": 1}}},
    ]):
        reply_counts[str(row["_id"])] = int(row["count"])
    mentions_by: dict[str, list] = {}
    attachments_by: dict[str, list] = {}
    for mention in mentions:
        mentions_by.setdefault(mention["message_id"], []).append(mention)
    for attachment in attachments:
        attachments_by.setdefault(attachment["message_id"], []).append(attachment)
    result = []
    for source in docs:
        doc = dict(source)
        doc.pop("_id", None)
        if doc.get("is_deleted"):
            doc["body"] = "Message deleted"
        doc["mentions"] = mentions_by.get(doc["id"], [])
        doc["attachments"] = attachments_by.get(doc["id"], [])
        doc["reply_count"] = reply_counts.get(doc["id"], 0)
        result.append(doc)
    return result


async def whiteboard_operations_context(message: dict) -> dict:
    kind, entity_id = message.get("context_type"), message.get("context_id")
    collections = {
        "rental": db.rentals, "dispatch": db.dispatches,
        "booking": db.bookings, "shop_task": db.shop_tasks,
    }
    if kind in collections and entity_id:
        doc = await collections[kind].find_one({"id": entity_id}, {"_id": 0})
        if doc:
            allowed = {
                "id", "customer_name", "job_site", "status", "direction", "scheduled_date",
                "start_date", "end_date", "due_date", "title", "description", "assignee",
                "priority", "notes", "lines", "items",
            }
            return {"context_type": kind, "entity": {key: value for key, value in doc.items() if key in allowed}}
    return {
        "scope": "dashboard_summary",
        "active_rentals": await db.rentals.count_documents({"status": {"$in": list(RentalStatus.OPEN)}}),
        "live_dispatches": await db.dispatches.count_documents({"status": {"$nin": list(DispatchStatus.TERMINAL)}}),
        "open_shop_tasks": await db.shop_tasks.count_documents({"status": {"$ne": "done"}}),
    }


async def post_nathan_response(source_message_id: str) -> None:
    source = await db.whiteboard_messages.find_one({"id": source_message_id}, {"_id": 0})
    if not source or source.get("is_deleted"):
        return
    await db.whiteboard_messages.update_one({"id": source_message_id}, {"$set": {"invocation_status": "responding"}})
    await whiteboard_hub.broadcast({"type": "nathan.status", "message_id": source_message_id, "status": "responding"})
    try:
        history = await db.whiteboard_messages.find(
            {"thread_id": source["thread_id"], "created_at": {"$lte": source["created_at"]}}, {"_id": 0},
        ).sort("created_at", -1).limit(12).to_list(12)
        history.reverse()
        prompt = build_nathan_prompt(
            message=source["body"], author=source["author_name"], timestamp=source["created_at"].isoformat(),
            thread_history=history, operations_context=await whiteboard_operations_context(source),
        )
        result = await nathan_gateway.invoke(title=f"MobileOps: {source['author_name']}", prompt=prompt)
        created_at = now_utc()
        response_doc = {
            "id": gen_id(), "thread_id": source["thread_id"], "parent_id": source.get("parent_id") or source["id"],
            "body": result.text, "body_original": result.text,
            "author_type": "agent", "author_id": "nathan2", "author_name": "Nathan", "author_avatar": "N2",
            "agent_label": "AI Agent", "created_at": created_at, "edited_at": None,
            "is_deleted": False, "deleted_at": None, "deleted_by": None,
            "pinned": False, "pinned_by": None, "pinned_at": None,
            "invocation_status": result.status, "context_type": source.get("context_type"), "context_id": source.get("context_id"),
        }
        await db.whiteboard_messages.insert_one(response_doc)
        await db.whiteboard_messages.update_one({"id": source_message_id}, {"$set": {"invocation_status": "complete", "nathan_response_id": response_doc["id"]}})
        await whiteboard_audit("nathan_response", {"id": "nathan2", "name": "Nathan"}, response_doc["id"], {"source_message_id": source_message_id, "status": result.status})
        hydrated = (await hydrate_whiteboard_messages([response_doc]))[0]
        await whiteboard_hub.broadcast({"type": "message.created", "message": hydrated})
        await whiteboard_hub.broadcast({"type": "nathan.status", "message_id": source_message_id, "status": "complete"})
    except Exception as exc:
        logger.warning("Nathan whiteboard invocation failed: %s", type(exc).__name__)
        await db.whiteboard_messages.update_one({"id": source_message_id}, {"$set": {"invocation_status": "failed", "invocation_error": "Nathan could not respond. Try mentioning him again."}})
        await whiteboard_audit("nathan_failed", {"id": "nathan2", "name": "Nathan"}, source_message_id, {"error_type": type(exc).__name__})
        await whiteboard_hub.broadcast({"type": "nathan.status", "message_id": source_message_id, "status": "failed"})


@api.get("/whiteboard/mentionables")
async def list_whiteboard_mentionables(_: UserPublic = Depends(get_current_user)):
    users = await db.users.find({}, {"_id": 0, "id": 1, "name": 1, "email": 1}).sort("name", 1).to_list(1000)
    entries = [WHITEBOARD_NATHAN, {"id": "everyone", "handle": "everyone", "display_name": "Everyone", "entity_type": "group", "label": "Team"}]
    for user in users:
        entries.append({
            "id": user["id"], "handle": normalize_handle(user.get("name") or user["email"].split("@", 1)[0]),
            "display_name": user.get("name") or user["email"], "entity_type": "user", "label": "Employee",
        })
    return entries


@api.get("/whiteboard/messages")
async def list_whiteboard_messages(
    thread_id: str = "dashboard", parent_id: Optional[str] = None, limit: int = 80,
    _: UserPublic = Depends(get_current_user),
):
    query: dict[str, Any] = {"thread_id": thread_id}
    if parent_id:
        query["$or"] = [{"id": parent_id}, {"parent_id": parent_id}]
    docs = await db.whiteboard_messages.find(query, {"_id": 0}).sort([("pinned", -1), ("created_at", -1)]).limit(min(max(limit, 1), 200)).to_list(200)
    docs.reverse()
    return await hydrate_whiteboard_messages(docs)


@api.post("/whiteboard/messages", status_code=201)
async def create_whiteboard_message(body: WhiteboardMessageCreate, user: UserPublic = Depends(get_current_user)):
    text = body.body.strip()
    if not text:
        raise HTTPException(400, "Message is required")
    if body.parent_id:
        parent = await db.whiteboard_messages.find_one({"id": body.parent_id, "thread_id": body.thread_id}, {"_id": 0, "id": 1})
        if not parent:
            raise HTTPException(404, "Parent message not found")
    created_at = now_utc()
    mentions = await resolve_whiteboard_mentions(text)
    invokes_nathan = any(item["entity_type"] == "agent" and item["id"] == "nathan2" for item in mentions)
    doc = {
        "id": gen_id(), "thread_id": body.thread_id, "parent_id": body.parent_id,
        "body": text, "body_original": text, "author_type": "user", "author_id": user.id,
        "author_name": user.name, "author_avatar": "".join(part[:1] for part in user.name.split()[:2]).upper() or "U",
        "agent_label": None, "created_at": created_at, "edited_at": None, "edit_history": [],
        "is_deleted": False, "deleted_at": None, "deleted_by": None,
        "pinned": False, "pinned_by": None, "pinned_at": None,
        "invocation_status": "pending" if invokes_nathan else None,
        "context_type": body.context_type, "context_id": body.context_id,
    }
    await db.whiteboard_messages.insert_one(doc)
    if mentions:
        await db.whiteboard_mentions.insert_many([{
            "id": gen_id(), "message_id": doc["id"], "thread_id": doc["thread_id"],
            "entity_type": item["entity_type"], "entity_id": item["id"], "handle": item["handle"],
            "display_name": item["display_name"], "created_at": created_at,
        } for item in mentions])
    await whiteboard_audit("message_created", user, doc["id"], {"mentions": [item["id"] for item in mentions], "nathan_invoked": invokes_nathan})
    hydrated = (await hydrate_whiteboard_messages([doc]))[0]
    await whiteboard_hub.broadcast({"type": "message.created", "message": hydrated})
    if invokes_nathan:
        task = asyncio.create_task(post_nathan_response(doc["id"]))
        whiteboard_background_tasks.add(task)
        task.add_done_callback(whiteboard_background_tasks.discard)
    return hydrated


@api.patch("/whiteboard/messages/{message_id}")
async def edit_whiteboard_message(message_id: str, body: WhiteboardMessageEdit, user: UserPublic = Depends(get_current_user)):
    doc = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    if not doc or doc.get("is_deleted"):
        raise HTTPException(404, "Message not found")
    is_admin = user.role == Role.admin
    if doc.get("author_type") != "user" or (doc.get("author_id") != user.id and not is_admin):
        raise HTTPException(403, "You can only edit your own messages")
    if not is_admin and now_utc() - doc["created_at"] > WHITEBOARD_EDIT_WINDOW:
        raise HTTPException(403, "The edit window has closed")
    text = body.body.strip()
    if not text:
        raise HTTPException(400, "Message is required")
    mentions = await resolve_whiteboard_mentions(text)
    invokes_nathan = not doc.get("invocation_status") and any(item["entity_type"] == "agent" and item["id"] == "nathan2" for item in mentions)
    message_update: dict[str, Any] = {"body": text, "edited_at": now_utc()}
    if invokes_nathan:
        message_update["invocation_status"] = "pending"
    await db.whiteboard_messages.update_one({"id": message_id}, {"$set": message_update, "$push": {"edit_history": {"body": doc["body"], "edited_at": now_utc(), "edited_by": user.id}}})
    await db.whiteboard_mentions.delete_many({"message_id": message_id})
    if mentions:
        await db.whiteboard_mentions.insert_many([{"id": gen_id(), "message_id": message_id, "thread_id": doc["thread_id"], "entity_type": item["entity_type"], "entity_id": item["id"], "handle": item["handle"], "display_name": item["display_name"], "created_at": now_utc()} for item in mentions])
    await whiteboard_audit("message_edited", user, message_id, {"mentions": [item["id"] for item in mentions], "nathan_invoked": invokes_nathan})
    updated = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    hydrated = (await hydrate_whiteboard_messages([updated]))[0]
    await whiteboard_hub.broadcast({"type": "message.updated", "message": hydrated})
    if invokes_nathan:
        task = asyncio.create_task(post_nathan_response(message_id))
        whiteboard_background_tasks.add(task)
        task.add_done_callback(whiteboard_background_tasks.discard)
    return hydrated


@api.delete("/whiteboard/messages/{message_id}")
async def delete_whiteboard_message(message_id: str, user: UserPublic = Depends(get_current_user)):
    doc = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    if not doc or doc.get("is_deleted"):
        raise HTTPException(404, "Message not found")
    is_admin = user.role == Role.admin
    if not is_admin and (doc.get("author_type") != "user" or doc.get("author_id") != user.id):
        raise HTTPException(403, "You can only delete your own messages")
    if not is_admin and now_utc() - doc["created_at"] > WHITEBOARD_EDIT_WINDOW:
        raise HTTPException(403, "The delete window has closed")
    updated_at = now_utc()
    await db.whiteboard_messages.update_one({"id": message_id}, {"$set": {"is_deleted": True, "deleted_at": updated_at, "deleted_by": user.id, "pinned": False}})
    await whiteboard_audit("message_deleted", user, message_id)
    updated = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    hydrated = (await hydrate_whiteboard_messages([updated]))[0]
    await whiteboard_hub.broadcast({"type": "message.updated", "message": hydrated})
    return hydrated


@api.patch("/whiteboard/messages/{message_id}/pin")
async def pin_whiteboard_message(message_id: str, pinned: bool = Body(embed=True), user: UserPublic = Depends(require_role(Role.admin))):
    doc = await db.whiteboard_messages.find_one({"id": message_id, "is_deleted": False}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Message not found")
    update = {"pinned": pinned, "pinned_by": user.id if pinned else None, "pinned_at": now_utc() if pinned else None}
    await db.whiteboard_messages.update_one({"id": message_id}, {"$set": update})
    await whiteboard_audit("message_pinned" if pinned else "message_unpinned", user, message_id)
    updated = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    hydrated = (await hydrate_whiteboard_messages([updated]))[0]
    await whiteboard_hub.broadcast({"type": "message.updated", "message": hydrated})
    return hydrated


@api.post("/whiteboard/messages/{message_id}/attachments", status_code=201)
async def add_whiteboard_attachments(message_id: str, files: List[UploadFile] = File(...), user: UserPublic = Depends(get_current_user)):
    message = await db.whiteboard_messages.find_one({"id": message_id, "is_deleted": False}, {"_id": 0})
    if not message:
        raise HTTPException(404, "Message not found")
    created = []
    for upload in files[:5]:
        data = await upload.read(WHITEBOARD_ATTACHMENT_LIMIT + 1)
        if len(data) > WHITEBOARD_ATTACHMENT_LIMIT:
            raise HTTPException(413, f"{upload.filename or 'Attachment'} exceeds 8 MB")
        attachment_id = gen_id()
        safe_name = Path(upload.filename or "attachment").name[:180]
        meta = {"id": attachment_id, "message_id": message_id, "filename": safe_name, "content_type": upload.content_type or "application/octet-stream", "size": len(data), "uploaded_by": user.id, "created_at": now_utc()}
        await db.whiteboard_attachment_blobs.insert_one({"id": attachment_id, "data": data})
        # Motor adds `_id` to the dict passed to insert_one; insert a copy so
        # the API metadata response remains JSON-safe.
        await db.whiteboard_attachments.insert_one(dict(meta))
        created.append(meta)
    await whiteboard_audit("attachments_added", user, message_id, {"attachment_ids": [item["id"] for item in created]})
    updated = await db.whiteboard_messages.find_one({"id": message_id}, {"_id": 0})
    hydrated = (await hydrate_whiteboard_messages([updated]))[0]
    await whiteboard_hub.broadcast({"type": "message.updated", "message": hydrated})
    return created


@api.get("/whiteboard/attachments/{attachment_id}")
async def download_whiteboard_attachment(attachment_id: str, _: UserPublic = Depends(get_current_user)):
    meta = await db.whiteboard_attachments.find_one({"id": attachment_id}, {"_id": 0})
    blob = await db.whiteboard_attachment_blobs.find_one({"id": attachment_id}, {"_id": 0})
    if not meta or not blob:
        raise HTTPException(404, "Attachment not found")
    return Response(content=bytes(blob["data"]), media_type=meta["content_type"], headers={"Content-Disposition": f'attachment; filename="{meta["filename"].replace(chr(34), "")}"'})


@api.post("/whiteboard/read")
async def mark_whiteboard_read(body: WhiteboardReadUpdate, user: UserPublic = Depends(get_current_user)):
    read_at = now_utc()
    await db.whiteboard_read_states.update_one({"user_id": user.id, "thread_id": body.thread_id}, {"$set": {"last_read_at": read_at}}, upsert=True)
    return {"thread_id": body.thread_id, "last_read_at": read_at}


@api.get("/whiteboard/unread")
async def whiteboard_unread(thread_id: str = "dashboard", user: UserPublic = Depends(get_current_user)):
    state = await db.whiteboard_read_states.find_one({"user_id": user.id, "thread_id": thread_id})
    query: dict[str, Any] = {"thread_id": thread_id, "author_id": {"$ne": user.id}}
    if state and state.get("last_read_at"):
        query["created_at"] = {"$gt": state["last_read_at"]}
    return {"count": await db.whiteboard_messages.count_documents(query)}


@api.get("/whiteboard/audit")
async def list_whiteboard_audit(limit: int = 100, _: UserPublic = Depends(require_role(Role.admin))):
    return await db.whiteboard_audit.find({}, {"_id": 0}).sort("timestamp", -1).limit(min(max(limit, 1), 500)).to_list(500)


@api.websocket("/whiteboard/ws")
async def whiteboard_websocket(socket: WebSocket):
    await socket.accept()
    try:
        auth = await asyncio.wait_for(socket.receive_json(), timeout=10)
        if auth.get("type") != "authenticate" or not auth.get("token"):
            await socket.close(code=4401)
            return
        user = await user_from_access_token(str(auth["token"]))
        await whiteboard_hub.add(socket)
        await socket.send_json({"type": "ready", "user_id": user.id})
        while True:
            event = await socket.receive_json()
            if event.get("type") == "ping":
                await socket.send_json({"type": "pong"})
    except (WebSocketDisconnect, asyncio.TimeoutError, HTTPException):
        pass
    finally:
        await whiteboard_hub.remove(socket)


@api.get("/dashboard/stats")
async def dashboard_stats(_: UserPublic = Depends(get_current_user)):
    """Operational KPIs only — no dollar figures. MobileOps tracks equipment
    accountability, not rental accounting."""
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(5000)
    total_qty = sum(e.get("quantity", 0) for e in equipment)
    total_avail = sum(e.get("available", 0) for e in equipment)
    total_reserved = sum(e.get("reserved", 0) for e in equipment)
    total_on_rental = sum(e.get("on_rental", 0) for e in equipment)
    total_pending_inspection = sum(e.get("pending_inspection", 0) for e in equipment)

    active_rentals = await db.rentals.count_documents({"status": {"$in": list(RentalStatus.OPEN)}})
    open_maintenance = await db.maintenance.count_documents({"status": {"$in": ["open", "in_progress"]}})
    open_shop_tasks = await db.shop_tasks.count_documents({"status": {"$ne": "done"}})
    contacts_count = await db.vendors.count_documents({})

    today = now_utc().date()
    returning_today = 0
    bookings_today = await db.bookings.find({"status": {"$ne": BookingStatus.CANCELLED}}, {"_id": 0}).to_list(1000)
    for b in bookings_today:
        ed = b.get("end_date")
        if isinstance(ed, str):
            try:
                ed = datetime.fromisoformat(ed.replace("Z", "+00:00"))
            except Exception:
                ed = None
        if isinstance(ed, datetime) and ed.date() == today:
            returning_today += sum(item.get("qty", 0) for item in b.get("items", []))

    shortages_today = await dashboard_shortages(days=1, _=_)
    shortage_count = len(shortages_today["rows"])

    # recent activity (last 8 rentals + maintenance + shop tasks)
    recent_r = await db.rentals.find({}, {"_id": 0}).sort("created_at", -1).to_list(5)
    recent_m = await db.maintenance.find({}, {"_id": 0}).sort("created_at", -1).to_list(5)
    recent_t = await db.shop_tasks.find({}, {"_id": 0}).sort("created_at", -1).to_list(5)
    activity = []
    for r in recent_r:
        ts = r.get("created_at")
        activity.append({"type": "rental", "title": f"Rental — {r['customer_name']}", "ts": ts.isoformat() if isinstance(ts, datetime) else str(ts)})
    for m in recent_m:
        ts = m.get("created_at")
        activity.append({"type": "maintenance", "title": f"Service — {m.get('equipment_name','')}", "ts": ts.isoformat() if isinstance(ts, datetime) else str(ts)})
    for t in recent_t:
        ts = t.get("created_at")
        activity.append({"type": "shop_task", "title": t.get("title", ""), "ts": ts.isoformat() if isinstance(ts, datetime) else str(ts)})
    activity.sort(key=lambda x: x["ts"], reverse=True)

    return {
        "total_quantity": total_qty,
        "total_available": total_avail,
        "total_reserved": total_reserved,
        "total_on_rental": total_on_rental,
        "total_pending_inspection": total_pending_inspection,
        "returning_today": returning_today,
        "active_rentals": active_rentals,
        "open_maintenance": open_maintenance,
        "open_shop_tasks": open_shop_tasks,
        "shortage_count": shortage_count,
        "contacts_count": contacts_count,
        "vendors_count": contacts_count,  # legacy dashboard clients
        "activity": activity[:8],
    }


# ----------------------------- Geocoding ----------------------------------
_geo_client: Optional[httpx.AsyncClient] = None


def geo_client() -> httpx.AsyncClient:
    global _geo_client
    if _geo_client is None:
        _geo_client = httpx.AsyncClient(
            base_url="https://nominatim.openstreetmap.org",
            headers={"User-Agent": "ConcreteForm/1.0 (contractor field app)"},
            timeout=10.0,
        )
    return _geo_client


@api.get("/geocode", response_model=List[GeocodeResult])
async def geocode_address(q: str, _: UserPublic = Depends(get_current_user)):
    """Free-form address → up to 5 candidate coordinates. Uses OpenStreetMap Nominatim."""
    query = (q or "").strip()
    if not query:
        return []
    try:
        resp = await geo_client().get("/search", params={"q": query, "format": "json", "limit": 5, "addressdetails": 0})
        if resp.status_code != 200:
            logger.warning("nominatim %s: %s", resp.status_code, resp.text[:200])
            return []
        results = resp.json() or []
    except Exception as e:
        logger.warning("geocode failed: %s", e)
        return []
    out: List[GeocodeResult] = []
    for r in results:
        try:
            out.append(GeocodeResult(
                lat=float(r["lat"]), lng=float(r["lon"]),
                display_name=str(r.get("display_name", "")),
            ))
        except Exception:
            continue
    return out

# ----------------------------- Startup seed -------------------------------
async def seed_bracing_catalog():
    """Reconcile the requested bracing/scaffolding catalog without inventing stock.

    Existing records keep all quantities, locations, rates, and bucket values.
    Missing catalog rows are placeholders at zero until their real counts are
    entered or imported from source paperwork.
    """
    added = 0
    renamed = 0
    for sku, name, category, legacy_names in BRACING_CATALOG:
        existing = await db.equipment.find_one({"sku": sku}, {"_id": 0})
        if existing:
            if existing.get("name") in legacy_names:
                await db.equipment.update_one(
                    {"id": existing["id"]},
                    {"$set": {"name": name, "category": category}},
                )
                renamed += 1
            continue

        equipment = Equipment(
            sku=sku,
            name=name,
            category=category,
            condition="good",
            location="Yard",
            quantity=0,
            available=0,
            tracking_type="bulk",
            notes="Catalog item — quantity not yet entered.",
        )
        await db.equipment.insert_one(equipment.model_dump())
        added += 1
    logger.info("Reconciled bracing catalog: %d added, %d legacy names updated", added, renamed)


async def seed_tool_inventory():
    """Idempotently add the serialized tools normalized from Rusty's workbook.

    Existing records are never overwritten. QR code is the primary match;
    serial number is used only for tools that do not have a QR tag yet. Every
    imported tool starts unassigned and available at Yard.
    """
    promoted = 0
    for qr_code in LEGACY_WORKBOOK_QR_CODES:
        existing = await db.equipment.find_one({
            "category": "tool",
            "qr_code": {"$in": [None, ""]},
            "serial_number": qr_code,
            "notes": {"$regex": "Imported from tool inventory workbook"},
        }, {"_id": 0})
        if not existing:
            continue
        if await db.equipment.find_one({"qr_code": qr_code, "id": {"$ne": existing["id"]}}):
            logger.warning("Cannot promote legacy tool QR %s because it is already assigned", qr_code)
            continue
        await db.equipment.update_one(
            {"id": existing["id"]},
            {"$set": {"qr_code": qr_code, "serial_number": "", "sku": f"QR-{qr_code}"}},
        )
        promoted += 1

    source = Path(__file__).with_name("tool_inventory_seed.csv")
    if not source.exists():
        logger.warning("Tool inventory seed missing: %s", source)
        return

    added = 0
    corrected = 0
    with source.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            qr_code = (row.get("qr_code") or "").strip() or None
            serial_number = (row.get("serial_number") or "").strip()
            source_row = (row.get("source_row") or "").strip()
            internal_sku = equipment_identifier_sku(qr_code, serial_number, f"TOOL-{source_row.zfill(3)}")
            selectors = [{"sku": internal_sku}]
            if qr_code:
                selectors.append({"qr_code": qr_code})
            elif serial_number:
                selectors.append({"serial_number": serial_number})
            existing = await db.equipment.find_one({"$or": selectors}, {"_id": 0})
            if existing:
                # Correct the two source-sheet location labels that were
                # briefly interpreted as checkout assignees during import.
                # Real later foreman/project assignments are never reset.
                legacy_assignment = (existing.get("checked_out_to") or "").strip()
                if (
                    legacy_assignment in {"Yard", "Huffman"}
                    and "Imported from tool inventory workbook" in existing.get("notes", "")
                ):
                    checked_out = existing.get("checked_out", 0)
                    if checked_out > 0:
                        await apply_ledger_entry(
                            existing["id"], checked_out, "checked_out", "available", "tool_import_correction",
                            location="Yard", note=f"Cleared legacy {legacy_assignment} assignment", created_by="System import",
                        )
                    await db.equipment.update_one(
                        {"id": existing["id"]},
                        {"$set": {"checked_out_to": "", "location": "Yard"}},
                    )
                    corrected += 1
                continue

            quantity = max(1, int(row.get("quantity") or 1))
            eq = Equipment(
                sku=internal_sku,
                qr_code=qr_code,
                model=(row.get("model") or "").strip(),
                serial_number=serial_number,
                name=(row.get("name") or "Tool").strip(),
                category="tool",
                condition="good",
                location="Yard",
                quantity=quantity,
                available=quantity,
                checked_out=0,
                checked_out_to="",
                tracking_type="serialized",
                notes=f"Imported from tool inventory workbook · source row {source_row}",
            )
            await db.equipment.insert_one(eq.model_dump())
            await db.ledger_entries.insert_one(LedgerEntry(
                equipment_id=eq.id,
                qty=quantity,
                from_bucket="owned",
                to_bucket="available",
                reason="received",
                location=eq.location,
                note="Tool inventory workbook import · unassigned at Yard",
                created_by="System import",
            ).model_dump())
            added += 1
    logger.info("Seeded %d serialized tools, promoted %d legacy QR tags, and corrected %d legacy assignments from workbook", added, promoted, corrected)


async def seed_dispatch_plans(filename: str, direction: str, label: str):
    """Import reminder-list plans without moving or reserving inventory.

    The source includes tentative dates, quantities, and brace sizes. Existing
    imported rows are never overwritten so later operator edits and status
    changes remain authoritative.
    """
    source = Path(__file__).with_name(filename)
    if not source.exists():
        logger.warning("%s plan seed missing: %s", label, source)
        return

    with source.open("r", encoding="utf-8") as handle:
        rows = json.load(handle)

    added = 0
    for row in rows:
        if await db.dispatches.find_one({"source_key": row["source_key"]}, {"_id": 1}):
            continue
        # A completed outbound delivery is no longer an outbound movement;
        # it is an active customer rental until an admin closes it into the
        # inbound pickup flow. Planning imports do not move inventory, but
        # they follow the same operator-facing lifecycle.
        plan_direction = (
            "inbound"
            if direction == "outbound" and row.get("status") == DispatchStatus.ACTIVE_RENTAL
            else direction
        )
        plan = Dispatch(
            **row,
            direction=plan_direction,
            planning_only=True,
            created_by="System import",
        )
        await db.dispatches.insert_one(plan.model_dump())
        added += 1
    logger.info("Seeded %d %s planning records", added, label)


async def promote_delivered_outbound_plans() -> int:
    """Move legacy delivered outbound reminders into Active Rentals.

    Older imports used ``completed`` or ``partially_delivered`` to describe
    the delivery itself. Those jobs still have equipment on site, so treating
    them as archived hides an open rental. This narrowly promotes only
    planning-only outbound records with a delivered status; future scheduled
    outbound work and real inventory-backed dispatches are untouched.
    """
    result = await db.dispatches.update_many(
        {
            "planning_only": True,
            "direction": "outbound",
            "status": {
                "$in": [
                    "completed",
                    "partially_delivered",
                    DispatchStatus.ACTIVE_RENTAL,
                ]
            },
        },
        {
            "$set": {
                "direction": "inbound",
                "status": DispatchStatus.ACTIVE_RENTAL,
                "rental_completed": False,
                "completed_at": None,
                "updated_at": now_utc(),
            }
        },
    )
    return result.modified_count


async def seed():
    existing = await db.users.find_one({"email": ADMIN_EMAIL})
    if not existing:
        await db.users.insert_one({
            "id": gen_id(), "email": ADMIN_EMAIL, "name": "Admin",
            "password_hash": hash_pwd(ADMIN_PASSWORD), "role": Role.admin.value,
            "failed_attempts": 0, "lock_until": None, "created_at": now_utc(),
        })
        logger.info("Seeded admin: %s", ADMIN_EMAIL)

    if await db.equipment.count_documents({}) == 0:
        samples = [
            ("SB-001","Steel Stiffback — 8 ft","strongback","good","Yard A",12.0,40),
            ("TB-001","Nudura Gen 1 Turnbuckle","turnbuckle","good","Yard A",8.0,60),
            ("WB-001","Nudura Gen 1 Walk-Board Bracket","walkboard_bracket","good","Yard B",6.0,80),
            ("HR-001","Nudura Gen 1 Handrail","hand_rail","good","Yard B",4.0,100),
            ("EX-001","ReachCraft Extension","tb_extension","good","Yard A",3.0,50),
            ("CU-001","Non Stop Heavy Duty Crank-Up","crankup_scaffold","good","Yard C",25.0,12),
        ]
        for sku,name,cat,cond,loc,rate,qty in samples:
            eq = Equipment(sku=sku, name=name, category=cat, condition=cond, location=loc, daily_rate=rate, quantity=qty, available=qty)
            await db.equipment.insert_one(eq.model_dump())
        logger.info("Seeded sample equipment")

    await seed_bracing_catalog()
    await seed_tool_inventory()
    await seed_dispatch_plans("outbound_plan_seed.json", "outbound", "Bracing Outbound")
    await seed_dispatch_plans("inbound_plan_seed.json", "inbound", "Bracing Inbound")
    promoted_rentals = await promote_delivered_outbound_plans()
    if promoted_rentals:
        logger.info("Promoted %d delivered outbound plans to Active Rentals", promoted_rentals)

    if await db.vendors.count_documents({}) == 0:
        await db.vendors.insert_one(Vendor(
            name="Acme ICF Supply", contact_name="John D.", phone="555-0100",
            email="sales@acme-icf.com", address="100 Industrial Way",
            categories=["NUDURA","Fox","Amvic"], freight_terms="FOB origin",
            truck_capacity="2400 sq ft / truck", lead_time_days=7,
        ).model_dump())

    if not await db.site.find_one({"_id": "settings"}):
        await db.site.update_one({"_id": "settings"}, {"$set": SiteSettings().model_dump()}, upsert=True)
    else:
        # The shop/yard is the operational home base for maps, tickets, and
        # routing. Keep this explicit location current without touching the
        # rest of the administrator-managed branding/contact settings.
        await db.site.update_one(
            {"_id": "settings"},
            {"$set": {"company_address": SHOP_ADDRESS, "shop_lat": SHOP_LAT, "shop_lng": SHOP_LNG}},
        )


async def backfill_rental_booking_ids() -> int:
    """Phase 0 linkage backfill: rentals created by dispatch completion
    before Rental.booking_id existed have no forward-compatible link back to
    the booking that spawned them — only the booking's forward pointer
    (Booking.dispatched_rental_id) records it. Backfill the reverse link so
    the future /jobs composition can look up a rental's booking directly
    instead of reverse-scanning bookings. Idempotent — only ever sets
    booking_id on a rental that doesn't already have one (Mongo matches
    missing-or-null with `None`), safe to run on every boot."""
    updated = 0
    cursor = db.bookings.find(
        {"dispatched_rental_id": {"$type": "string"}}, {"_id": 0, "id": 1, "dispatched_rental_id": 1}
    )
    async for bk in cursor:
        result = await db.rentals.update_one(
            {"id": bk["dispatched_rental_id"], "booking_id": None},
            {"$set": {"booking_id": bk["id"]}},
        )
        updated += result.modified_count
    return updated


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.equipment.create_index("sku", unique=True)
    await db.equipment.create_index("qr_code", unique=True, partialFilterExpression={"qr_code": {"$type": "string"}})
    await db.dispatches.create_index(
        "source_key",
        unique=True,
        partialFilterExpression={"source_key": {"$type": "string"}},
    )
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("user_id")
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await db.idempotency_keys.create_index([("key", 1), ("endpoint", 1)], unique=True)
    await db.idempotency_keys.create_index("created_at", expireAfterSeconds=IDEMPOTENCY_TTL_SECONDS)
    await db.dashboard_items.create_index([("status", 1), ("due_date", 1), ("created_at", -1)])
    await db.whiteboard_messages.create_index("id", unique=True)
    await db.whiteboard_messages.create_index([("thread_id", 1), ("pinned", -1), ("created_at", -1)])
    await db.whiteboard_messages.create_index([("parent_id", 1), ("created_at", 1)])
    await db.whiteboard_mentions.create_index([("entity_type", 1), ("entity_id", 1), ("created_at", -1)])
    await db.whiteboard_mentions.create_index("message_id")
    await db.whiteboard_attachments.create_index("message_id")
    await db.whiteboard_attachment_blobs.create_index("id", unique=True)
    await db.whiteboard_read_states.create_index([("user_id", 1), ("thread_id", 1)], unique=True)
    await db.whiteboard_audit.create_index([("message_id", 1), ("timestamp", -1)])
    # Phase 0 (Jobs composition seam): indexes the future /jobs endpoint's
    # cross-collection lookups need — join bookings/rentals/dispatches/
    # ledger_entries by booking_id/rental_id, and filter each by its own
    # status — without a full collection scan.
    await db.rentals.create_index("booking_id")
    await db.rentals.create_index("status")
    await db.bookings.create_index("status")
    await db.dispatches.create_index("booking_id")
    await db.dispatches.create_index("rental_id")
    await db.dispatches.create_index([("direction", 1), ("status", 1)])
    await db.vendors.create_index("company")
    await db.vendors.create_index("email")
    await db.vendors.create_index("phone")
    await db.ledger_entries.create_index("booking_id")
    await db.ledger_entries.create_index("rental_id")
    await db.mcp_agents.create_index("id", unique=True)
    await db.mcp_agents.create_index("token_hash", unique=True, partialFilterExpression={"token_hash": {"$type": "string"}})
    await db.mcp_audit_log.create_index("id", unique=True)
    await db.mcp_audit_log.create_index([("agent_identity", 1), ("timestamp", -1)])
    await db.mcp_audit_log.create_index([("tool", 1), ("timestamp", -1)])
    await db.mcp_confirmations.create_index("jti", unique=True)
    await db.mcp_confirmations.create_index("expires_at", expireAfterSeconds=0)
    await seed()
    await backfill_rental_booking_ids()
    await sync_contacts_from_existing_rentals()
    await seed_hermes_agent(db)
    await mobileops_mcp.start()
    logger.info("Concrete Form API ready")


@app.on_event("shutdown")
async def on_shutdown():
    global _geo_client
    await mobileops_mcp.stop()
    if _geo_client is not None:
        await _geo_client.aclose()
    client.close()


app.include_router(api)

# The MCP transport is an additive, independently-authenticated ASGI layer.
# Existing mobile API routes keep their paths and dependency chain unchanged.
try:
    from .mcp_server import create_mobileops_mcp, seed_hermes_agent
except ImportError:  # uvicorn server:app when backend/ is the working directory
    from mcp_server import create_mobileops_mcp, seed_hermes_agent

mobileops_mcp = create_mobileops_mcp(sys.modules[__name__])
app.mount("/api/mcp", mobileops_mcp.asgi_app, name="mobileops-mcp")
