from ledger import process_order


def main() -> int:
    return process_order([1250, 375, 99])


if __name__ == "__main__":
    print(main())
