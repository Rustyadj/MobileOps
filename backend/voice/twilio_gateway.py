from __future__ import annotations

from urllib.parse import urlencode

import httpx

from .config import VoiceConfig


class TwilioCallError(RuntimeError):
    pass


class TwilioVoiceGateway:
    def __init__(self, config: VoiceConfig):
        self.config = config

    async def create_call(self, *, call_id: str, destination_phone: str) -> dict:
        endpoint = f"https://api.twilio.com/2010-04-01/Accounts/{self.config.twilio_account_sid}/Calls.json"
        answer_url = self.config.http_url(f"api/voice/twilio/answer?call_id={call_id}")
        status_url = self.config.http_url(f"api/voice/twilio/status?call_id={call_id}")
        form = [
            ("To", destination_phone),
            ("From", self.config.twilio_phone_number),
            ("Url", answer_url),
            ("Method", "POST"),
            ("StatusCallback", status_url),
            ("StatusCallbackMethod", "POST"),
            ("StatusCallbackEvent", "initiated"),
            ("StatusCallbackEvent", "ringing"),
            ("StatusCallbackEvent", "answered"),
            ("StatusCallbackEvent", "completed"),
        ]
        auth = httpx.BasicAuth(self.config.twilio_api_key_sid, self.config.twilio_api_key_secret)
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.post(
                    endpoint,
                    content=urlencode(form),
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    auth=auth,
                )
        except httpx.HTTPError as exc:
            raise TwilioCallError("Twilio call creation could not reach the provider") from exc
        if response.status_code >= 400:
            raise TwilioCallError(f"Twilio call creation failed with HTTP {response.status_code}")
        payload = response.json()
        if not payload.get("sid"):
            raise TwilioCallError("Twilio call creation returned no call SID")
        return {"sid": payload["sid"], "status": payload.get("status", "queued")}
