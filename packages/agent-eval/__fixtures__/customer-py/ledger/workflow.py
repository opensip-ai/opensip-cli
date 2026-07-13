from ledger import g

from .formatting import receipt_line


def process_order(amounts: list[int]) -> int:
    total = g(amounts)
    receipt_line(total)
    return total
