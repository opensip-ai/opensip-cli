def parse_int(value):
    try:
        return int(value)
    except ValueError:
        return 0
