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


class TokenPair(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserPublic


class RefreshReq(BaseModel):
    refresh_token: str


class Equipment(BaseModel):
    id: str = Field(default_factory=gen_id)
    sku: str
    name: str
    category: str
    condition: str = "good"  # good, fair, poor, broken
    location: str = ""
    daily_rate: float = 0.0
    quantity: int = 1
    available: int = 1
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
    notes: str = ""


class RentalLine(BaseModel):
    equipment_id: str
    sku: str
    name: str
    qty: int
    daily_rate: float
    returned_qty: int = 0


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


class ReturnLine(BaseModel):
    equipment_id: str
    qty: int


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


class Maintenance(BaseModel):
    id: str = Field(default_factory=gen_id)
    equipment_id: str
    equipment_name: str = ""
    issue: str
    action_taken: str = ""
    cost: float = 0.0
    status: str = "open"  # open, in_progress, resolved
    serviced_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now_utc)


class MaintenanceCreate(BaseModel):
    equipment_id: str
    issue: str
    action_taken: str = ""
    cost: float = 0.0
    status: str = "open"
    serviced_at: Optional[datetime] = None


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


@api.get("/")
async def root():
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
async def list_equipment(_: UserPublic = Depends(get_current_user)):
    docs = await db.equipment.find({}, {"_id": 0}).to_list(2000)
    return [Equipment(**d) for d in docs]


@api.post("/equipment", response_model=Equipment, status_code=201)
async def create_equipment(body: EquipmentCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    eq = Equipment(
        sku=body.sku, name=body.name, category=body.category,
        condition=body.condition, location=body.location,
        daily_rate=body.daily_rate, quantity=body.quantity,
        available=body.available if body.available is not None else body.quantity,
        notes=body.notes,
    )
    await db.equipment.insert_one(eq.model_dump())
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


# ----------------------------- Rentals ------------------------------------
@api.get("/rentals", response_model=List[Rental])
async def list_rentals(_: UserPublic = Depends(get_current_user)):
    docs = await db.rentals.find({}, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return [Rental(**d) for d in docs]


@api.post("/rentals", response_model=Rental, status_code=201)
async def create_rental(body: RentalCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    rental = Rental(**body.model_dump())
    # decrement available qty
    for line in rental.lines:
        await db.equipment.update_one(
            {"id": line.equipment_id},
            {"$inc": {"available": -line.qty}},
        )
    await db.rentals.insert_one(rental.model_dump())
    return rental


@api.post("/rentals/{rental_id}/return", response_model=Rental)
async def partial_return(rental_id: str, returns: List[ReturnLine] = Body(...), _: UserPublic = Depends(require_role(Role.foreman))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Rental not found")
    rental = Rental(**doc)
    for ret in returns:
        for line in rental.lines:
            if line.equipment_id == ret.equipment_id:
                remaining = line.qty - line.returned_qty
                qty_back = min(ret.qty, remaining)
                line.returned_qty += qty_back
                await db.equipment.update_one(
                    {"id": line.equipment_id},
                    {"$inc": {"available": qty_back}},
                )
    all_returned = all(l.returned_qty >= l.qty for l in rental.lines)
    any_returned = any(l.returned_qty > 0 for l in rental.lines)
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


@api.delete("/rentals/{rental_id}")
async def delete_rental(rental_id: str, _: UserPublic = Depends(require_role(Role.admin))):
    doc = await db.rentals.find_one({"id": rental_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found")
    # restore inventory
    for line in doc.get("lines", []):
        remaining = line["qty"] - line.get("returned_qty", 0)
        if remaining > 0:
            await db.equipment.update_one({"id": line["equipment_id"]}, {"$inc": {"available": remaining}})
    await db.rentals.delete_one({"id": rental_id})
    return {"ok": True}


# ----------------------------- Bookings -----------------------------------
@api.get("/bookings", response_model=List[Booking])
async def list_bookings(_: UserPublic = Depends(get_current_user)):
    docs = await db.bookings.find({}, {"_id": 0}).sort("start_date", 1).to_list(1000)
    return [Booking(**d) for d in docs]


@api.post("/bookings", response_model=Booking, status_code=201)
async def create_booking(body: BookingCreate, _: UserPublic = Depends(require_role(Role.foreman))):
    bk = Booking(**body.model_dump())
    await db.bookings.insert_one(bk.model_dump())
    return bk


@api.delete("/bookings/{bk_id}")
async def delete_booking(bk_id: str, _: UserPublic = Depends(require_role(Role.foreman))):
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
            rem = line["qty"] - line.get("returned_qty", 0)
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
    equipment = await db.equipment.find({}, {"_id": 0}).to_list(5000)
    total_qty = sum(e.get("quantity", 0) for e in equipment)
    total_avail = sum(e.get("available", 0) for e in equipment)
    utilization = round(((total_qty - total_avail) / total_qty) * 100, 1) if total_qty else 0

    active_rentals = await db.rentals.count_documents({"status": {"$in": ["active", "partially_returned"]}})

    open_maintenance = await db.maintenance.count_documents({"status": {"$in": ["open", "in_progress"]}})
    vendors_count = await db.vendors.count_documents({})

    # recent activity (last 8 rentals + maintenance)
    recent_r = await db.rentals.find({}, {"_id": 0}).sort("created_at", -1).to_list(5)
    recent_m = await db.maintenance.find({}, {"_id": 0}).sort("created_at", -1).to_list(5)
    activity = []
    for r in recent_r:
        ts = r.get("created_at")
        activity.append({"type": "rental", "title": f"Rental — {r['customer_name']}", "ts": ts.isoformat() if isinstance(ts, datetime) else str(ts)})
    for m in recent_m:
        ts = m.get("created_at")
        activity.append({"type": "maintenance", "title": f"Service — {m.get('equipment_name','')}", "ts": ts.isoformat() if isinstance(ts, datetime) else str(ts)})
    activity.sort(key=lambda x: x["ts"], reverse=True)

    return {
        "utilization": utilization,
        "total_quantity": total_qty,
        "total_available": total_avail,
        "active_rentals": active_rentals,
        "open_maintenance": open_maintenance,
        "vendors_count": vendors_count,
        "activity": activity[:8],
    }


# ----------------------------- Push relay ---------------------------------
_push_client: Optional[httpx.AsyncClient] = None


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
    try:
        resp = await push_client().post("/api/v1/push/users/register", json=body.model_dump())
        if resp.status_code == 401:
            raise HTTPException(500, "EMERGENT_PUSH_KEY missing or invalid")
        if resp.status_code >= 500:
            raise HTTPException(502, "Push provider unavailable")
        resp.raise_for_status()
    except HTTPException:
        raise
    except Exception as e:
        logger.warning("push register failed: %s", e)
        # don't break login flow if push fails in preview
        return {"status": "skipped"}
    return {"status": "registered"}


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
    await seed()
    logger.info("Concrete Form API ready")


@app.on_event("shutdown")
async def on_shutdown():
    global _push_client
    if _push_client is not None:
        await _push_client.aclose()
    client.close()


app.include_router(api)
