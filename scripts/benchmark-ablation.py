#!/usr/bin/env python3
"""Six full-agent mechanism ablations, one fresh deployment per condition."""
import copy
import fcntl
import importlib.util
import json
import pathlib
import subprocess
import random
import shutil
import os

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
PROFILES = ['control', 'no-skill', 'no-progress', 'single-turn', 'lean-runtime', 'compact-static']


def main():
    output = PROJECT / 'exp/ablation-full-20261022'
    temp = pathlib.Path('/tmp/opencode/benchmark-suite-20261021')
    temp.mkdir(exist_ok=True)
    with (temp / 'suite.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if suite.occupied(8801):
            raise RuntimeError('Isolated API port in use; no parallel trials')
        source = next(e for e in suite.read_json(PROJECT / 'benchmark/manifest.json')['entries'] if e['project']['slug'] == 'the-pixelmon-modpack')
        # Control first anchors the current machine state; seeded random order
        # for the remaining five conditions, fixed before observing outcomes.
        tail = PROFILES[1:]
        random.Random(20261022).shuffle(tail)
        order = ['control', *tail]
        protocol = {'createdAt': suite.iso(), 'replicates': 1, 'order': order, 'seed': 20261022, 'package': source,
                    'model': suite.MODEL, 'reasoning': 'high', 'memoryMb': 3584,
                    'primaryMetrics': ['deployment wall time', 'model wire active union', 'model requests', 'raw completion tokens', 'tool calls', 'progress calls', 'external validation'],
                    'controls': ['original archive/template/runtime baselines', 'fresh workspace per trial', 'same task except identity/path/port', 'same full mode tools except explicitly ablated tools', 'serial graceful shutdown and archive gate'],
                    'limitations': ['One run per condition; exploratory only, no significance or stable effect size claim.', 'Control first and remote/filesystem caches cannot be reset; order confounded.', 'Single-turn removes scheduler tool and corresponding contradictory instructions; not pure prompt-length isolation.', 'Compact-static is human semantic compression, not proof of exact semantic equivalence.', 'Wire cache accounting inconsistent; no invented cache rates/cost.', 'Same-family automatic grade is secondary, not ground truth.'],
                    'profiles': {'control': 'unchanged full assembly and scheduling', 'no-skill': 'no enabled skill contents; other text/tools/scheduling unchanged', 'no-progress': 'remove progress tool and mandatory reporting instruction; backend progress events retained', 'single-turn': 'remove begin tool and scheduler directives; full technical stages/progress retained; no automatic successor turns', 'lean-runtime': 'remove repeated policy lines from runtime context, retain all runtime facts and round instruction', 'compact-static': 'compress full static prompt; retain stage IDs, checks, tool permissions, scheduling and runtime context'}}
        output.mkdir(parents=True, exist_ok=True)
        if not (output / 'protocol.json').exists():
            suite.save(output / 'protocol.json', protocol)
        row, secrets = suite.credentials()
        try:
            for index, profile in enumerate(order):
                if shutil.disk_usage(PROJECT).free < 3 * 1024 ** 3:
                    raise RuntimeError('Less than 3 GiB disk free')
                entry = copy.deepcopy(source)
                entry['project']['slug'] = 'ablation-' + profile
                suite.save(output / 'progress.json', {'status': 'running', 'profile': profile, 'index': index, 'total': 6, 'runnerPid': os.getpid(), 'updatedAt': suite.iso()})
                suite.execute_run(entry, 'MCT-full', 100 + index, output, temp, row, secrets, 8801, ablation_profile=profile)
                summarize(output, order)
            suite.save(output / 'progress.json', {'status': 'completed', 'completed': 6, 'updatedAt': suite.iso()})
        except BaseException as error:
            suite.save(output / 'progress.json', {'status': 'halted', 'profile': profile, 'error': repr(error), 'updatedAt': suite.iso()})
            raise
        finally:
            summarize(output, order)


def summarize(output, order):
    rows = []
    for profile in order:
        folder = output / ('ablation-' + profile) / 'MCT-full'
        summary = suite.read_json(folder / 'summary.json')
        if not summary:
            continue
        timing = suite.read_json(folder / 'timings.json', {})
        requests = suite.jsonl(folder / 'model-requests.jsonl')
        first = requests[0].get('request', {}) if requests else {}
        rows.append({'profile': profile, 'wallTimeMs': summary.get('wallTimeMs'), 'status': summary.get('status'),
                     'modelSteps': summary.get('modelSteps'), 'wireMs': timing.get('modelWireActiveUnionMs'), 'toolCalls': timing.get('toolCalls'),
                     'toolErrors': timing.get('toolErrors'), 'progressCalls': sum(c['name'] == 'update_agent_workflow_progress' for c in timing.get('calls', [])),
                     'turns': len(suite.read_json(folder / 'result.json', {}).get('details', [])),
                     'firstSystemChars': sum(len(str(m.get('content', ''))) for m in first.get('messages', []) if m.get('role') == 'system'),
                     'firstToolCount': len(first.get('tools', [])), 'rawUsage': summary.get('rawUsage'), 'checks': summary.get('checks'),
                     'cleanupPassed': summary.get('cleanup', {}).get('passed'), 'archiveVerified': suite.read_json(folder / 'workspace-artifact.json', {}).get('verifiedReadable'),
                     'llmReview': summary.get('llmReview')})
    suite.save(output / 'results.json', rows)
    print('ABLATION SUMMARY', json.dumps(rows, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
