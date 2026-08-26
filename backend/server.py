"""Concrete Form — FastAPI backend.

Single-file backend for an ICF/concrete contractor field-ops app.
Modules: Auth (JWT + RBAC), Equipment, Rentals, Bookings, Maintenance,
Vendors, Site Admin (brand + logo), Bracing Engine, Dashboard, Push relay.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone, date
from enum import Enum
from pathlib import Path
from typing import Any, List, Optional

import httpx
from bson import ObjectId  # noqa: F401  (kept for type hints)
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, FastAPI, Header, HTTPException, Request, UploadFile, File, status
from fastapi.encoders import jsonable_encoder
from fastapi.responses import PlainTextResponse
from pymongo.errors import DuplicateKeyError
from jose import JWTError, jwt
from motor.motor_asyncio import AsyncIOMotorClient
from passlib.context import CryptContext
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


class InventoryCountCreate(BaseModel):
    counted_qty: int


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
    "outbound": ["scheduled", "staging", "ready", "loaded", "dispatched", "arrived", "completed"],
    "inbound": ["scheduled", "dispatched", "arrived", "loaded", "returning", "at_yard", "completed"],
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


class Dispatch(BaseModel):
    id: str = Field(default_factory=gen_id)
    direction: str  # "outbound" | "inbound"
    status: str = "scheduled"
    scheduled_date: Optional[datetime] = None
    customer_name: str
    job_site: str = ""
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
    job_site: str = ""
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


class Rental(BaseModel):
    id: str = Field(default_factory=gen_id)
    customer_name: str
    customer_phone: str = ""
    customer_email: str = ""
    job_site: str = ""
    start_date: datetime
    due_date: Optional[datetime] = None  # legacy — kept optional for backward-compat with old records
    deposit: float = 0.0
    notes: str = ""
    lines: List[RentalLine] = []
    status: str = "active"  # active, partially_returned, returned
    delivered_by: str = ""
    received_by: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    created_at: datetime = Field(default_factory=now_utc)


class RentalCreate(BaseModel):
    customer_name: str
    customer_phone: str = ""
    customer_email: str = ""
    job_site: str = ""
    start_date: datetime
    deposit: float = 0.0
    notes: str = ""
    lines: List[RentalLine]
    lat: Optional[float] = None
    lng: Optional[float] = None


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
    job_site: str = ""
    start_date: datetime
    end_date: datetime
    status: str = "tentative"  # tentative, confirmed, cancelled, dispatched
    items: List[RentalLine] = []
    notes: str = ""
    dispatched_rental_id: Optional[str] = None
    created_at: datetime = Field(default_factory=now_utc)


class BookingCreate(BaseModel):
    customer_name: str
    job_site: str = ""
    start_date: datetime
    end_date: datetime
    status: str = "tentative"
    items: List[RentalLine] = []
    notes: str = ""


class BookingStatusUpdate(BaseModel):
    status: str  # tentative, confirmed, cancelled


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


class SiteSettings(BaseModel):
    brand_name: str = "Concrete Form"
    tagline: str = "ICF Field Tools"
    logo_base64: str = ""  # data URI
    primary_color: str = "#FF6A00"
    company_address: str = ""
    company_phone: str = ""
    company_email: str = ""


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
        {"status": {"$in": ["active", "partially_returned"]}, "lines.equipment_id": eq_id}, {"_id": 0}
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
        {"status": {"$in": ["tentative", "confirmed"]}, "items.equipment_id": eq_id}, {"_id": 0}
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
        {"direction": "outbound", "booking_id": None, "status": {"$nin": ["completed", "cancelled"]}, "lines.equipment_id": eq_id},
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
        await apply_ledger_entry(eq_id, body.qty, "pending_inspection", to_bucket, reason, note=body.note, created_by=user.name)
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
    old_bucket = dispatch_bucket_for_status(direction, current)
    if new_status == "cancelled":
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
    if new_status == "dispatched" and not doc.get("started_at"):
        upd["started_at"] = now
    if new_status == "arrived" and not doc.get("arrived_at"):
        upd["arrived_at"] = now
    if new_status in ("completed", "cancelled"):
        upd["completed_at"] = now

    if old_bucket != new_bucket:
        for line in doc["lines"]:
            await apply_ledger_entry(
                line["equipment_id"], line["qty"], old_bucket, new_bucket,
                f"dispatch_{direction}_{new_status}", location=doc.get("job_site", ""),
                rental_id=doc.get("rental_id"), booking_id=doc.get("booking_id"), created_by=user.name,
            )

    if direction == "outbound" and new_status == "completed" and not doc.get("rental_id"):
        rental = Rental(
            customer_name=doc["customer_name"], job_site=doc.get("job_site", ""),
            start_date=doc.get("scheduled_date") or now_utc(), notes=doc.get("notes", ""),
            lines=[RentalLine(equipment_id=l["equipment_id"], sku=l["sku"], name=l["name"], qty=l["qty"], daily_rate=0) for l in doc["lines"]],
        )
        await db.rentals.insert_one(rental.model_dump())
        upd["rental_id"] = rental.id
        if doc.get("booking_id"):
            await db.bookings.update_one({"id": doc["booking_id"]}, {"$set": {"status": "dispatched", "dispatched_rental_id": rental.id}})

    if direction == "inbound" and new_status == "completed" and doc.get("rental_id"):
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
            rental.status = "returned" if all_returned else ("partially_returned" if any_returned else "active")
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
            {"rental_id": body.rental_id, "direction": "inbound", "status": {"$nin": ["completed", "cancelled"]}}, {"_id": 0}
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

    dispatch = Dispatch(**body.model_dump(), created_by=user.name)
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
        if current in ("completed", "cancelled"):
            raise HTTPException(400, f"Dispatch already {current}")

        flow = DISPATCH_FLOWS[doc["direction"]]
        new_status = body.status
        if new_status != "cancelled":
            if new_status not in flow:
                raise HTTPException(400, f"Invalid status for a {doc['direction']} dispatch")
            cur_idx = flow.index(current)
            new_idx = flow.index(new_status)
            if new_idx != cur_idx + 1:
                raise HTTPException(400, f"Cannot jump from '{current}' to '{new_status}' — next step is '{flow[cur_idx + 1]}'")

        updated = await _set_dispatch_status(doc, new_status, user)
        return Dispatch(**updated)

    return await idempotent(idempotency_key, "update_dispatch_status", _run)


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
        {"booking_id": doc["id"], "direction": "outbound", "status": {"$ne": "cancelled"}}, {"_id": 0}
    )
    if existing:
        return existing
    dispatch = Dispatch(
        direction="outbound",
        scheduled_date=doc.get("start_date"),
        customer_name=doc["customer_name"],
        job_site=doc.get("job_site", ""),
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
        {"booking_id": bk_id, "direction": "outbound", "status": {"$nin": ["completed", "cancelled"]}}, {"_id": 0}
    )
    if doc:
        await _set_dispatch_status(doc, "cancelled", user)


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


@api.post("/rentals", response_model=Rental, status_code=201)
async def create_rental(
    body: RentalCreate, user: UserPublic = Depends(require_role(Role.foreman)),
    idempotency_key: Optional[str] = Depends(idem_key),
):
    async def _run():
        rental = Rental(**body.model_dump())

        async def _do(session):
            for line in rental.lines:
                await apply_ledger_entry(
                    line.equipment_id, line.qty, "available", "on_rental", "rental_created",
                    location=rental.job_site, rental_id=rental.id, created_by=user.name, session=session,
                )
            await db.rentals.insert_one(rental.model_dump(), session=session)

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
        rental.status = "returned" if all_returned else ("partially_returned" if any_returned else "active")
        await db.rentals.update_one({"id": rental_id}, {"$set": rental.model_dump()})
        return rental

    return await idempotent(idempotency_key, "partial_return", _run)


@api.post("/rentals/{rental_id}/schedule-pickup", response_model=Dispatch, status_code=201)
async def schedule_pickup(rental_id: str, body: SchedulePickupCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    """Create the inbound Dispatch that sends a truck back out to a job to
    collect a rental's still-outstanding units. Lines are derived from what's
    actually left on site (delivered - returned) — already-returned lines are
    skipped so the driver isn't sent to pick up units that came back some
    other way (e.g. a desk return)."""
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")
    rental = Rental(**doc)
    if rental.status == "returned":
        raise HTTPException(400, "Rental is already fully returned — nothing left to pick up")
    existing = await db.dispatches.find_one(
        {"rental_id": rental_id, "direction": "inbound", "status": {"$nin": ["completed", "cancelled"]}}, {"_id": 0}
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
        customer_name=rental.customer_name,
        job_site=rental.job_site,
        lat=rental.lat, lng=rental.lng,
        rental_id=rental_id,
        driver_name=body.driver_name, truck=body.truck, trailer=body.trailer, crew=body.crew,
        lines=lines,
        notes=body.notes,
        created_by=user.name,
    )
    await db.dispatches.insert_one(dispatch.model_dump())
    return dispatch


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
    for line in upd["lines"]:
        line["returned_qty"] = min(old_returned.get(line["equipment_id"], 0), line["qty"])
        line["damaged_qty"] = min(old_damaged.get(line["equipment_id"], 0), line["qty"])

    # Recompute status.
    if not upd["lines"]:
        upd["status"] = "active"
    else:
        all_ret = all(l["returned_qty"] >= (l.get("delivered_qty") or l["qty"]) for l in upd["lines"])
        any_ret = any(l["returned_qty"] > 0 for l in upd["lines"])
        upd["status"] = "returned" if all_ret else ("partially_returned" if any_ret else "active")

    # Preserve id, created_at, and legacy due_date.
    upd["id"] = rental_id
    upd["created_at"] = doc.get("created_at", now_utc())
    if "due_date" in doc and doc["due_date"] is not None:
        upd["due_date"] = doc["due_date"]

    await db.rentals.update_one({"id": rental_id}, {"$set": upd})
    new_doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
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
    if bk.status != "cancelled":
        needed: dict = {}
        for item in bk.items:
            needed[item.equipment_id] = needed.get(item.equipment_id, 0) + item.qty
        for eq_id, qty in needed.items():
            eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
            if not eq or eq.get("available", 0) < qty:
                raise HTTPException(400, f"Not enough available {eq.get('name', eq_id) if eq else eq_id} to reserve this booking")
    await db.bookings.insert_one(bk.model_dump())
    if bk.status != "cancelled":
        for item in bk.items:
            await apply_ledger_entry(
                item.equipment_id, item.qty, "available", "reserved", "booking_reserved",
                location=bk.job_site, booking_id=bk.id, created_by=user.name,
            )
    if bk.status == "confirmed":
        await _on_booking_confirmed(bk.model_dump(), user)
    return bk


@api.patch("/bookings/{bk_id}/status", response_model=Booking)
async def update_booking_status(bk_id: str, body: BookingStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Booking not found")
    if doc.get("status") == "dispatched":
        raise HTTPException(400, "Booking already dispatched to a rental — manage it from the rental instead")
    if body.status not in ("tentative", "confirmed", "cancelled"):
        raise HTTPException(400, "Invalid status")
    was_active = doc.get("status") != "cancelled"
    will_be_active = body.status != "cancelled"
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
    if body.status == "confirmed" and doc.get("status") != "confirmed":
        await _on_booking_confirmed(doc, user)
    await db.bookings.update_one({"id": bk_id}, {"$set": {"status": body.status}})
    new_doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    return Booking(**new_doc)


@api.delete("/bookings/{bk_id}")
async def delete_booking(bk_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    # A dispatched booking's units already moved reserved -> on_rental under
    # the rental it created — nothing is left in "reserved" to release.
    if doc and doc.get("status") not in ("cancelled", "dispatched"):
        await _cancel_linked_outbound_dispatch(bk_id, user)
        for item in doc.get("items", []):
            await apply_ledger_entry(
                item["equipment_id"], item["qty"], "reserved", "available", "booking_released",
                booking_id=bk_id, created_by=user.name,
            )
    await db.bookings.delete_one({"id": bk_id})
    return {"ok": True}


@api.post("/bookings/{bk_id}/dispatch", response_model=Rental, status_code=201)
async def dispatch_booking(bk_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    """Quick-dispatch shortcut: fast-forwards a confirmed booking's linked
    outbound Dispatch through the rest of DISPATCH_FLOWS straight to
    'completed' in one call, for a booking that doesn't need its staging/
    loading steps tracked individually. It walks the exact same status path
    (and bucket moves) a manually-staged dispatch would, via repeated
    _set_dispatch_status calls, so the Rental it produces and the bucket
    accounting are identical either way — this is not a separate path."""
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Booking not found")
    if doc.get("status") != "confirmed":
        raise HTTPException(400, "Only a confirmed booking can be dispatched")
    if not doc.get("items"):
        raise HTTPException(400, "Booking has no equipment to dispatch")

    dispatch_doc = await _create_outbound_dispatch_for_booking(doc, user)
    flow = DISPATCH_FLOWS["outbound"]
    cur_idx = flow.index(dispatch_doc["status"])
    for status in flow[cur_idx + 1:]:
        dispatch_doc = await _set_dispatch_status(dispatch_doc, status, user)

    rental_doc = await db.rentals.find_one({"id": dispatch_doc["rental_id"]}, {"_id": 0})
    return Rental(**rental_doc)


@api.get("/bookings/capacity")
async def capacity_check(target_date: str, _: UserPublic = Depends(get_current_user)):
    """Return per-equipment availability for a given date."""
    try:
        d = datetime.fromisoformat(target_date)
    except Exception:
        raise HTTPException(400, "target_date must be ISO")
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    rentals = await db.rentals.find({"status": {"$in": ["active", "partially_returned"]}}, {"_id": 0}).to_list(1000)
    bookings = await db.bookings.find({"status": {"$in": ["tentative", "confirmed"]}}, {"_id": 0}).to_list(1000)
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
    rentals = await db.rentals.find({"status": {"$in": ["active", "partially_returned"]}}, {"_id": 0}).to_list(1000)
    bookings = await db.bookings.find({"status": {"$in": ["tentative", "confirmed"]}}, {"_id": 0}).to_list(1000)

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


# ----------------------------- Vendors ------------------------------------
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

    active_rentals = await db.rentals.count_documents({"status": {"$in": ["active", "partially_returned"]}})
    open_maintenance = await db.maintenance.count_documents({"status": {"$in": ["open", "in_progress"]}})
    open_shop_tasks = await db.shop_tasks.count_documents({"status": {"$ne": "done"}})
    vendors_count = await db.vendors.count_documents({})

    today = now_utc().date()
    returning_today = 0
    bookings_today = await db.bookings.find({"status": {"$ne": "cancelled"}}, {"_id": 0}).to_list(1000)
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
        "vendors_count": vendors_count,
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

    if await db.vendors.count_documents({}) == 0:
        await db.vendors.insert_one(Vendor(
            name="Acme ICF Supply", contact_name="John D.", phone="555-0100",
            email="sales@acme-icf.com", address="100 Industrial Way",
            categories=["NUDURA","Fox","Amvic"], freight_terms="FOB origin",
            truck_capacity="2400 sq ft / truck", lead_time_days=7,
        ).model_dump())

    if not await db.site.find_one({"_id": "settings"}):
        await db.site.update_one({"_id": "settings"}, {"$set": SiteSettings().model_dump()}, upsert=True)


@app.on_event("startup")
async def on_startup():
    await db.users.create_index("email", unique=True)
    await db.equipment.create_index("sku", unique=True)
    await db.equipment.create_index("qr_code", unique=True, partialFilterExpression={"qr_code": {"$type": "string"}})
    await db.idempotency_keys.create_index([("key", 1), ("endpoint", 1)], unique=True)
    await db.idempotency_keys.create_index("created_at", expireAfterSeconds=IDEMPOTENCY_TTL_SECONDS)
    await db.mcp_agents.create_index("id", unique=True)
    await db.mcp_agents.create_index("token_hash", unique=True, partialFilterExpression={"token_hash": {"$type": "string"}})
    await db.mcp_audit_log.create_index("id", unique=True)
    await db.mcp_audit_log.create_index([("agent_identity", 1), ("timestamp", -1)])
    await db.mcp_audit_log.create_index([("tool", 1), ("timestamp", -1)])
    await db.mcp_confirmations.create_index("jti", unique=True)
    await db.mcp_confirmations.create_index("expires_at", expireAfterSeconds=0)
    await seed()
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
