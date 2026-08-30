import unittest

from voice.signatures import compute_twilio_signature, validate_twilio_signature


class TwilioSignatureTests(unittest.TestCase):
    def test_valid_twilio_webhook_signature(self):
        url = "https://voice.example.com/api/voice/twilio/status?call_id=call-123"
        params = {"CallSid": "CA123", "CallStatus": "completed", "CallDuration": "17"}
        signature = compute_twilio_signature(url, params, "test-auth-token")

        self.assertTrue(validate_twilio_signature(url, params, signature, "test-auth-token"))

    def test_invalid_twilio_webhook_signature(self):
        url = "https://voice.example.com/api/voice/twilio/status?call_id=call-123"
        params = {"CallSid": "CA123", "CallStatus": "completed"}

        self.assertFalse(validate_twilio_signature(url, params, "not-the-signature", "test-auth-token"))
        valid = compute_twilio_signature(url, params, "test-auth-token")
        self.assertFalse(validate_twilio_signature(url, {**params, "CallStatus": "failed"}, valid, "test-auth-token"))


if __name__ == "__main__":
    unittest.main()
