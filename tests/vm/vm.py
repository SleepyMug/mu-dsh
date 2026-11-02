#!/usr/bin/env python3
"""mu-dsh VM test driver.

  vm.py build-base [--force]   build (or rebuild) the prepared base image
  vm.py test [-k PATTERN] [--keep]   (-k runs tests up to the last match)
                               boot a fresh VM from the base image, run the
                               system tests, and shut it down (--keep leaves
                               it running for inspection)
  vm.py up                     boot a fresh VM and leave it running
  vm.py ssh [COMMAND...]       shell into the running VM
  vm.py down                   stop the running VM
"""

from __future__ import annotations

import argparse
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import vmlib  # noqa: E402


def cmd_build_base(args) -> int:
    vmlib.build_base(force=args.force)
    return 0


def cmd_up(args) -> int:
    vm = vmlib.boot_fresh()
    print(f"VM running: ssh port {vm.ssh_port}, gateway http://127.0.0.1:{vm.http_port}/ (vm.py ssh / vm.py down)")
    return 0


def cmd_ssh(args) -> int:
    vm = vmlib.VM.load()
    if vm is None:
        print("no VM running (vm.py up)", file=sys.stderr)
        return 1
    os.execvp("ssh", vm.ssh_argv("-t") + args.command)


def cmd_down(args) -> int:
    vm = vmlib.VM.load()
    if vm is None:
        print("no VM running")
        return 0
    vm.poweroff()
    return 0


def cmd_test(args) -> int:
    os.environ["MU_DSH_VM_KEEP"] = "1" if args.keep else ""
    suite = unittest.TestLoader().discover(str(Path(__file__).resolve().parent), pattern="test_*.py")
    if args.k:
        # The system tests build on each other in name order, so a selection
        # runs everything up to and including the last matching test.
        tests = sorted(_flatten(suite), key=lambda t: t.id())
        matches = [i for i, t in enumerate(tests) if any(p in t.id() for p in args.k)]
        if not matches:
            print(f"no test matches {args.k}", file=sys.stderr)
            return 1
        suite = unittest.TestSuite(tests[: matches[-1] + 1])
    result = unittest.TextTestRunner(verbosity=2, failfast=not args.no_failfast).run(suite)
    return 0 if result.wasSuccessful() else 1


def _flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten(item)
        else:
            yield item


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)
    b = sub.add_parser("build-base")
    b.add_argument("--force", action="store_true")
    b.set_defaults(func=cmd_build_base)
    t = sub.add_parser("test")
    t.add_argument("-k", action="append", help="run tests up to the last one whose name contains this (repeatable)")
    t.add_argument("--keep", action="store_true", help="leave the VM running afterwards")
    t.add_argument("--no-failfast", action="store_true", help="keep going after the first failure")
    t.set_defaults(func=cmd_test)
    sub.add_parser("up").set_defaults(func=cmd_up)
    s = sub.add_parser("ssh")
    s.add_argument("command", nargs=argparse.REMAINDER)
    s.set_defaults(func=cmd_ssh)
    sub.add_parser("down").set_defaults(func=cmd_down)
    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
