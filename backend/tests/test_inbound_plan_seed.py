"""Static validation for the Bracing Inbound reminder import."""
import json
from pathlib import Path


SEED_PATH = Path(__file__).resolve().parents[1] / "inbound_plan_seed.json"


def load_rows():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def test_inbound_plan_seed_has_all_source_rows_and_stable_keys():
    rows = load_rows()
    keys = [row["source_key"] for row in rows]

    assert len(rows) == 11
    assert len(keys) == len(set(keys))
    assert all(key.startswith("bracing-inbound-") for key in keys)
    assert all(row["customer_name"] for row in rows)
    assert all(row["raw_text"] for row in rows)


def test_uncertain_inbound_values_are_not_presented_as_confirmed():
    rows = load_rows()

    assert any(row["scheduled_date"] is None for row in rows)
    assert any(not row["date_confirmed"] for row in rows)
    assert any("count pending" in " ".join(row["requirements"]).lower() for row in rows)
    assert any("tentative" in " ".join(row["requirements"]).lower() for row in rows)


def test_pickup_and_verification_states_are_preserved():
    rows = load_rows()
    by_customer = {row["customer_name"]: row for row in rows}

    assert by_customer["Granbury AL"]["status"] == "ready_for_pickup"
    assert by_customer["Shelter"]["status"] == "picked_up_needs_verification"
    assert by_customer["Monster Mark"]["status"] == "picked_up_needs_verification"
    assert "verify counts and damages" in by_customer["Shelter"]["notes"].lower()


def test_inbound_abbreviations_are_expanded_for_operators():
    requirements = " ".join(
        requirement
        for row in load_rows()
        for requirement in row["requirements"]
    ).lower()

    assert "stiffbacks" in requirements
    assert "turnbuckles" in requirements
    assert "walkboard brackets" in requirements
    assert "handrails" in requirements
    assert "extensions" in requirements
    assert "gen 1" in requirements
