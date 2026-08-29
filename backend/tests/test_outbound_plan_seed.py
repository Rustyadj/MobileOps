"""Static validation for the Bracing Outbound reminder import.

These checks intentionally avoid the live API: the imported plans must stay
planning-only data and must not create inventory ledger entries during tests.
"""
import json
from pathlib import Path


SEED_PATH = Path(__file__).resolve().parents[1] / "outbound_plan_seed.json"


def load_rows():
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def test_outbound_plan_seed_has_all_source_rows_and_stable_keys():
    rows = load_rows()
    keys = [row["source_key"] for row in rows]

    assert len(rows) == 17
    assert len(keys) == len(set(keys))
    assert all(key.startswith("bracing-outbound-") for key in keys)
    assert all(row["customer_name"] for row in rows)
    assert all(row["raw_text"] for row in rows)


def test_abbreviations_are_expanded_in_operator_facing_requirements():
    requirements = " ".join(
        requirement
        for row in load_rows()
        for requirement in row["requirements"]
    ).lower()

    assert "stiffbacks" in requirements
    assert "turnbuckles" in requirements
    assert "handrails" in requirements
    assert "extensions" in requirements
    assert "gen 1" in requirements
    assert "reechcraft" in requirements
    assert "walkboard brackets" in requirements


def test_uncertain_source_values_remain_explicit():
    rows = load_rows()

    assert any(not row["date_confirmed"] for row in rows)
    assert any("tentative" in " ".join(row["requirements"]).lower() for row in rows)
    salazar = next(row for row in rows if row["customer_name"] == "Salazar Grimes")
    assert salazar["source_date_text"] == "11.16.28?"
    assert salazar["scheduled_date"].startswith("2028-11-16")


def test_grande_saline_tracks_only_the_remaining_load():
    grande_saline = next(row for row in load_rows() if row["customer_name"] == "Grande Saline")

    assert grande_saline["status"] == "active_rental"
    assert grande_saline["requirements"] == [
        "60 × 20 ft stiffbacks remaining",
        "120 × Reechcraft turnbuckles remaining",
        "75 × walkboard brackets (Gen 1) remaining",
        "70 × handrails (Gen 1) remaining",
        "47 × Reechcraft extensions remaining",
    ]
    assert "70 × walkboard brackets" in grande_saline["notes"]
    assert "75 × handrails" in grande_saline["notes"]


def test_delivered_unreturned_jobs_are_active_rentals():
    rows = load_rows()
    delivered_jobs = {
        row["customer_name"]: row["status"]
        for row in rows
        if row["customer_name"] in {"Grande Saline", "Crowley"}
    }

    assert delivered_jobs == {
        "Grande Saline": "active_rental",
        "Crowley": "active_rental",
    }
