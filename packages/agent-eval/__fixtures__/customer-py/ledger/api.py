from ledger import process_order


def create_order(payload: dict[str, list[int]]) -> dict[str, int]:
    return {"total_cents": process_order(payload["amounts"])}
