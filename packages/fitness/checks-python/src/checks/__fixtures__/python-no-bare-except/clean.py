def load_config(path):
    try:
        with open(path) as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except Exception:
        raise
