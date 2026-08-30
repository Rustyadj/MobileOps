from datetime import datetime, timezone
import unittest

from voice.models import AgentCall, AgentCallState
from voice.state_machine import InvalidCallTransition, transition_call


def make_call() -> AgentCall:
    return AgentCall(
        target_type="rental",
        target_id="rental-test",
        destination_phone="+12125550123",
        requested_by_id="user-test",
        requested_by_name="Test User",
    )


class AgentCallStateMachineTests(unittest.TestCase):
    def test_happy_path_transitions_and_timestamps(self):
        call = make_call()
        call = transition_call(call, AgentCallState.QUEUED)
        call = transition_call(call, AgentCallState.DIALING)
        call = transition_call(call, AgentCallState.RINGING)
        started = datetime(2026, 8, 30, tzinfo=timezone.utc)
        call = transition_call(call, AgentCallState.IN_PROGRESS, at=started)
        call = transition_call(call, AgentCallState.COMPLETED)

        self.assertEqual(call.state, AgentCallState.COMPLETED)
        self.assertEqual(call.started_at, started)
        self.assertIsNotNone(call.completed_at)
        self.assertEqual([item.to_state for item in call.transitions], [
            AgentCallState.QUEUED,
            AgentCallState.DIALING,
            AgentCallState.RINGING,
            AgentCallState.IN_PROGRESS,
            AgentCallState.COMPLETED,
        ])

    def test_terminal_states_cannot_transition(self):
        for terminal in (AgentCallState.COMPLETED, AgentCallState.FAILED, AgentCallState.CANCELED):
            with self.subTest(terminal=terminal):
                call = transition_call(make_call(), AgentCallState.QUEUED)
                if terminal == AgentCallState.COMPLETED:
                    call = transition_call(call, AgentCallState.DIALING)
                    call = transition_call(call, AgentCallState.IN_PROGRESS)
                call = transition_call(call, terminal)
                with self.assertRaises(InvalidCallTransition):
                    transition_call(call, AgentCallState.IN_PROGRESS)

    def test_rejects_skipped_transition_and_allows_duplicate_event(self):
        call = make_call()
        with self.assertRaises(InvalidCallTransition):
            transition_call(call, AgentCallState.IN_PROGRESS)
        queued = transition_call(call, AgentCallState.QUEUED)
        self.assertIs(transition_call(queued, AgentCallState.QUEUED), queued)

    def test_provider_may_skip_forward_status_callbacks(self):
        queued = transition_call(make_call(), AgentCallState.QUEUED)
        completed = transition_call(queued, AgentCallState.COMPLETED)
        self.assertEqual(completed.state, AgentCallState.COMPLETED)


if __name__ == "__main__":
    unittest.main()
