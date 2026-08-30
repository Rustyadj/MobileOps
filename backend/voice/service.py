from __future__ import annotations

from .config import VoiceConfig
from .models import AgentCall, AgentCallCreate, AgentCallState
from .repository import AgentCallRepository
from .twilio_gateway import TwilioVoiceGateway


class VoiceConfigurationError(RuntimeError):
    def __init__(self, missing: list[str]):
        super().__init__("Voice calling is not configured")
        self.missing = missing


class VoiceTargetNotFound(LookupError):
    pass


class AgentCallService:
    def __init__(self, database, config: VoiceConfig, repository: AgentCallRepository, gateway: TwilioVoiceGateway):
        self.database = database
        self.config = config
        self.repository = repository
        self.gateway = gateway

    async def _target_context(self, target_type: str, target_id: str) -> dict:
        collection = self.database.rentals if target_type == "rental" else self.database.dispatches
        doc = await collection.find_one({"id": target_id}, {"_id": 0})
        if not doc:
            raise VoiceTargetNotFound(f"{target_type.title()} not found")
        allowed = (
            "id", "customer_name", "customer_type", "primary_contact", "job_site", "job_address",
            "scheduled_date", "start_date", "status", "direction", "driver_name", "delivery_notes",
            "return_notes", "gate_access_instructions", "notes",
        )
        return {key: doc.get(key) for key in allowed if doc.get(key) not in (None, "")}

    async def create(self, body: AgentCallCreate, user) -> AgentCall:
        missing = self.config.missing_for_outbound_call()
        if missing:
            raise VoiceConfigurationError(missing)
        context = await self._target_context(body.target_type, body.target_id)
        call = AgentCall(
            target_type=body.target_type,
            target_id=body.target_id,
            destination_phone=body.destination_phone,
            requested_by_id=user.id,
            requested_by_name=user.name,
            purpose=body.purpose,
            operational_context=context,
        )
        await self.repository.insert(call)
        call = await self.repository.transition(call.id, AgentCallState.QUEUED, reason="Outbound call requested") or call
        try:
            created = await self.gateway.create_call(call_id=call.id, destination_phone=call.destination_phone)
            await self.repository.set_fields(call.id, {"twilio_call_sid": created["sid"]})
            call = await self.repository.transition(call.id, AgentCallState.DIALING, reason="Accepted by Twilio") or call
            return call
        except Exception as exc:
            await self.repository.set_fields(call.id, {"last_error": str(exc)[:500]})
            await self.repository.transition(call.id, AgentCallState.FAILED, reason="Twilio call creation failed")
            raise

    async def get(self, call_id: str) -> AgentCall | None:
        return await self.repository.get(call_id)
