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
import uuid
from datetime import datetime, timedelta, timezone, date
from enum import Enum
from pathlib import Path
from typing import Any, List, Optional

import httpx
from bson import ObjectId  # noqa: F401  (kept for type hints)
from dotenv import load_dotenv
from fastapi import APIRouter, Body, Depends, FastAPI, HTTPException, Request, UploadFile, File, status
from fastapi.responses import PlainTextResponse
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
EMERGENT_PUSH_KEY = os.environ.get("EMERGENT_PUSH_KEY", "placeholder")
PUSH_BASE_URL = "https://integrations.emergentagent.com"

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

EQUIPMENT_CATEGORIES = [
    "strongback",
    "turnbuckle",
    "walkboard_bracket",
    "hand_rail",
    "tb_extension",
    "crankup_scaffold",
]

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


class RegisterReq(BaseModel):
    email: EmailStr
    password: str
    name: str
    role: Role = Role.crew


class SignupReq(BaseModel):
    email: EmailStr
    password: str
    name: str

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
# one bucket at a time; `quantity` (owned) always equals the sum of all six.
# Movements between buckets are the unit of truth (see LedgerEntry) —
# available/reserved/etc. on the Equipment doc are a maintained cache of the
# ledger, not the source of it.
BUCKET_FIELDS = ["available", "reserved", "on_rental", "in_transit", "pending_inspection", "in_maintenance", "missing"]


class Equipment(BaseModel):
    id: str = Field(default_factory=gen_id)
    sku: str
    name: str
    category: str
    condition: str = "good"  # good, fair, poor, broken
    location: str = ""
    daily_rate: float = 0.0
    quantity: int = 1  # owned
    available: int = 1
    reserved: int = 0
    on_rental: int = 0
    in_transit: int = 0
    pending_inspection: int = 0  # returned, awaiting inspection before going back to available
    in_maintenance: int = 0  # confirmed damaged / open maintenance ticket
    missing: int = 0  # unaccounted for at last physical count
    tracking_type: str = "bulk"  # "bulk" (pooled qty) or "serialized" (individually tracked units)
    notes: str = ""
    created_at: datetime = Field(default_factory=now_utc)


class EquipmentCreate(BaseModel):
    sku: str
    name: str
    category: str
    condition: str = "good"
    location: str = ""
    daily_rate: float = 0.0
    quantity: int = 1
    available: Optional[int] = None
    tracking_type: str = "bulk"
    notes: str = ""


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


class RentalLine(BaseModel):
    equipment_id: str
    sku: str
    name: str
    qty: int  # ordered
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


class SessionExchangeBody(BaseModel):
    session_id: str


class ReturnLine(BaseModel):
    equipment_id: str
    qty: int
    damaged_qty: int = 0  # of `qty`, how many came back visibly damaged — routed straight to maintenance instead of inspection


class Booking(BaseModel):
    id: str = Field(default_factory=gen_id)
    customer_name: str
    job_site: str = ""
    start_date: datetime
    end_date: datetime
    status: str = "tentative"  # tentative, confirmed, cancelled
    items: List[RentalLine] = []
    notes: str = ""
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


# Push
class RegisterPushBody(BaseModel):
    user_id: str
    platform: str
    device_token: str


class InspectBody(BaseModel):
    qty: int
    outcome: str  # "available" or "damaged"
    note: str = ""


# ----------------------------- Inventory Ledger ----------------------------
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
) -> None:
    """Move `qty` units of `equipment_id` from one bucket to another,
    atomically updating the equipment doc's cached bucket counts and
    recording a LedgerEntry for audit history.

    `from_bucket` / `to_bucket` are entries of BUCKET_FIELDS, or "owned" for
    entries that change total ownership rather than move between buckets
    (e.g. a fresh receipt goes owned -> available; a write-off goes
    missing -> owned). "owned" only ever touches `quantity`, never a bucket
    field, so ownership changes never fabricate or destroy bucket units.
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
    await db.equipment.update_one({"id": equipment_id}, {"$inc": inc})
    entry = LedgerEntry(
        equipment_id=equipment_id, qty=qty, from_bucket=from_bucket, to_bucket=to_bucket,
        reason=reason, location=location, rental_id=rental_id, booking_id=booking_id,
        note=note, created_by=created_by,
    )
    await db.ledger_entries.insert_one(entry.model_dump())


# ----------------------------- Auth Deps ----------------------------------
async def _user_from_session_token(token: str) -> Optional[dict]:
    sess = await db.user_sessions.find_one({"session_token": token}, {"_id": 0})
    if not sess:
        return None
    exp = sess.get("expires_at")
    if isinstance(exp, str):
        try:
            exp = datetime.fromisoformat(exp.replace("Z", "+00:00"))
        except Exception:
            exp = None
    if isinstance(exp, datetime):
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < now_utc():
            return None
    user = await db.users.find_one({"id": sess["user_id"]}, {"_id": 0, "password_hash": 0})
    return user


async def get_current_user(request: Request) -> UserPublic:
    auth = request.headers.get("Authorization") or ""
    if not auth.lower().startswith("bearer "):
        raise HTTPException(401, "Missing bearer token")
    token = auth.split(" ", 1)[1]
    # 1) Try Emergent Google session token
    user = await _user_from_session_token(token)
    if user:
        return UserPublic(id=user["id"], email=user["email"], name=user["name"], role=Role(user["role"]))
    # 2) Fall back to JWT
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
    """Create a least-privileged account and sign it in immediately."""
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


@api.post("/auth/session", response_model=TokenPair)
async def exchange_emergent_session(body: SessionExchangeBody):
    """Emergent Google Auth: exchange one-time session_id for a 7-day session_token
    and upsert the user by email. NEVER accept a session_token here."""
    async with httpx.AsyncClient(timeout=10.0) as hc:
        try:
            resp = await hc.get(
                "https://demobackend.emergentagent.com/auth/v1/env/oauth/session-data",
                headers={"X-Session-ID": body.session_id},
            )
        except Exception as e:
            logger.warning("emergent session exchange failed: %s", e)
            raise HTTPException(401, "Session exchange failed")
    if resp.status_code != 200:
        raise HTTPException(401, "Invalid or expired session")
    data = resp.json() or {}
    email = (data.get("email") or "").strip().lower()
    name = data.get("name") or email.split("@")[0] or "User"
    session_token = data.get("session_token")
    if not email or not session_token:
        raise HTTPException(401, "Session data incomplete")

    # Upsert user by email — reuse existing id if known (so JWT admins can also log in via Google)
    existing = await db.users.find_one({"email": email})
    if existing:
        user_id = existing["id"]
        role = existing.get("role", Role.crew.value)
    else:
        user_id = gen_id()
        role = Role.crew.value
        await db.users.insert_one({
            "id": user_id,
            "email": email,
            "name": name,
            "password_hash": "",  # Google-only account
            "role": role,
            "failed_attempts": 0,
            "lock_until": None,
            "created_at": now_utc(),
        })

    # Persist session (upsert on session_token so a repeated session_id is idempotent)
    expires_at = now_utc() + timedelta(days=7)
    await db.user_sessions.update_one(
        {"session_token": session_token},
        {"$set": {
            "session_token": session_token,
            "user_id": user_id,
            "expires_at": expires_at,
            "created_at": now_utc(),
            "provider": "emergent_google",
        }},
        upsert=True,
    )

    pub = UserPublic(id=user_id, email=email, name=name, role=Role(role))
    # Reuse TokenPair shape so the frontend has a single response model.
    # `access_token` is the session_token; refresh_token is set to the same value
    # (Emergent sessions don't need refresh — they last 7 days).
    return TokenPair(access_token=session_token, refresh_token=session_token, user=pub)


@api.get("/auth/users", response_model=List[UserPublic])
async def list_users(_: UserPublic = Depends(require_role(Role.admin))):
    docs = await db.users.find({}, {"_id": 0, "password_hash": 0}).to_list(500)
    return [UserPublic(id=d["id"], email=d["email"], name=d["name"], role=Role(d["role"])) for d in docs]


# ----------------------------- Equipment ----------------------------------
@api.get("/equipment", response_model=List[Equipment])
async def list_equipment(_: UserPublic = Depends(get_current_user)):
    docs = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    return [Equipment(**d) for d in docs]


@api.post("/equipment", response_model=Equipment, status_code=201)
async def create_equipment(body: EquipmentCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    eq = Equipment(
        sku=body.sku, name=body.name, category=body.category,
        condition=body.condition, location=body.location,
        daily_rate=body.daily_rate, quantity=body.quantity,
        available=body.available if body.available is not None else body.quantity,
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
    if upd.get("available") is None:
        upd["available"] = doc["available"]
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
    writer.writerow(["sku", "name", "category", "condition", "location", "daily_rate", "quantity", "available", "notes"])
    for d in docs:
        writer.writerow([d.get("sku",""), d.get("name",""), d.get("category",""), d.get("condition",""),
                         d.get("location",""), d.get("daily_rate",0), d.get("quantity",0),
                         d.get("available",0), d.get("notes","")])
    return PlainTextResponse(buf.getvalue(), media_type="text/csv")


@api.post("/equipment/import.csv")
async def import_equipment_csv(file: UploadFile = File(...), _: UserPublic = Depends(require_role(Role.foreman))):
    data = (await file.read()).decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(data))
    count = 0
    for row in reader:
        try:
            eq = Equipment(
                sku=row.get("sku","").strip() or gen_id()[:8],
                name=row.get("name","").strip() or "Item",
                category=row.get("category","strongback").strip(),
                condition=row.get("condition","good").strip(),
                location=row.get("location","").strip(),
                daily_rate=float(row.get("daily_rate") or 0),
                quantity=int(float(row.get("quantity") or 1)),
                available=int(float(row.get("available") or row.get("quantity") or 1)),
                notes=row.get("notes","").strip(),
            )
            await db.equipment.update_one({"sku": eq.sku}, {"$set": eq.model_dump()}, upsert=True)
            count += 1
        except Exception as e:
            logger.warning("CSV row skipped: %s", e)
    return {"imported": count}


@api.get("/equipment/{eq_id}/breakdown")
async def equipment_breakdown(eq_id: str, _: UserPublic = Depends(get_current_user)):
    """Where every owned unit of this SKU currently sits: yard stock, each
    outstanding rental line, each active reservation, and the in-transit /
    pending-inspection / maintenance / missing buckets."""
    eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not eq:
        raise HTTPException(404, "Equipment not found")
    rows: List[dict] = []
    if eq.get("available", 0) > 0:
        rows.append({"qty": eq["available"], "label": eq.get("location") or "Yard", "kind": "yard"})

    rentals = await db.rentals.find(
        {"status": {"$in": ["active", "partially_returned"]}, "lines.equipment_id": eq_id}, {"_id": 0}
    ).to_list(1000)
    for r in rentals:
        for line in r.get("lines", []):
            if line["equipment_id"] != eq_id:
                continue
            delivered = line.get("delivered_qty") or line["qty"]
            outstanding = delivered - line.get("returned_qty", 0) - line.get("damaged_qty", 0)
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
async def inspect_equipment(eq_id: str, body: InspectBody, user: UserPublic = Depends(require_role(Role.foreman))):
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


# ----------------------------- Physical inventory counts -------------------
@api.post("/equipment/{eq_id}/count", response_model=InventoryCount, status_code=201)
async def create_inventory_count(eq_id: str, body: InventoryCountCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    """Record a physical yard count against the system's expected available
    count. This never changes inventory by itself — it only creates a
    Variance for an authorized person to reconcile with a reason."""
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


@api.get("/inventory-counts", response_model=List[InventoryCount])
async def list_inventory_counts(_: UserPublic = Depends(get_current_user)):
    docs = await db.inventory_counts.find({}, {"_id": 0}).sort("counted_at", -1).to_list(500)
    return [InventoryCount(**d) for d in docs]


@api.post("/inventory-counts/{count_id}/reconcile", response_model=InventoryCount)
async def reconcile_inventory_count(count_id: str, body: ReconcileBody, user: UserPublic = Depends(require_role(Role.admin))):
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


# ----------------------------- Transfers ------------------------------------
@api.get("/transfers", response_model=List[Transfer])
async def list_transfers(_: UserPublic = Depends(get_current_user)):
    docs = await db.transfers.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Transfer(**d) for d in docs]


@api.post("/equipment/{eq_id}/transfer", response_model=Transfer, status_code=201)
async def create_transfer(eq_id: str, body: TransferCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    """Move `qty` available units of this SKU to another yard. Units sit in
    the in_transit bucket until received at the destination — this is a
    whole-yard relocation, not per-unit tracking (bulk equipment has one
    location field for its whole available pool)."""
    eq = await db.equipment.find_one({"id": eq_id}, {"_id": 0})
    if not eq:
        raise HTTPException(404, "Equipment not found")
    if body.qty <= 0 or body.qty > eq.get("available", 0):
        raise HTTPException(400, "qty exceeds available units")
    if not body.to_location.strip():
        raise HTTPException(400, "to_location is required")
    transfer = Transfer(
        equipment_id=eq_id, equipment_name=eq.get("name", ""), qty=body.qty,
        from_location=eq.get("location", ""), to_location=body.to_location.strip(),
        note=body.note, created_by=user.name,
    )
    await db.transfers.insert_one(transfer.model_dump())
    await apply_ledger_entry(
        eq_id, body.qty, "available", "in_transit", "transfer",
        location=body.to_location.strip(), note=body.note, created_by=user.name,
    )
    return transfer


@api.post("/transfers/{transfer_id}/receive", response_model=Transfer)
async def receive_transfer(transfer_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Transfer not found")
    if doc["status"] == "received":
        raise HTTPException(400, "Already received")
    await apply_ledger_entry(
        doc["equipment_id"], doc["qty"], "in_transit", "available", "transfer",
        location=doc["to_location"], note=f"Received at {doc['to_location']}", created_by=user.name,
    )
    # Whole-yard relocation semantics: the destination becomes the equipment's
    # location of record. A split-location yard isn't modeled — see note above.
    await db.equipment.update_one({"id": doc["equipment_id"]}, {"$set": {"location": doc["to_location"]}})
    await db.transfers.update_one(
        {"id": transfer_id},
        {"$set": {"status": "received", "received_by": user.name, "received_at": now_utc()}},
    )
    new_doc = await db.transfers.find_one({"id": transfer_id}, {"_id": 0})
    return Transfer(**new_doc)


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
async def list_rentals(_: UserPublic = Depends(get_current_user)):
    docs = await db.rentals.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Rental(**d) for d in docs]


@api.post("/rentals", response_model=Rental, status_code=201)
async def create_rental(body: RentalCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    rental = Rental(**body.model_dump())
    for line in rental.lines:
        await apply_ledger_entry(
            line.equipment_id, line.qty, "available", "on_rental", "rental_created",
            location=rental.job_site, rental_id=rental.id, created_by=user.name,
        )
    await db.rentals.insert_one(rental.model_dump())
    return rental


@api.post("/rentals/{rental_id}/return", response_model=Rental)
async def partial_return(rental_id: str, returns: List[ReturnLine] = Body(...), user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")
    rental = Rental(**doc)
    for ret in returns:
        for line in rental.lines:
            if line.equipment_id == ret.equipment_id:
                remaining = line.qty - line.returned_qty - line.damaged_qty
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
    all_returned = all((l.returned_qty + l.damaged_qty) >= l.qty for l in rental.lines)
    any_returned = any((l.returned_qty + l.damaged_qty) > 0 for l in rental.lines)
    rental.status = "returned" if all_returned else ("partially_returned" if any_returned else "active")
    await db.rentals.update_one({"id": rental_id}, {"$set": rental.model_dump()})
    return rental


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
        remaining = line["qty"] - line.get("returned_qty", 0) - line.get("damaged_qty", 0)
        old_by_eq[line["equipment_id"]] = old_by_eq.get(line["equipment_id"], 0) + remaining

    new_by_eq: dict[str, int] = {}
    for line in body.lines:
        new_by_eq[line.equipment_id] = new_by_eq.get(line.equipment_id, 0) + line.qty

    for eq_id in set(old_by_eq) | set(new_by_eq):
        delta = new_by_eq.get(eq_id, 0) - old_by_eq.get(eq_id, 0)  # +ve means MORE committed
        if delta > 0:
            await apply_ledger_entry(eq_id, delta, "available", "on_rental", "rental_updated", rental_id=rental_id, created_by=user.name)
        elif delta < 0:
            await apply_ledger_entry(eq_id, -delta, "on_rental", "available", "rental_updated", rental_id=rental_id, created_by=user.name)

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
        all_ret = all((l["returned_qty"] + l["damaged_qty"]) >= l["qty"] for l in upd["lines"])
        any_ret = any((l["returned_qty"] + l["damaged_qty"]) > 0 for l in upd["lines"])
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
    # restore inventory: only the still-on_rental portion returns to available
    for line in doc.get("lines", []):
        remaining = line["qty"] - line.get("returned_qty", 0) - line.get("damaged_qty", 0)
        if remaining > 0:
            await apply_ledger_entry(
                line["equipment_id"], remaining, "on_rental", "available", "rental_deleted",
                rental_id=rental_id, created_by=user.name,
            )
    await db.rentals.delete_one({"id": rental_id})
    return {"ok": True}


# ----------------------------- Bookings -----------------------------------
@api.get("/bookings", response_model=List[Booking])
async def list_bookings(_: UserPublic = Depends(get_current_user)):
    docs = await db.bookings.find({}, {"_id": 0}).sort("start_date", 1).to_list(1000)
    return [Booking(**d) for d in docs]


@api.post("/bookings", response_model=Booking, status_code=201)
async def create_booking(body: BookingCreate, user: UserPublic = Depends(require_role(Role.foreman))):
    bk = Booking(**body.model_dump())
    await db.bookings.insert_one(bk.model_dump())
    if bk.status != "cancelled":
        for item in bk.items:
            await apply_ledger_entry(
                item.equipment_id, item.qty, "available", "reserved", "booking_reserved",
                location=bk.job_site, booking_id=bk.id, created_by=user.name,
            )
    return bk


@api.patch("/bookings/{bk_id}/status", response_model=Booking)
async def update_booking_status(bk_id: str, body: BookingStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Booking not found")
    if body.status not in ("tentative", "confirmed", "cancelled"):
        raise HTTPException(400, "Invalid status")
    was_active = doc.get("status") != "cancelled"
    will_be_active = body.status != "cancelled"
    if was_active and not will_be_active:
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
    await db.bookings.update_one({"id": bk_id}, {"$set": {"status": body.status}})
    new_doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    return Booking(**new_doc)


@api.delete("/bookings/{bk_id}")
async def delete_booking(bk_id: str, user: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.bookings.find_one({"id": bk_id}, {"_id": 0})
    if doc and doc.get("status") != "cancelled":
        for item in doc.get("items", []):
            await apply_ledger_entry(
                item["equipment_id"], item["qty"], "reserved", "available", "booking_released",
                booking_id=bk_id, created_by=user.name,
            )
    await db.bookings.delete_one({"id": bk_id})
    return {"ok": True}


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
    for r in rentals:
        for line in r.get("lines", []):
            rem = line["qty"] - line.get("returned_qty", 0) - line.get("damaged_qty", 0)
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
            "equipment_id": e["id"], "sku": e["sku"], "name": e["name"],
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
                rem = line["qty"] - line.get("returned_qty", 0) - line.get("damaged_qty", 0)
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
                    "date": d.isoformat(), "equipment_id": eq_id, "sku": eq["sku"], "name": eq["name"],
                    "shortage": short, "demand": used, "owned": eq["quantity"],
                    "jobs": sorted(set(jobs.get(eq_id, []))),
                })
    return {"rows": shortages}


# ----------------------------- Maintenance --------------------------------
@api.get("/maintenance", response_model=List[Maintenance])
async def list_maintenance(_: UserPublic = Depends(get_current_user)):
    docs = await db.maintenance.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Maintenance(**d) for d in docs]


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
async def update_shop_task_status(task_id: str, body: ShopTaskStatusUpdate, user: UserPublic = Depends(require_role(Role.foreman))):
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


# ----------------------------- Push relay ---------------------------------
_push_client: Optional[httpx.AsyncClient] = None
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



def push_client() -> httpx.AsyncClient:
    global _push_client
    if _push_client is None:
        _push_client = httpx.AsyncClient(
            base_url=PUSH_BASE_URL,
            headers={"X-Push-Key": EMERGENT_PUSH_KEY},
            timeout=10.0,
        )
    return _push_client


@api.post("/register-push", status_code=201)
async def register_push(body: RegisterPushBody):
    # Non-blocking: never let a push provider hiccup break the app.
    # Frontend calls this on every login/token refresh, so a 5xx here would
    # spam users with error toasts.
    try:
        resp = await push_client().post("/api/v1/push/users/register", json=body.model_dump())
        if resp.status_code == 201 or resp.status_code == 200:
            return {"status": "registered"}
        if resp.status_code == 401:
            logger.warning("push register: EMERGENT_PUSH_KEY missing or invalid")
            return {"status": "skipped", "reason": "push_key_missing"}
        logger.warning("push register unexpected status %s: %s", resp.status_code, resp.text[:200])
        return {"status": "skipped", "reason": f"upstream_{resp.status_code}"}
    except Exception as e:
        logger.warning("push register failed: %s", e)
        return {"status": "skipped", "reason": "upstream_unreachable"}


async def send_push(recipients: List[str], data: dict) -> None:
    if not recipients:
        return
    payload = {"recipients": recipients, "data": data}
    try:
        resp = await push_client().post("/api/v1/push/trigger", json=payload)
        if resp.status_code >= 500:
            logger.warning("push trigger 5xx")
        elif resp.status_code >= 400:
            logger.warning("push trigger %s: %s", resp.status_code, resp.text[:200])
    except Exception as e:
        logger.warning("push trigger failed: %s", e)


# ----------------------------- Startup seed -------------------------------
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
            ("SB-001","8 ft Strongback","strongback","good","Yard A",12.0,40),
            ("TB-001","Turnbuckle 10 ft","turnbuckle","good","Yard A",8.0,60),
            ("WB-001","Walkboard Bracket","walkboard_bracket","good","Yard B",6.0,80),
            ("HR-001","Hand Rail (8 ft)","hand_rail","good","Yard B",4.0,100),
            ("EX-001","TB Extension","tb_extension","good","Yard A",3.0,50),
            ("CU-001","Crankup Scaffold","crankup_scaffold","good","Yard C",25.0,12),
        ]
        for sku,name,cat,cond,loc,rate,qty in samples:
            eq = Equipment(sku=sku, name=name, category=cat, condition=cond, location=loc, daily_rate=rate, quantity=qty, available=qty)
            await db.equipment.insert_one(eq.model_dump())
        logger.info("Seeded sample equipment")

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
    await db.user_sessions.create_index("session_token", unique=True)
    await db.user_sessions.create_index("user_id")
    await db.user_sessions.create_index("expires_at", expireAfterSeconds=0)
    await seed()
    logger.info("Concrete Form API ready")


@app.on_event("shutdown")
async def on_shutdown():
    global _push_client, _geo_client
    if _push_client is not None:
        await _push_client.aclose()
    if _geo_client is not None:
        await _geo_client.aclose()
    client.close()


app.include_router(api)
