from ledger import g


def test_rounds_order_total() -> None:
    assert g([200, -25, 75]) == 275
