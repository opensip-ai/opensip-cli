from dataclasses import dataclass


@dataclass(frozen=True)
class Order:
    amounts: tuple[int, ...]
