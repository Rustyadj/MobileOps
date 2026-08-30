from __future__ import annotations

from datetime import datetime

from .models import AgentCall, AgentCallState, CallTransition, utc_now


class InvalidCallTransition(ValueError):
    pass


ALLOWED_TRANSITIONS: dict[AgentCallState, frozenset[AgentCallState]] = {
    AgentCallState.CREATED: frozenset({AgentCallState.QUEUED, AgentCallState.FAILED, AgentCallState.CANCELED}),
    # Twilio status callbacks are at-least-once and may skip intermediate
    # callbacks, so forward-only jumps are legal while regressions are not.
    AgentCallState.QUEUED: frozenset({AgentCallState.DIALING, AgentCallState.RINGING, AgentCallState.IN_PROGRESS, AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED}),
    AgentCallState.DIALING: frozenset({AgentCallState.RINGING, AgentCallState.IN_PROGRESS, AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED}),
    AgentCallState.RINGING: frozenset({AgentCallState.IN_PROGRESS, AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED}),
    AgentCallState.IN_PROGRESS: frozenset({AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED}),
    AgentCallState.COMPLETED: frozenset(),
    AgentCallState.FAILED: frozenset(),
    AgentCallState.CANCELED: frozenset(),
}


TWILIO_STATUS_STATES = {
    "queued": AgentCallState.QUEUED,
    "initiated": AgentCallState.DIALING,
    "ringing": AgentCallState.RINGING,
    "in-progress": AgentCallState.IN_PROGRESS,
    "completed": AgentCallState.COMPLETED,
    "busy": AgentCallState.FAILED,
    "no-answer": AgentCallState.FAILED,
    "failed": AgentCallState.FAILED,
    "canceled": AgentCallState.CANCELED,
}


def transition_call(call: AgentCall, target: AgentCallState, *, reason: str = "", at: datetime | None = None) -> AgentCall:
    if target == call.state:
        return call
    if target not in ALLOWED_TRANSITIONS[call.state]:
        raise InvalidCallTransition(f"Cannot transition AgentCall from {call.state.value} to {target.value}")
    changed_at = at or utc_now()
    updated = call.model_copy(deep=True)
    updated.transitions.append(CallTransition(from_state=call.state, to_state=target, at=changed_at, reason=reason))
    updated.state = target
    updated.updated_at = changed_at
    if target == AgentCallState.IN_PROGRESS and updated.started_at is None:
        updated.started_at = changed_at
    if target in {AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED}:
        updated.completed_at = changed_at
    return updated
