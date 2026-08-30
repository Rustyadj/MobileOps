from __future__ import annotations

from html import escape

from fastapi import APIRouter, Depends, HTTPException, Request, Response, WebSocket

from .config import VoiceConfig
from .models import AgentCall, AgentCallCreate, AgentCallState
from .realtime_bridge import RealtimeMediaBridge
from .repository import AgentCallRepository
from .service import AgentCallService, VoiceConfigurationError, VoiceTargetNotFound
from .signatures import validate_twilio_signature
from .state_machine import TWILIO_STATUS_STATES
from .twilio_gateway import TwilioCallError, TwilioVoiceGateway


def create_voice_router(host, config: VoiceConfig) -> tuple[APIRouter, AgentCallRepository]:
    router = APIRouter(prefix="/api/voice", tags=["voice"])
    repository = AgentCallRepository(host.db)
    service = AgentCallService(host.db, config, repository, TwilioVoiceGateway(config))
    bridge = RealtimeMediaBridge(config, repository)

    def public_request_url(request: Request) -> str:
        suffix = request.url.path
        if request.url.query:
            suffix += f"?{request.url.query}"
        return config.http_url(suffix)

    async def validated_form(request: Request) -> dict[str, str]:
        form = await request.form()
        params = {key: str(value) for key, value in form.multi_items()}
        signature = request.headers.get("X-Twilio-Signature", "")
        if not validate_twilio_signature(public_request_url(request), params, signature, config.twilio_auth_token):
            raise HTTPException(403, "Invalid Twilio signature")
        return params

    @router.post("/calls", response_model=AgentCall, status_code=201)
    async def create_call(body: AgentCallCreate, user=Depends(host.require_role(host.Role.foreman))):
        try:
            return await service.create(body, user)
        except VoiceConfigurationError as exc:
            raise HTTPException(503, {"message": "Voice calling is not configured", "missing": exc.missing}) from exc
        except VoiceTargetNotFound as exc:
            raise HTTPException(404, str(exc)) from exc
        except TwilioCallError as exc:
            raise HTTPException(502, str(exc)) from exc

    @router.get("/calls/{call_id}", response_model=AgentCall)
    async def get_call(call_id: str, _=Depends(host.get_current_user)):
        call = await service.get(call_id)
        if call is None:
            raise HTTPException(404, "Call not found")
        return call

    @router.post("/twilio/answer")
    async def answer_call(request: Request, call_id: str):
        await validated_form(request)
        call = await repository.get(call_id)
        if call is None:
            raise HTTPException(404, "Call not found")
        await repository.transition(call_id, AgentCallState.IN_PROGRESS, reason="Twilio answered")
        stream_url = escape(config.websocket_url(f"api/voice/media/{call_id}"), quote=True)
        twiml = f'<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="{stream_url}" /></Connect></Response>'
        return Response(twiml, media_type="application/xml")

    @router.post("/twilio/status")
    async def call_status(request: Request, call_id: str):
        params = await validated_form(request)
        call = await repository.get(call_id)
        if call is None:
            raise HTTPException(404, "Call not found")
        if params.get("CallSid") and call.twilio_call_sid and params["CallSid"] != call.twilio_call_sid:
            raise HTTPException(409, "Call SID does not match")
        target = TWILIO_STATUS_STATES.get(params.get("CallStatus", "").lower())
        if target:
            await repository.transition(call_id, target, reason=f"Twilio status: {params.get('CallStatus', '')}")
        duration = int(params.get("CallDuration", "0") or 0)
        if duration:
            # Status callbacks may be retried; setting the authoritative
            # Twilio duration keeps retries idempotent.
            await repository.set_fields(call_id, {"usage.duration_seconds": duration})
        return {"ok": True}

    @router.websocket("/media/{call_id}")
    async def media_stream(socket: WebSocket, call_id: str):
        signature = socket.headers.get("X-Twilio-Signature", "")
        signed_url = config.websocket_url(f"api/voice/media/{call_id}")
        if not validate_twilio_signature(signed_url, {}, signature, config.twilio_auth_token):
            await socket.close(code=1008)
            return
        await socket.accept()
        await bridge.run(socket, call_id)

    return router, repository
