"""Provider metadata contract and freshness fallback tests."""

from datetime import datetime, timedelta, timezone
import gzip
import unittest
from unittest.mock import patch
from uuid import uuid4

from projection_sources.cache import nflverse_csv
from projection_sources.context import _is_source_stale


class FakeResponse:
    def __init__(self, content=b"", payload=None, status_error=None):
        self.content = content
        self._payload = payload
        self._status_error = status_error

    def raise_for_status(self):
        if self._status_error:
            raise self._status_error

    def json(self):
        return self._payload


class NflverseProviderMetadataTest(unittest.TestCase):
    def _feed(self, timestamp_response):
        unique = uuid4().hex
        filename = f"metadata_contract_{unique}.csv.gz"
        data_response = FakeResponse(gzip.compress(
            b"player_id,week,passing_yards,rushing_yards,receiving_yards\n"
            b"123,1,200,10,0\n"))
        with patch("projection_sources.cache._HTTP.get",
                   side_effect=[data_response, timestamp_response]):
            return nflverse_csv(f"test_asset_{unique}", filename)

    def test_source_timestamp_is_preserved_when_provider_supplies_it(self):
        rows, metadata = self._feed(FakeResponse(payload={"last_updated": "2026-10-06 11:55:18 EDT"}))
        self.assertEqual(rows[0]["passing_yards"], "200")
        self.assertEqual(metadata["source_updated_at"], "2026-10-06 11:55:18 EDT")
        retrieved = datetime.fromisoformat(metadata["retrieved_at"].replace("Z", "+00:00"))
        self.assertIsNotNone(retrieved.tzinfo)

    def test_source_timestamp_may_be_null_when_provider_has_no_timestamp_asset(self):
        rows, metadata = self._feed(FakeResponse(status_error=RuntimeError("timestamp asset not found")))
        self.assertEqual(rows[0]["player_id"], "123")
        self.assertIsNone(metadata["source_updated_at"])
        self.assertTrue(metadata["available"])
        retrieved = datetime.fromisoformat(metadata["retrieved_at"].replace("Z", "+00:00"))
        self.assertIsNotNone(retrieved.tzinfo)

    def test_missing_source_time_uses_retrieval_time_for_freshness(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(minutes=5)).isoformat()
        old = (now - timedelta(hours=37)).isoformat()
        self.assertFalse(_is_source_stale(None, recent, now))
        self.assertTrue(_is_source_stale(None, old, now))

    def test_provider_time_remains_freshness_basis_when_available(self):
        now = datetime.now(timezone.utc)
        old_source = (now - timedelta(hours=37)).isoformat()
        recent_fetch = (now - timedelta(minutes=5)).isoformat()
        self.assertTrue(_is_source_stale(old_source, recent_fetch, now))


if __name__ == "__main__":
    unittest.main()
