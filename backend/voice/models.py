from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AgentCallState(str, Enum):
    CREATED = "CREATED"
    QUEUED = "QUEUED"
    DIALING = "DIALING"
    RINGING = "RINGING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


class CallTransition(BaseModel):
    from_state: Optional[AgentCallState] = None
    to_state: AgentCallState
    at: datetime = Field(default_factory=utc_now)
    reason: str = ""


class TranscriptTurn(BaseModel):
    role: Literal["caller", "nathan", "system"]
    text: str
    at: datetime = Field(default_factory=utc_now)


class CallUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    input_audio_tokens: int = 0
    output_audio_tokens: int = 0
    duration_seconds: int = 0


class AgentCall(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    state: AgentCallState = AgentCallState.CREATED
    target_type: Literal["rental", "dispatch"]
    target_id: str
    destination_phone: str
    requested_by_id: str
    requested_by_name: str
    purpose: str = ""
    operational_context: dict = Field(default_factory=dict)
    twilio_call_sid: Optional[str] = None
    twilio_stream_sid: Optional[str] = None
    transcript: list[TranscriptTurn] = Field(default_factory=list)
    usage: CallUsage = Field(default_factory=CallUsage)
    transitions: list[CallTransition] = Field(default_factory=list)
    last_error: str = ""
    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None


class AgentCallCreate(BaseModel):
    target_type: Literal["rental", "dispatch"]
    target_id: str
    destination_phone: str
    purpose: str = ""

    @field_validator("destination_phone")
    @classmethod
    def validate_e164(cls, value: str) -> str:
        normalized = value.strip()
        if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
            raise ValueError("destination_phone must be an E.164 number such as +12125550123")
        return normalized
