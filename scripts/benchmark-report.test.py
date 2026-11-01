import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('report', pathlib.Path(__file__).with_name('benchmark-report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class ReportAuditTest(unittest.TestCase):
    def test_empty_matrix_does_not_claim_completion(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertEqual(result['expected'], 3)
            self.assertEqual(result['completed'], 0)
            self.assertFalse(result['allArtifactsComplete'])
            report.report(root, result)
            self.assertTrue((root / 'REPORT.html').exists())
            self.assertIn('0/3', (root / 'REPORT.md').read_text())

    def test_cleanup_claim_in_summary_alone_is_not_proof(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            trial = root / 'example/MCT-full'
            trial.mkdir(parents=True)
            (trial / 'summary.json').write_text(json.dumps({'server': 'example', 'condition': 'MCT-full', 'cleanup': {'passed': True}}))
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertEqual(result['completed'], 1)
            self.assertEqual(result['artifactsComplete'], 0)
            self.assertIn('cleanup_not_proven', result['rows'][0]['auditIssues'])

    def test_deployment_failure_can_have_complete_experiment_artifacts(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            trial = root / 'example/MCT-full'
            trial.mkdir(parents=True)
            for filename in report.REQUIRED:
                (trial / filename).write_text('{}')
            (trial / report.ARCHIVE).write_text('archive-bytes')
            data = {
                'summary.json': {'server': 'example', 'condition': 'MCT-full', 'status': 'failed', 'wallTimeMs': 2000},
                'setup.json': {'archiveSha256': 'test-hash', 'templateFiles': {'config.yml': 'test-template-hash'}},
                'timings.json': {'phases': [{'id': phase, 'status': 'not_observed'} for phase in report.PHASES]},
                'evidence.json': {'checks': {key: {'passed': False} for key in report.CHECKS}},
                'usage.json': {'coverageComplete': True},
                'cleanup.json': {'passed': True},
                'workspace-artifact.json': {'verifiedReadable': True},
                'llm-grade.json': {'status': 'scored', 'score': 20},
            }
            for filename, value in data.items():
                (trial / filename).write_text(json.dumps(value))
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertTrue(result['rows'][0]['artifactsComplete'])
            self.assertFalse(result['rows'][0]['checksPassed'])
            self.assertEqual(result['deploymentChecksPassed'], 0)

    def _complete_trial(self, trial, artifact, archive=True):
        trial.mkdir(parents=True)
        for filename in report.REQUIRED:
            (trial / filename).write_text('{}')
        if archive:
            (trial / report.ARCHIVE).write_text('archive-bytes')
        data = {
            'summary.json': {'server': 'example', 'condition': 'MCT-full', 'status': 'completed', 'wallTimeMs': 2000},
            'setup.json': {'archiveSha256': 'test-hash', 'templateFiles': {'config.yml': 'test-template-hash'}},
            'timings.json': {'phases': [{'id': phase, 'status': 'not_observed'} for phase in report.PHASES]},
            'evidence.json': {'checks': {key: {'passed': True} for key in report.CHECKS}},
            'usage.json': {'coverageComplete': True},
            'cleanup.json': {'passed': True},
            'workspace-artifact.json': artifact,
            'llm-grade.json': {'status': 'scored', 'score': 90},
        }
        for filename, value in data.items():
            (trial / filename).write_text(json.dumps(value))

    def test_verified_pruned_archive_keeps_its_measurements_auditable(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            trial = root / 'example/MCT-full'
            self._complete_trial(trial, {'verifiedReadable': True, 'sha256': 'recorded-digest',
                'pruned': {'sha256': 'recorded-digest', 'verifiedReadableBeforePrune': True}}, archive=False)
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertTrue(result['rows'][0]['artifactsComplete'], result['rows'][0]['auditIssues'])
            self.assertTrue(result['rows'][0]['checksPassed'])

    def test_missing_archive_without_prune_record_stays_an_issue(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            trial = root / 'example/MCT-full'
            self._complete_trial(trial, {'verifiedReadable': True, 'sha256': 'recorded-digest'}, archive=False)
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertIn('missing:workspace.tar.gz', result['rows'][0]['auditIssues'])

    def test_unverified_prune_claim_is_rejected(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            trial = root / 'example/MCT-full'
            self._complete_trial(trial, {'verifiedReadable': True, 'sha256': 'recorded-digest',
                'pruned': {'sha256': 'different-digest'}}, archive=False)
            result = report.audit(root, [{'project': {'slug': 'example'}}])
            self.assertIn('archive_pruned_without_verification', result['rows'][0]['auditIssues'])


if __name__ == '__main__':
    unittest.main()
