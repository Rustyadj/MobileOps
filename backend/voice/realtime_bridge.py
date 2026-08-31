from __future__ import annotations

import asyncio
import json
from contextlib import suppress
from urllib.parse import quote

from websockets.asyncio.client import connect

from .config import VoiceConfig
from .models import AgentCallState, CallUsage, TranscriptTurn
from .repository import AgentCallRepository

ESCALATION_TOOL = "escalate_reasoning"


class RealtimeMediaBridge:
    def __init__(self, config: VoiceConfig, repository: AgentCallRepository):
        self.config = config
        self.repository = repository

    async def run(self, twilio_socket, call_id: str) -> None:
        call = await self.repository.get(call_id)
        if call is None:
            await twilio_socket.close(code=1008)
            return
        url = f"wss://api.openai.com/v1/realtime?model={quote(self.config.realtime_model)}"
        headers = {"Authorization": f"Bearer {self.config.openai_api_key}"}
        try:
            async with connect(url, additional_headers=headers, max_size=16 * 1024 * 1024) as openai_socket:
                await openai_socket.send(json.dumps(self._session_event(call.operational_context)))
                await self.repository.transition(call_id, AgentCallState.IN_PROGRESS, reason="Media stream connected")
                stream = {
                    "sid": None,
                    "latest_ms": 0,
                    "assistant_started_ms": None,
                    "assistant_item_id": None,
                    "intro_sent": False,
                    "escalated": False,
                    "escalated_response_started": False,
                }
                tasks = [
                    asyncio.create_task(self._twilio_to_openai(twilio_socket, openai_socket, call_id, stream)),
                    asyncio.create_task(self._openai_to_twilio(twilio_socket, openai_socket, call_id, stream)),
                ]
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in pending:
                    task.cancel()
                for task in done:
                    task.result()
                for task in pending:
                    with suppress(asyncio.CancelledError):
                        await task
        except Exception as exc:
            await self.repository.set_fields(call_id, {"last_error": f"Realtime bridge: {str(exc)[:450]}"})
            await self.repository.transition(call_id, AgentCallState.FAILED, reason="Realtime media bridge failed")

    def _session_event(self, context: dict) -> dict:
        context_text = json.dumps(context, default=str, ensure_ascii=False)
        return {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "model": self.config.realtime_model,
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcmu"},
                        "transcription": {"model": self.config.transcription_model},
                        "turn_detection": {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 500},
                    },
                    "output": {"format": {"type": "audio/pcmu"}, "voice": self.config.realtime_voice},
                },
                "instructions": (
                    "You are Nathan, the MobileOps voice assistant. Be warm, concise, and natural. "
                    "Start by saying you are Nathan with MobileOps and briefly state why you are calling. "
                    "Have a short back-and-forth and never claim an operational action was taken. "
                    "Tool calls, confirmations, posting, RAG, escalation, voicemail, and autocalls are disabled. "
                    f"Use the {ESCALATION_TOOL} tool before answering only when the current turn genuinely "
                    "requires multi-step reasoning, difficult tradeoffs, ambiguous synthesis, or high-impact "
                    "judgment. Do not escalate routine conversation or for length alone. "
                    f"Relevant read-only operational context: {context_text}"
                ),
                "tools": [{
                    "type": "function",
                    "name": ESCALATION_TOOL,
                    "description": (
                        "Temporarily switch this turn from the fast Mini model to the full Realtime 2.1 model. "
                        "Use only for genuinely complex reasoning."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {"reason": {"type": "string"}},
                        "required": ["reason"],
                        "additionalProperties": False,
                    },
                }],
                "tool_choice": "auto",
            },
        }

    async def _twilio_to_openai(self, twilio_socket, openai_socket, call_id: str, stream: dict) -> None:
        while True:
            event = json.loads(await twilio_socket.receive_text())
            kind = event.get("event")
            if kind == "start":
                stream["sid"] = event.get("start", {}).get("streamSid") or event.get("streamSid")
                await self.repository.set_fields(call_id, {"twilio_stream_sid": stream["sid"]})
            elif kind == "media":
                media = event.get("media", {})
                stream["latest_ms"] = int(media.get("timestamp", stream["latest_ms"]))
                await openai_socket.send(json.dumps({"type": "input_audio_buffer.append", "audio": media.get("payload", "")}))
            elif kind == "stop":
                return

    async def _openai_to_twilio(self, twilio_socket, openai_socket, call_id: str, stream: dict) -> None:
        async for raw in openai_socket:
            event = json.loads(raw)
            kind = event.get("type")
            if kind == "session.updated" and not stream["intro_sent"]:
                stream["intro_sent"] = True
                await openai_socket.send(json.dumps({"type": "response.create"}))
            elif kind == "response.output_item.added":
                item = event.get("item", {})
                if item.get("role") == "assistant":
                    stream["assistant_item_id"] = item.get("id")
            elif kind == "response.output_audio.delta" and stream["sid"]:
                if stream["assistant_started_ms"] is None:
                    stream["assistant_started_ms"] = stream["latest_ms"]
                await twilio_socket.send_json({"event": "media", "streamSid": stream["sid"], "media": {"payload": event.get("delta", "")}})
            elif kind == "input_audio_buffer.speech_started" and stream["sid"]:
                await twilio_socket.send_json({"event": "clear", "streamSid": stream["sid"]})
                if stream["assistant_item_id"] and stream["assistant_started_ms"] is not None:
                    played = max(0, stream["latest_ms"] - stream["assistant_started_ms"])
                    await openai_socket.send(json.dumps({"type": "conversation.item.truncate", "item_id": stream["assistant_item_id"], "content_index": 0, "audio_end_ms": played}))
                stream["assistant_started_ms"] = None
            elif kind in {"conversation.item.input_audio_transcription.completed", "conversation.item.input_audio_transcription.done"}:
                text = event.get("transcript") or event.get("text") or ""
                if text.strip():
                    await self.repository.append_transcript(call_id, TranscriptTurn(role="caller", text=text.strip()))
            elif kind == "response.output_audio_transcript.done":
                text = event.get("transcript") or event.get("text") or ""
                if text.strip():
                    await self.repository.append_transcript(call_id, TranscriptTurn(role="nathan", text=text.strip()))
                stream["assistant_started_ms"] = None
            elif kind == "response.created" and stream["escalated"]:
                stream["escalated_response_started"] = True
            elif kind in {"response.function_call_arguments.done", "response.output_item.done"}:
                item = event.get("item", {}) or {}
                name = event.get("name") or item.get("name")
                call_id = event.get("call_id") or item.get("call_id")
                if name == ESCALATION_TOOL and call_id and not stream["escalated"]:
                    stream["escalated"] = True
                    stream["escalated_response_started"] = False
                    await openai_socket.send(json.dumps({
                        "type": "session.update",
                        "session": {
                            "type": "realtime",
                            "model": self.config.realtime_full_model,
                            "tool_choice": "none",
                        },
                    }))
                    await openai_socket.send(json.dumps({
                        "type": "conversation.item.create",
                        "item": {
                            "type": "function_call_output",
                            "call_id": call_id,
                            "output": json.dumps({"switched": True, "model": self.config.realtime_full_model}),
                        },
                    }))
                    await openai_socket.send(json.dumps({
                        "type": "response.create",
                        "response": {
                            "instructions": (
                                "Answer the current caller turn with the required deeper reasoning. "
                                "Do not call the escalation tool again."
                            ),
                        },
                    }))
            elif kind == "response.done":
                usage = event.get("response", {}).get("usage", {}) or {}
                input_details = usage.get("input_token_details", {}) or {}
                output_details = usage.get("output_token_details", {}) or {}
                await self.repository.add_usage(call_id, CallUsage(
                    input_tokens=int(usage.get("input_tokens", 0)), output_tokens=int(usage.get("output_tokens", 0)),
                    total_tokens=int(usage.get("total_tokens", 0)), input_audio_tokens=int(input_details.get("audio_tokens", 0)),
                    output_audio_tokens=int(output_details.get("audio_tokens", 0)),
                ))
                if stream["escalated"] and stream["escalated_response_started"]:
                    stream["escalated"] = False
                    stream["escalated_response_started"] = False
                    await openai_socket.send(json.dumps({
                        "type": "session.update",
                        "session": {
                            "type": "realtime",
                            "model": self.config.realtime_model,
                            "tool_choice": "auto",
                        },
                    }))
