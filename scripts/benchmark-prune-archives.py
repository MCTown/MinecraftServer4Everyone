#!/usr/bin/env python3
"""Remove verified workspace archives while keeping every measurement artifact.

An archive is deleted only when its bytes still match the recorded SHA-256 and
`workspace-artifact.json` says it was verified readable. The deletion is then
recorded in that file (`pruned`), so the audit can distinguish a deliberate
disk-space reclamation from a trial whose archive was never produced.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
ARCHIVE = 'workspace.tar.gz'


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def plan(root):
    rows = []
    for archive in sorted(root.rglob(ARCHIVE)):
        run = archive.parent
        artifact_file = run / 'workspace-artifact.json'
        artifact = suite.read_json(artifact_file)
        if not isinstance(artifact, dict) or not artifact.get('verifiedReadable'):
            raise RuntimeError(f'archive was never proven readable: {archive}')
        actual = digest(archive)
        if actual != artifact.get('sha256'):
            raise RuntimeError(f'archive no longer matches its recorded digest: {archive}')
        rows.append({'archive': str(archive), 'artifact': str(artifact_file),
                     'bytes': archive.stat().st_size, 'sha256': actual})
    return rows


def prune(root, apply=False):
    rows = plan(root)
    # Refuse a partial deletion: the plan is fully verified before any write.
    for row in rows:
        if not apply:
            continue
        artifact_file = pathlib.Path(row['artifact'])
        artifact = suite.read_json(artifact_file)
        artifact['pruned'] = {'prunedAt': suite.iso(), 'sha256': row['sha256'],
                              'bytes': row['bytes'], 'verifiedReadableBeforePrune': True,
                              'reason': 'verified archive removed to reclaim disk space; measurements retained'}
        suite.save(artifact_file, artifact)
        pathlib.Path(row['archive']).unlink()
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default=str(PROJECT / 'exp'))
    parser.add_argument('--apply', action='store_true')
    options = parser.parse_args()
    rows = prune(pathlib.Path(options.root), options.apply)
    payload = {'checkedAt': suite.iso(), 'applied': options.apply, 'count': len(rows),
               'bytes': sum(row['bytes'] for row in rows), 'archives': rows}
    suite.save(PROJECT / ('exp/archive-prune' + ('' if options.apply else '-plan') + '.json'), payload)
    print(json.dumps({'applied': options.apply, 'count': len(rows), 'gib': round(sum(r['bytes'] for r in rows) / 1024 ** 3, 2)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
