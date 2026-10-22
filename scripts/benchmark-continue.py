#!/usr/bin/env python3
"""Wait for the first isolated trial, verify teardown, then resume the matrix."""
import argparse
import importlib.util
import json
import os
import pathlib
import select
import subprocess

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wait-pid', type=int, required=True)
    args = parser.parse_args()
    root = PROJECT / 'exp'
    first = root / 'the-pixelmon-modpack/MCT-full'
    try:
        fd = os.pidfd_open(args.wait_pid)
    except ProcessLookupError:
        pass
    else:
        print('WAIT first-trial runner exit', args.wait_pid, flush=True)
        try:
            select.select([fd], [], [])
        finally:
            os.close(fd)
    summary = suite.read_json(first / 'summary.json', {})
    setup = suite.read_json(first / 'setup.json', {})
    artifact = suite.read_json(first / 'workspace-artifact.json', {})
    archive = first / 'workspace.tar.gz'
    errors = []
    if not summary.get('cleanup', {}).get('passed'):
        errors.append('first trial cleanup not proven')
    if not artifact.get('verifiedReadable') or not archive.is_file():
        errors.append('first trial archive not proven')
    elif suite.sha(archive) != artifact.get('sha256'):
        errors.append('first trial archive hash mismatch')
    if setup.get('workspace') and suite.processes(pathlib.Path(setup['workspace'])):
        errors.append('first trial processes remain')
    if suite.occupied(8801) or suite.occupied(25700):
        errors.append('first trial ports still occupied')
    for filename in ('evidence.json', 'timings.json', 'usage.json', 'llm-grade.json', 'runner-result.json'):
        if not (first / filename).is_file():
            errors.append('missing first trial artifact: ' + filename)
    if (first / 'infrastructure-checkpoint.json').exists():
        errors.append('first trial marked infrastructure-invalid')
    suite.save(root / 'continuation-checkpoint.json', {'checkedAt': suite.iso(), 'waitedForPid': args.wait_pid, 'passed': not errors, 'errors': errors, 'firstTrialChecks': summary.get('checks')})
    if errors:
        raise RuntimeError('; '.join(errors))
    print('GATE PASSED: cleanup, ports, archive and evidence; resuming all 21 conditions (completed first is skipped)', flush=True)
    try:
        subprocess.run(['python3', '-u', 'scripts/benchmark-suite.py'], cwd=PROJECT, check=True)
    finally:
        subprocess.run(['python3', 'scripts/benchmark-report.py', '--verify-hashes'], cwd=PROJECT, check=True)


if __name__ == '__main__':
    main()
