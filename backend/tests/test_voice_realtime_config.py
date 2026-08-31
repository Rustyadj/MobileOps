from voice.config import VoiceConfig
from voice.realtime_bridge import ESCALATION_TOOL, RealtimeMediaBridge


class _Repository:
    pass


def test_realtime_defaults_to_mini_with_full_escalation_and_live_transcription(monkeypatch):
    for name in ("VOICE_REALTIME_MODEL", "VOICE_REALTIME_FULL_MODEL", "VOICE_TRANSCRIPTION_MODEL"):
        monkeypatch.delenv(name, raising=False)

    config = VoiceConfig.from_env()

    assert config.realtime_model == "gpt-realtime-2.1-mini"
    assert config.realtime_full_model == "gpt-realtime-2.1"
    assert config.transcription_model == "gpt-live-transcribe"


def test_session_exposes_only_the_constrained_escalation_tool():
    bridge = RealtimeMediaBridge(VoiceConfig(), _Repository())
    session = bridge._session_event({"job": "read-only context"})["session"]

    assert session["model"] == "gpt-realtime-2.1-mini"
    assert session["audio"]["input"]["transcription"]["model"] == "gpt-live-transcribe"
    assert [tool["name"] for tool in session["tools"]] == [ESCALATION_TOOL]
    assert session["tool_choice"] == "auto"
