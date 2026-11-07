"""Forward an owner-supplied KREAM code to the waiting normal-user collector.

Codes must arrive through stdin, never argv, a file, a URL, GitHub or a log.
"""
import argparse
import json
from pathlib import Path
import sys

from kream_chat_bridge import BridgeError, send


class SafeParser(argparse.ArgumentParser):
    def error(self, message):
        raise BridgeError('invalid_arguments')


def main(argv=None):
    parser = SafeParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--status', action='store_true')
    action.add_argument('--submit', action='store_true')
    action.add_argument('--resend', action='store_true')
    code = None
    try:
        args = parser.parse_args(argv)
        if args.submit:
            # No prompt or echo: the ChatGPT agent writes only to process stdin.
            code = sys.stdin.readline(64).strip()
        result = send(Path(__file__).resolve().parents[1],
                      'submit_code' if args.submit else 'resend' if args.resend else 'status',
                      code=code)
        print(json.dumps(result, ensure_ascii=True, separators=(',', ':')), flush=True)
        return 0 if result.get('result') in ('status', 'accepted', 'already_received') else 2
    except BridgeError as error:
        print(json.dumps({'result': error.args[0]}, separators=(',', ':')), flush=True)
        return 2
    finally:
        code = None


if __name__ == '__main__':
    raise SystemExit(main())
