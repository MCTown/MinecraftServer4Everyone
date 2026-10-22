#!/usr/bin/env python3
"""One isolated acceptance deployment of the continuous production code path."""
import copy
import fcntl
import importlib.util
import pathlib
import shutil

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
OUTPUT = PROJECT / 'exp/continuous-20261022'
TEMP = pathlib.Path('/tmp/opencode/benchmark-suite-20261021')


def main():
    TEMP.mkdir(exist_ok=True)
    with (TEMP / 'suite.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if OUTPUT.exists() and any(OUTPUT.iterdir()):
            raise RuntimeError('Acceptance output already exists; refusing to repeat or overwrite')
        if suite.occupied(8802) or suite.occupied(25900):
            raise RuntimeError('Acceptance port occupied; will not touch its owner')
        if shutil.disk_usage(PROJECT).free < 3 * 1024 ** 3:
            raise RuntimeError('Less than 3 GiB disk free')
        entry = copy.deepcopy(next(item for item in suite.read_json(PROJECT / 'benchmark/manifest.json')['entries']
                                   if item['project']['slug'] == 'the-pixelmon-modpack'))
        entry['project']['slug'] = 'continuous-pixelmon'
        OUTPUT.mkdir(mode=0o700)
        suite.save(OUTPUT / 'protocol.json', {
            'createdAt': suite.iso(), 'replicates': 1, 'package': entry, 'model': suite.MODEL,
            'memoryMb': 3584, 'httpPort': 8802, 'minecraftPort': 25900,
            'mode': 'full production continuous path; no ablation preload',
            'controls': 'same original package, template, runtime baselines, proxy and safety overlay as ablation',
            'limitations': ['one acceptance run, not a simultaneous randomized comparison',
                            'begin tool retained as idempotent initialization, unlike experimental single-turn',
                            'no production restart, no original matrix resumption, no repeated deployment']})
        row, secrets = suite.credentials()
        suite.save(OUTPUT / 'progress.json', {'status': 'running', 'startedAt': suite.iso()})
        try:
            summary = suite.execute_run(entry, 'MCT-full', 200, OUTPUT, TEMP, row, secrets, 8802)
            run = OUTPUT / 'continuous-pixelmon/MCT-full'
            result = suite.read_json(run / 'result.json', {})
            turns = result.get('details', [])
            requests = suite.jsonl(run / 'model-requests.jsonl')
            first = requests[0].get('request', {}) if requests else {}
            system = '\n'.join(str(message.get('content', '')) for message in first.get('messages', []) if message.get('role') == 'system')
            names = [tool.get('function', {}).get('name') for tool in first.get('tools', [])]
            artifact = suite.read_json(run / 'workspace-artifact.json', {})
            checks = {
                'oneExecution': len(turns) == 1,
                'continuousInitialized': len(turns) == 1 and turns[0].get('deploymentRun', {}).get('version') == 1,
                'newProtocol': len(turns) == 1 and turns[0].get('workflowScheduling') == 2,
                'noSuccessorChain': bool(turns) and all(not turn.get('workflowRun') for turn in turns),
                'beginToolRetained': 'begin_deployment_workflow' in names,
                'noRoundDirectives': bool(system) and not any(text in system for text in ['## Turn 调度', '串行节点各一个 turn', '本轮只执行这一个节点']),
                'externalChecks': bool(summary.get('checks')) and all(summary['checks'].values()),
                'gracefulCleanup': summary.get('cleanup', {}).get('passed') is True,
                'archiveReadable': artifact.get('verifiedReadable') is True,
                'archiveHashMatches': suite.sha(run / 'workspace.tar.gz') == artifact.get('sha256'),
                'portsReleased': not suite.occupied(8802) and not suite.occupied(25900),
            }
            suite.save(OUTPUT / 'acceptance.json', {'auditedAt': suite.iso(), 'passed': all(checks.values()), 'checks': checks,
                'wallTimeMs': summary.get('wallTimeMs'), 'modelSteps': summary.get('modelSteps'),
                'toolCalls': summary.get('toolCalls'), 'toolErrors': summary.get('toolErrors'), 'rawUsage': summary.get('rawUsage'),
                'llmReview': summary.get('llmReview'), 'firstSystemChars': len(system), 'firstToolCount': len(names)})
            suite.save(OUTPUT / 'progress.json', {'status': 'completed' if all(checks.values()) else 'acceptance_failed', 'finishedAt': suite.iso()})
            if not all(checks.values()):
                raise RuntimeError('Continuous acceptance failed; inspect acceptance.json, do not repeat automatically')
        except BaseException as error:
            suite.save(OUTPUT / 'progress.json', {'status': 'halted', 'error': repr(error), 'updatedAt': suite.iso()})
            raise


if __name__ == '__main__':
    main()
