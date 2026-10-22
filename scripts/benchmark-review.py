#!/usr/bin/env python3
"""Independent post-run review; original evidence and model grades remain intact."""
import importlib.util
import json
import pathlib
import re

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


def review(folder):
    result = suite.read_json(folder / 'result.json', {})
    evidence = suite.read_json(folder / 'evidence.json', {})
    errors = []
    for turn in result.get('details', []):
        for call in turn.get('toolCalls', []):
            outcome = suite.command_outcome(call.get('output', ''))
            if outcome['error']:
                errors.append({'id': call.get('id'), 'name': call.get('name'), 'startedAt': call.get('startedAt'), **outcome})
    per_source = {}
    for filename in ('mcdr-current-launch.txt', 'minecraft-current-launch.txt'):
        source = folder / filename
        if not source.exists():
            continue
        text = source.read_text(errors='replace')
        lines = [line for line in text.splitlines() if re.search(r'\b(?:ERROR|FATAL)\b|NoClassDefFoundError|ClassNotFoundException', line)]
        per_source[filename] = {'count': len(lines), 'lines': lines[-40:]}
    # Prefer current owned output, which contains both MCDR and Java events.
    owned = bool(evidence.get('ownedLaunch'))
    primary = 'mcdr-current-launch.txt' if owned else 'minecraft-current-launch.txt'
    primary_count = per_source.get(primary, {}).get('count')
    out = {'reviewedAt': suite.iso(), 'originalFilesUnchanged': True,
           'structuredToolErrors': errors,
           'logAlerts': {'originalCombinedSourceRecords': evidence.get('logAlerts', {}).get('count'),
                         'perSource': per_source, 'preferredSource': primary,
                         'preferredSourceAlertRecords': primary_count,
                         'caveat': 'Combined-source counts can double-count the same event. No claim that identical messages within a source are the same event. Neither count determines game health.'},
           'originalGrade': suite.read_json(folder / 'llm-grade.json', {}).get('score'),
           'gradeCaveat': 'Original model grade retained for traceability; combined-source count should not be interpreted as distinct failures.'}
    suite.save(folder / 'independent-review.json', out)
    return out


def main():
    rows = []
    for folder in sorted((PROJECT / 'exp').glob('*/*/summary.json')):
        out = review(folder.parent)
        rows.append({'trial': str(folder.parent.relative_to(PROJECT / 'exp')), 'structuredToolErrors': len(out['structuredToolErrors']), 'preferredSourceAlertRecords': out['logAlerts']['preferredSourceAlertRecords']})
    print(json.dumps(rows, ensure_ascii=False))


if __name__ == '__main__':
    main()
