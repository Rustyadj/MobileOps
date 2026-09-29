from request_parser import match_equipment, parse_supply_requests


def parsed(text):
    return [(row.qty, row.item_name) for row in parse_supply_requests(text)]


def test_explicit_supply_asks_are_extracted_with_quantities():
    assert parsed("I need 6 more turnbuckles") == [(6, "turnbuckles")]
    assert parsed("i need a another shovel") == [(1, "shovel")]
    assert parsed("I need another shovel") == [(1, "shovel")]
    assert parsed("We need two walkboard brackets for the Ferris job tomorrow") == [(2, "walkboard brackets")]
    assert parsed("Need 12 strongbacks asap") == [(12, "strongbacks")]
    assert parsed("can we get 4 more handrails out at Crowley?") == [(4, "handrails")]
    assert parsed("Send us a couple extension cords please") == [(2, "extension cords")]
    assert parsed("we're out of zip ties") == [(1, "zip ties")]
    assert parsed("@Nathan I need 3 more DeWalt 9ah batteries") == [(3, "DeWalt 9ah batteries")]
    assert parsed("gonna need a generator") == [(1, "generator")]
    assert parsed("We are running low on 3/8\" bolts") == [(1, "3/8\" bolts")]
    assert parsed("I need 4 12' strongbacks") == [(4, "12' strongbacks")]


def test_multiple_items_in_one_ask():
    assert parsed("I need 6 turnbuckles and 2 shovels") == [(6, "turnbuckles"), (2, "shovels")]
    assert parsed("need 10 clips, 4 handrails & a rake") == [(10, "clips"), (4, "handrails"), (1, "rake")]


def test_chatter_and_non_supply_needs_are_ignored():
    for text in [
        "I need to leave early today",
        "we need help unloading",
        "Do we need more turnbuckles?",
        "Does anyone need a shovel?",
        "Nick needs the address",
        "I need you to call the GC",
        "Pour went great, heading back",
        "The crew needs 6 turnbuckles",  # third-person reports aren't asks
        "need to grab lunch",
        "I need a minute",
    ]:
        assert parsed(text) == [], text


def test_equipment_matching_links_only_unambiguous_items():
    catalog = [
        {"id": "a", "name": "Nudura G2 Green", "sku": "G2TB", "category": "turnbuckle"},
        {"id": "b", "name": "ReechCraft Turnbuckle", "sku": "RCTB", "category": "turnbuckle"},
        {"id": "c", "name": "DeWalt Chop Saw", "sku": "QR-1", "category": "tool"},
        {"id": "d", "name": "DeWalt Chop Saw", "sku": "QR-2", "category": "tool"},
        {"id": "e", "name": "Shoring Post", "sku": "SP-001", "category": "shoring_post"},
    ]
    assert match_equipment("turnbuckles", catalog) is None
    assert match_equipment("chop saws", catalog)["name"] == "DeWalt Chop Saw"
    assert match_equipment("shoring posts", catalog)["id"] == "e"
    assert match_equipment("shovel", catalog) is None
