from __future__ import annotations

import base64
import hashlib
import hmac
from collections.abc import Mapping, Sequence


def _values(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Sequence):
        return [str(item) for item in value]
    return [str(value)]


def compute_twilio_signature(url: str, params: Mapping[str, object], auth_token: str) -> str:
    payload = url
    for name in sorted(params):
        for value in sorted(_values(params[name])):
            payload += name + value
    digest = hmac.new(auth_token.encode(), payload.encode(), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()


def validate_twilio_signature(url: str, params: Mapping[str, object], signature: str, auth_token: str) -> bool:
    if not signature or not auth_token:
        return False
    expected = compute_twilio_signature(url, params, auth_token)
    return hmac.compare_digest(expected, signature)
