#!/usr/bin/env python3
import json
import sys


def main():
    args = sys.argv[1:]
    if len(args) != 6 or args[0] != "-extract" or args[2:5] != ["raw", "-o", "-"]:
        return 2

    with open(args[5], "r", encoding="utf-8") as manifest_file:
        value = json.load(manifest_file)
    for part in args[1].split("."):
        value = value[part]
    if isinstance(value, bool):
        value = "true" if value else "false"
    elif not isinstance(value, (str, int, float)):
        return 1
    sys.stdout.write(str(value))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
