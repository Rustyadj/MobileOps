from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlparse


@dataclass(frozen=True)
class VoiceConfig:
    twilio_account_sid: str = ""
    twilio_auth_token: str = ""
    twilio_api_key_sid: str = ""
    twilio_api_key_secret: str = ""
    twilio_phone_number: str = ""
    openai_api_key: str = ""
    public_base_url: str = ""
    realtime_model: str = "gpt-realtime-2.1"
    realtime_voice: str = "marin"
    transcription_model: str = "gpt-live-transcribe"

    @classmethod
    def from_env(cls) -> "VoiceConfig":
        return cls(
            twilio_account_sid=os.environ.get("TWILIO_ACCOUNT_SID", "").strip(),
            twilio_auth_token=os.environ.get("TWILIO_AUTH_TOKEN", "").strip(),
            twilio_api_key_sid=os.environ.get("TWILIO_API_KEY_SID", "").strip(),
            twilio_api_key_secret=os.environ.get("TWILIO_API_KEY_SECRET", "").strip(),
            twilio_phone_number=os.environ.get("TWILIO_PHONE_NUMBER", "").strip(),
            openai_api_key=os.environ.get("OPENAI_API_KEY", "").strip(),
            public_base_url=os.environ.get("VOICE_PUBLIC_BASE_URL", "").strip().rstrip("/"),
            realtime_model=os.environ.get("VOICE_REALTIME_MODEL", "gpt-realtime-2.1").strip(),
            realtime_voice=os.environ.get("VOICE_REALTIME_VOICE", "marin").strip(),
            transcription_model=os.environ.get("VOICE_TRANSCRIPTION_MODEL", "gpt-live-transcribe").strip(),
        )

    def missing_for_outbound_call(self) -> list[str]:
        required = {
            "TWILIO_ACCOUNT_SID": self.twilio_account_sid,
            "TWILIO_AUTH_TOKEN": self.twilio_auth_token,
            "TWILIO_API_KEY_SID": self.twilio_api_key_sid,
            "TWILIO_API_KEY_SECRET": self.twilio_api_key_secret,
            "TWILIO_PHONE_NUMBER": self.twilio_phone_number,
            "OPENAI_API_KEY": self.openai_api_key,
            "VOICE_PUBLIC_BASE_URL": self.public_base_url,
        }
        missing = [name for name, value in required.items() if not value]
        if self.public_base_url and urlparse(self.public_base_url).scheme != "https":
            missing.append("VOICE_PUBLIC_BASE_URL (must use https)")
        return missing

    def http_url(self, path: str) -> str:
        return f"{self.public_base_url}/{path.lstrip('/')}"

    def websocket_url(self, path: str) -> str:
        parsed = urlparse(self.public_base_url)
        return f"wss://{parsed.netloc}/{path.lstrip('/')}"
