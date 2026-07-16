from ledger.formatting import receipt_line


def test_formats_an_unrelated_receipt_line() -> None:
    assert receipt_line(1250) == "Ledger total: 12.50"
