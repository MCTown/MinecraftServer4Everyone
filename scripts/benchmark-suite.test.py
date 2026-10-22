import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch, MagicMock


spec = importlib.util.spec_from_file_location('suite', pathlib.Path(__file__).with_name('benchmark-suite.py'))
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)


class BenchmarkMetricsTest(unittest.TestCase):
    def usage(self, items):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            folder = pathlib.Path(temp)
            (folder / 'wire-usage.jsonl').write_text(''.join(json.dumps({'model': suite.MODEL, 'usage': usage}) + '\n' for usage in items))
            return suite.usage_metrics(folder)

    def test_impossible_cache_is_not_silently_subtracted(self):
        result = self.usage([{'prompt_tokens': 1438, 'completion_tokens': 31, 'prompt_tokens_details': {'cached_tokens': 13056}}])
        self.assertEqual(result['normalized']['status'], 'inconsistent_or_incomplete')
        self.assertIsNone(result['normalized']['cacheRate'])
        self.assertEqual(result['rawTotals']['prompt_tokens'], 1438)

    def test_explicit_hit_plus_miss_is_auditable(self):
        result = self.usage([{'prompt_tokens': 2, 'completion_tokens': 3, 'prompt_cache_hit_tokens': 8, 'prompt_cache_miss_tokens': 2}])
        self.assertEqual(result['normalized']['inputTokens'], 10)
        self.assertEqual(result['normalized']['cacheRate'], .8)
        self.assertFalse(result['perRequest'][0]['rawPromptMatches'])

    def test_incomplete_coverage_stays_unknown(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            folder = pathlib.Path(temp)
            (folder / 'wire-usage.jsonl').write_text(json.dumps({'model': suite.MODEL, 'status': 502}) + '\n')
            result = suite.usage_metrics(folder)
        self.assertFalse(result['coverageComplete'])
        self.assertIsNone(result['normalized']['cacheRate'])

    def test_request_without_finished_wire_record_is_incomplete(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            folder = pathlib.Path(temp)
            (folder / 'model-requests.jsonl').write_text(json.dumps({'id': 'unfinished', 'request': {'model': suite.MODEL}}) + '\n')
            result = suite.usage_metrics(folder)
            self.assertEqual(result['requests'], 1)
            self.assertFalse(result['coverageComplete'])
            self.assertEqual(result['unfinishedRequestIds'], ['unfinished'])

    def test_standard_cache_rate(self):
        result = self.usage([{'prompt_tokens': 100, 'completion_tokens': 10, 'prompt_tokens_details': {'cached_tokens': 80}}])
        self.assertEqual(result['normalized']['totalTokens'], 110)
        self.assertEqual(result['normalized']['cacheRate'], .8)

    def test_intervals_do_not_double_count_parallel_work(self):
        self.assertEqual(suite.union_ms([(1, 5), (2, 3), (4, 8), (10, 12)]), 9)
        self.assertEqual(suite.union_ms([]), 0)

    def test_plugin_reload_restores_state(self):
        self.assertEqual(suite.loaded_plugins('插件 foo@1.0 已加载\n插件 foo@1.0 已卸载\n插件 foo@1.0 已加载'), {'foo': '1.0'})
        self.assertEqual(suite.loaded_plugins('Plugin foo@1.0 loaded\nPlugin foo@1.0 unloaded'), {})
        self.assertEqual(suite.loaded_plugins('插件 foo@1.0 已卸载\n插件 foo@1.1 已重载'), {'foo': '1.1'})

    def test_process_names_do_not_match_incidental_text(self):
        self.assertTrue(suite.is_java({'command': '/path/java @args'}))
        self.assertFalse(suite.is_java({'command': '/bin/sh java @args'}))
        self.assertTrue(suite.is_mcdr({'command': '/path/python3 -m mcdreforged'}))

    def test_modloader_phase_is_separate(self):
        self.assertEqual(suite.classify('setup_neoforge_server', {}), 'install_modloader')
        self.assertEqual(suite.classify('shell', {'command': 'java -jar loader-installer.jar --installServer'}), 'install_modloader')
        self.assertEqual(suite.classify('materialize_curseforge_manifest_pack_from_server_slot', {}), 'extract_to_workspace')

    def test_shell_exit_code_is_a_structured_tool_error(self):
        outcome = suite.command_outcome('{"exitCode": 2, "signal": null, "timedOut": false}')
        self.assertTrue(outcome['error'])
        self.assertEqual(outcome['exitCode'], 2)
        self.assertEqual(suite.command_outcome('{"exitCode": 0, "signal": null, "timedOut": false}')['error'], False)
        self.assertTrue(suite.command_outcome('{"exitCode": null, "signal": "SIGTERM", "timedOut": false}')['error'])
        wrapped = suite.command_outcome('TOOL_ERROR\n错误：Shell 命令执行失败\n{"ok": false, "exitCode": 2, "signal": null, "timedOut": false}\n恢复策略：\n- 不重试')
        self.assertTrue(wrapped['error'])
        self.assertEqual(wrapped['exitCode'], 2)

    def test_stop_refuses_unmanaged_java_without_kill(self):
        java = {'pid': 123456, 'command': '/path/java @args'}
        with patch.object(suite, 'processes', return_value=[java]), patch.object(suite.os, 'kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'Unmanaged Java'):
                suite.stop_server(pathlib.Path('/tmp/opencode/test'), 25700)
            kill.assert_not_called()

    def test_cleanup_fails_when_game_remains(self):
        mcdr = {'pid': 123456, 'command': '/path/python3 -m mcdreforged'}
        api = MagicMock(return_value={'status': 'stopped'})
        with patch.object(suite, 'processes', return_value=[mcdr]), patch.object(suite, 'wait_gone', return_value=False), patch.object(suite.os, 'kill') as kill:
            result = suite.stop_server(pathlib.Path('/tmp/opencode/test'), 25700, api, 'server_test')
            self.assertFalse(result['passed'])
            api.assert_called_once_with('/api/servers/server_test/stop', 'POST')
            kill.assert_not_called()

    def test_cleanup_fails_when_port_remains(self):
        with patch.object(suite, 'processes', return_value=[]), patch.object(suite, 'occupied', return_value=True):
            self.assertFalse(suite.stop_server(pathlib.Path('/tmp/opencode/test'), 25700)['passed'])

    def test_opencode_shell_exit_metadata_is_retained(self):
        with tempfile.TemporaryDirectory(dir='/tmp/opencode') as temp:
            folder = pathlib.Path(temp)
            event = {'type': 'tool_use', 'part': {'id': 'call_test', 'tool': 'shell', 'state': {'status': 'completed', 'input': {'command': 'false'}, 'output': '', 'metadata': {'metadata': {'exit': 7}}, 'time': {'start': 1000, 'end': 2000}}}}
            (folder / 'events.jsonl').write_text(json.dumps(event) + '\n')
            result = suite.timing_metrics(folder, 'Opencode-minimal')
            self.assertEqual(result['toolErrors'], 1)
            self.assertEqual(result['calls'][0]['exitCode'], 7)


if __name__ == '__main__':
    unittest.main()
