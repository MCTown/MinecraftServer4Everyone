import importlib.util
import json
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('report', pathlib.Path(__file__).with_name('benchmark-ablation-report.py'))
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)


class AblationReportTest(unittest.TestCase):
    def test_missing_runs_remain_incomplete(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            (root / 'protocol.json').write_text(json.dumps({'order': ['control', 'no-skill']}))
            rows = report.collect(root)
            self.assertEqual(len(rows), 2)
            self.assertTrue(all(not row['completed'] for row in rows))
            self.assertTrue(all(not row['allChecksPassed'] for row in rows))
            report.write_report(root)
            self.assertEqual(json.loads((root / 'analysis.json').read_text())['completed'], 0)

    def test_tool_diff_is_audited(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            (root / 'protocol.json').write_text(json.dumps({'order': ['control', 'no-progress']}))
            for profile, names in [('control', ['begin_deployment_workflow', 'update_agent_workflow_progress', 'run_shell_command']), ('no-progress', ['run_shell_command'])]:
                folder = root / ('ablation-' + profile) / 'MCT-full'
                folder.mkdir(parents=True)
                request = {'request': {'messages': [{'role': 'system', 'content': 'test'}], 'tools': [{'function': {'name': name}} for name in names]}}
                (folder / 'model-requests.jsonl').write_text(json.dumps(request) + '\n')
            rows = report.collect(root)
            self.assertNotIn('非预期初始工具集差异', rows[0]['auditIssues'])
            self.assertIn('非预期初始工具集差异', rows[1]['auditIssues'])

    def test_later_schema_mutation_is_not_hidden_by_same_tool_names(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            root = pathlib.Path(temp)
            (root / 'protocol.json').write_text(json.dumps({'order': ['control']}))
            folder = root / 'ablation-control/MCT-full'
            folder.mkdir(parents=True)
            first = {'request': {'tools': [{'function': {'name': 'shell', 'description': 'original'}}]}}
            later = {'request': {'tools': [{'function': {'name': 'shell', 'description': 'changed'}}]}}
            (folder / 'model-requests.jsonl').write_text(json.dumps(first) + '\n' + json.dumps(later) + '\n')
            row = report.collect(root)[0]
            self.assertNotIn('非预期初始工具集差异', row['auditIssues'])
            self.assertIn('非预期工具schema差异（含后续请求）', row['auditIssues'])


if __name__ == '__main__':
    unittest.main()
