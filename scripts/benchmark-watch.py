#!/usr/bin/env python3
"""Event-driven notification after one trial's summary AND archive are durable."""
import argparse
import ctypes
import json
import os
import pathlib
import select


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('trial', type=pathlib.Path)
    args = parser.parse_args()
    trial = args.trial.resolve()
    root = pathlib.Path(__file__).resolve().parent.parent / 'exp'
    if not trial.is_relative_to(root):
        raise ValueError('Only benchmark result directories can be watched')
    libc = ctypes.CDLL(None, use_errno=True)
    fd = libc.inotify_init1(os.O_CLOEXEC | os.O_NONBLOCK)
    if fd < 0:
        raise OSError(ctypes.get_errno(), 'inotify_init1')
    watch = libc.inotify_add_watch
    watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
    # Subscribe before testing files; root/descendant events install deeper watches.
    watched = set()
    try:
        while True:
            for directory in (root, trial.parent, trial):
                if directory not in watched and directory.is_dir():
                    if watch(fd, os.fsencode(directory), 0x100 | 0x80 | 0x8) < 0:
                        raise OSError(ctypes.get_errno(), 'inotify_add_watch')
                    watched.add(directory)
            if (trial / 'summary.json').is_file() and (trial / 'workspace-artifact.json').is_file():
                summary = json.loads((trial / 'summary.json').read_text())
                artifact = json.loads((trial / 'workspace-artifact.json').read_text())
                print(json.dumps({'trial': str(trial), 'summary': summary, 'archive': artifact}, ensure_ascii=False), flush=True)
                return
            select.select([fd], [], [])
            try:
                os.read(fd, 1024 * 1024)
            except BlockingIOError:
                pass
    finally:
        os.close(fd)


if __name__ == '__main__':
    main()
