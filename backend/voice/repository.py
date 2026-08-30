from __future__ import annotations

from .models import AgentCall, AgentCallState, CallUsage, TranscriptTurn, utc_now
from .state_machine import InvalidCallTransition, transition_call


class AgentCallRepository:
    def __init__(self, database):
        self.collection = database.agent_calls

    async def ensure_indexes(self) -> None:
        await self.collection.create_index("id", unique=True)
        await self.collection.create_index("twilio_call_sid", unique=True, partialFilterExpression={"twilio_call_sid": {"$type": "string"}})
        await self.collection.create_index([("target_type", 1), ("target_id", 1), ("created_at", -1)])
        await self.collection.create_index([("state", 1), ("created_at", -1)])

    async def insert(self, call: AgentCall) -> AgentCall:
        await self.collection.insert_one(call.model_dump(mode="json"))
        return call

    async def get(self, call_id: str) -> AgentCall | None:
        doc = await self.collection.find_one({"id": call_id}, {"_id": 0})
        return AgentCall(**doc) if doc else None

    async def transition(self, call_id: str, state: AgentCallState, *, reason: str = "") -> AgentCall | None:
        for _ in range(3):
            call = await self.get(call_id)
            if call is None or call.state == state:
                return call
            try:
                updated = transition_call(call, state, reason=reason)
            except InvalidCallTransition:
                return call
            result = await self.collection.replace_one(
                {"id": call_id, "state": call.state.value},
                updated.model_dump(mode="json"),
            )
            if result.modified_count:
                return updated
        return await self.get(call_id)

    async def set_fields(self, call_id: str, fields: dict) -> None:
        await self.collection.update_one({"id": call_id}, {"$set": {**fields, "updated_at": utc_now()}})

    async def append_transcript(self, call_id: str, turn: TranscriptTurn) -> None:
        await self.collection.update_one(
            {"id": call_id},
            {"$push": {"transcript": turn.model_dump(mode="json")}, "$set": {"updated_at": utc_now()}},
        )

    async def add_usage(self, call_id: str, usage: CallUsage) -> None:
        increments = {
            f"usage.{name}": value
            for name, value in usage.model_dump().items()
            if value
        }
        if increments:
            await self.collection.update_one({"id": call_id}, {"$inc": increments, "$set": {"updated_at": utc_now()}})
