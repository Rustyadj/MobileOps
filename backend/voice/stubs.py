"""Deliberately non-functional seams for later voice phases."""

from __future__ import annotations

from typing import Protocol


class VoiceFeatureNotEnabled(NotImplementedError):
    pass


class ToolCallHandler(Protocol):
    async def execute(self, name: str, arguments: dict) -> dict: ...


class ConfirmationWorkflow(Protocol):
    async def request_confirmation(self, action: dict) -> dict: ...


class OperationalPoster(Protocol):
    async def post(self, destination: str, payload: dict) -> None: ...


class KnowledgeProvider(Protocol):
    async def retrieve(self, query: str) -> list[dict]: ...


class EscalationPolicy(Protocol):
    async def choose_model(self, context: dict) -> str: ...


class VoicemailPolicy(Protocol):
    async def handle(self, call: dict) -> None: ...


class AutoCallPolicy(Protocol):
    async def schedule(self, trigger: dict) -> None: ...


class CostReporter(Protocol):
    async def report(self, usage: dict) -> None: ...
