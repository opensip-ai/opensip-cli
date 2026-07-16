from ledger import process_order


def test_processes_order_through_public_package() -> None:
    assert process_order([100, 250]) == 350
