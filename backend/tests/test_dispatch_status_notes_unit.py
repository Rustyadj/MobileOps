"""Confirmation and status-note edits must preserve movement and scheduling data."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime, timezone

import server


class DispatchStatusNotesTest(unittest.IsolatedAsyncioTestCase):
    async def test_status_note_round_trip_for_both_directions(self):
        for direction in ("outbound", "inbound"):
            with self.subTest(direction=direction):
                doc = server.Dispatch(direction=direction, customer_name="Test", status="dispatched",
                                      scheduled_date=datetime(2026, 9, 10, tzinfo=timezone.utc),
                                      notes="Keep delivery instructions", date_confirmed=True).model_dump()

                async def find_one(*args, **kwargs):
                    return dict(doc)

                async def update_one(query, update):
                    doc.update(update["$set"])

                db = SimpleNamespace(dispatches=SimpleNamespace(find_one=find_one, update_one=update_one))
                with patch.object(server, "db", db):
                    saved = await server.assign_dispatch(doc["id"], server.DispatchAssignUpdate(
                        date_confirmed=False, status_note="  waiting on permit  "), None)
                    self.assertFalse(saved.date_confirmed)
                    self.assertEqual(saved.status_note, "waiting on permit")
                    self.assertEqual(saved.status, "dispatched")
                    self.assertEqual(saved.scheduled_date, datetime(2026, 9, 10, tzinfo=timezone.utc))
                    self.assertEqual(saved.notes, "Keep delivery instructions")
                    saved = await server.assign_dispatch(doc["id"], server.DispatchAssignUpdate(driver_name="Contact"), None)
                    self.assertFalse(saved.date_confirmed)
                    self.assertEqual(saved.status_note, "waiting on permit")
                    saved = await server.assign_dispatch(doc["id"], server.DispatchAssignUpdate(date_confirmed=True, status_note=""), None)
                    self.assertTrue(saved.date_confirmed)
                    self.assertEqual(saved.status_note, "")
                    saved = await server.assign_dispatch(doc["id"], server.DispatchAssignUpdate(scheduled_date=None), None)
                    self.assertFalse(saved.date_confirmed)
                    self.assertIsNone(saved.scheduled_date)
                    saved = await server.assign_dispatch(doc["id"], server.DispatchAssignUpdate(
                        scheduled_date=datetime(2026, 9, 11, tzinfo=timezone.utc), date_confirmed=False), None)
                    self.assertFalse(saved.date_confirmed)


if __name__ == "__main__":
    unittest.main()
