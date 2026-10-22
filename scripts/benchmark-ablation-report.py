#!/usr/bin/env python3
"""Summarize full-agent mechanism screening without claiming causal certainty."""
import argparse
import collections
import importlib.util
import json
import os
import pathlib
import select
import html

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('suite', PROJECT / 'scripts/benchmark-suite.py')
suite = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suite)
ROOT = PROJECT / 'exp/ablation-full-20261022'
LABELS = {'control': '原样全量', 'no-progress': '去模型进度汇报', 'lean-runtime': '去运行时重复策略',
          'no-skill': '去 Skill 注入', 'compact-static': '静态提示词压缩', 'single-turn': '单 turn 无自动推进'}


def collect(root):
    protocol = suite.read_json(root / 'protocol.json', {})
    rows = []
    control_system = None
    control_tools = None
    control_schemas = None
    control_sources = None
    for profile in protocol.get('order', []):
        folder = root / ('ablation-' + profile) / 'MCT-full'
        summary = suite.read_json(folder / 'summary.json', {})
        requests = suite.jsonl(folder / 'model-requests.jsonl')
        first = requests[0].get('request', {}) if requests else {}
        system = '\n'.join(str(m.get('content', '')) for m in first.get('messages', []) if m.get('role') == 'system')
        tool_names = [t.get('function', {}).get('name') for t in first.get('tools', [])]
        if profile == 'control':
            control_system, control_tools = system, tool_names
            control_schemas = first.get('tools', [])
        timings = suite.read_json(folder / 'timings.json', {})
        evidence = suite.read_json(folder / 'evidence.json', {})
        setup = suite.read_json(folder / 'setup.json', {})
        # These postprocessing/docs files were added during the control run;
        # they are not imported by the backend or experimental runner.
        postprocessing = {'scripts/benchmark-ablation-report.py', 'scripts/benchmark-ablation-report.test.py', 'scripts/benchmark-ablation.md'}
        sources = {key: value for key, value in setup.get('sourceHashes', {}).items() if key not in postprocessing}
        if profile == 'control':
            control_sources = sources
        artifact = suite.read_json(folder / 'workspace-artifact.json', {})
        result = suite.read_json(folder / 'result.json', {})
        usage = suite.read_json(folder / 'usage.json', {})
        issues = []
        if not summary:
            issues.append('尚未完成')
        if summary and not summary.get('cleanup', {}).get('passed'):
            issues.append('清理未证实')
        if summary and not artifact.get('verifiedReadable'):
            issues.append('归档未证实')
        if summary and not usage.get('coverageComplete'):
            issues.append('usage覆盖不全')
        expected_tools = set(control_tools or []) - ({'update_agent_workflow_progress'} if profile == 'no-progress' else {'begin_deployment_workflow'} if profile == 'single-turn' else set())
        if first and set(tool_names) != expected_tools:
            issues.append('非预期初始工具集差异')
        expected_schemas = [tool for tool in (control_schemas or []) if tool.get('function', {}).get('name') in expected_tools]
        if first and any(request.get('request', {}).get('tools', []) != expected_schemas for request in requests):
            issues.append('非预期工具schema差异（含后续请求）')
        if summary and sources != control_sources:
            issues.append('执行源码哈希不一致')
        if first and profile in ('control', 'lean-runtime') and system != control_system:
            issues.append('非预期静态提示词差异')
        if first and profile == 'no-skill' and '# Enabled Skills' in system:
            issues.append('Skill消融未生效')
        if first and profile == 'no-progress' and '每阶段开始、完成或失败都调用 update_agent_workflow_progress' in system:
            issues.append('进度指令消融未生效')
        if first and profile == 'single-turn' and '完整部署必须先调用 begin_deployment_workflow' in system:
            issues.append('单turn消融未生效')
        if first and profile == 'compact-static' and len(system) >= len(control_system or ''):
            issues.append('静态压缩未生效')
        if first and profile == 'lean-runtime' and any('配置策略：' in str(m.get('content', '')) for m in first.get('messages', [])):
            issues.append('运行时策略消融未生效')
        names = collections.Counter(c['name'] for c in timings.get('calls', []))
        key_checks = ['mcdrConfigured', 'mcdrLoadedAtStartup', 'pluginsLoaded', 'serverStarted', 'minecraftStatus', 'isolatedListener', 'safeConfig', 'memoryLimit']
        checks = {key: evidence.get('checks', {}).get(key, {}).get('passed') for key in key_checks}
        rows.append({'profile': profile, 'label': LABELS[profile], 'completed': bool(summary), 'status': summary.get('status', 'not_completed'),
                     'wallTimeMs': summary.get('wallTimeMs'), 'wireMs': timings.get('modelWireActiveUnionMs'), 'toolUnionMs': timings.get('toolActiveUnionMs'),
                     'modelSteps': timings.get('modelSteps'), 'modelRequests': usage.get('requests'), 'toolCalls': timings.get('toolCalls'),
                     'toolErrors': timings.get('toolErrors'), 'progressCalls': names['update_agent_workflow_progress'],
                     'validationCalls': names['inspect_current_server_validation'], 'shellCalls': names['run_shell_command'],
                     'starts': names['start_current_server'], 'loaderCalls': names['setup_neoforge_server'],
                     'turns': len(result.get('details', [])), 'systemChars': len(system) if first else None, 'toolCount': len(tool_names) if first else None,
                     'rawUsage': usage.get('rawTotals', {}), 'checks': checks, 'allChecksPassed': all(checks.values()) and bool(summary),
                     'llmReview': summary.get('llmReview'), 'auditIssues': issues,
                     'cleanupPassed': summary.get('cleanup', {}).get('passed'), 'archiveVerified': artifact.get('verifiedReadable'),
                     'inputArchiveHash': setup.get('archiveSha256'), 'templateHashes': setup.get('templateFiles')})
    if rows:
        reference = rows[0]
        for row in rows:
            for key in ('wallTimeMs', 'wireMs', 'modelSteps', 'toolCalls'):
                row[key + 'ChangePct'] = round((row[key] / reference[key] - 1) * 100, 2) if row.get(key) is not None and reference.get(key) else None
            if row['completed'] and (row['inputArchiveHash'] != reference['inputArchiveHash'] or row['templateHashes'] != reference['templateHashes']):
                row['auditIssues'].append('输入哈希不一致')
    return rows


def write_report(root):
    rows = collect(root)
    suite.save(root / 'analysis.json', {'generatedAt': suite.iso(), 'replicates': 1,
               'completed': sum(row['completed'] for row in rows), 'expected': 6, 'rows': rows,
               'interpretation': 'Exploratory single-run interventions, not a causal ranking. Only quality-preserving and correctly applied treatments can be considered optimization candidates. Missing cache semantics precludes true total-input/cost comparison.'})
    headers = ['条件', '耗时(s)', '相对对照', '模型请求', '输出Token', '工具调用', '进度调用', 'turn数', '系统字符', '外部验收', '评分', '清理归档']
    cells = []
    for row in rows:
        delta = row.get('wallTimeMsChangePct')
        cells.append([row['label'], f"{row['wallTimeMs'] / 1000:.3f}" if row['wallTimeMs'] is not None else '—',
                      f'{delta:+.2f}%' if delta is not None else '—', str(row['modelRequests']) if row['modelRequests'] is not None else '—',
                      str(row['rawUsage'].get('completion_tokens', '—')), str(row['toolCalls']) if row['toolCalls'] is not None else '—',
                      str(row['progressCalls']) if row['completed'] else '—', str(row['turns']) if row['completed'] else '—',
                      str(row['systemChars']) if row['systemChars'] is not None else '—',
                      '8/8' if row['allChecksPassed'] else '未全通过' if row['completed'] else '待完成',
                       str((row.get('llmReview') or {}).get('score')) if (row.get('llmReview') or {}).get('score') is not None else '缺失', '通过' if row['cleanupPassed'] and row['archiveVerified'] else '未齐全'])
    title = f"全量机制消融：{sum(row['completed'] for row in rows)}/6 条件已生成结果，每组一次"
    notes = [
        '负百分比表示比本轮全量对照更快；只在外部质量与消融开关核对通过时才有参考意义。',
        '每组仅一次，无方差或显著性估计；对照先跑，其余顺序预先随机，缓存、网络、机器负载和随机性仍有混杂。',
        'no-progress 同时移除进度工具与相关要求；single-turn 同时移除自动调度与矛盾的调度文字，不是单纯字符长度实验。',
        'compact-static 是人工语义压缩，覆盖关键要求但不证明逐字语义等价；也不能把收益全部归于字符数。',
        '模型wire活跃时间包含网络；工具时间可并行重叠；上游Prompt/Total与cache字段口径不一致，禁止据此算成本或统一缓存率。',
        '评分为独立模型请求的次要指标。所有原始结果、阶段时间、工具调用、输入哈希和归档保留在各条件目录。',
    ]
    markdown = '# ' + title + '\n\n| ' + ' | '.join(headers) + ' |\n|' + '|'.join(['---'] * len(headers)) + '|\n'
    markdown += '\n'.join('| ' + ' | '.join(row) + ' |' for row in cells)
    markdown += '\n\n## 审计\n\n' + '\n'.join('- ' + row['label'] + '：' + ('；'.join(row['auditIssues']) or '输入/开关/清理/归档检查通过') for row in rows)
    markdown += '\n\n## 局限\n\n' + '\n'.join('- ' + note for note in notes) + '\n'
    conclusions = root / 'CONCLUSIONS.md'
    if conclusions.exists():
        markdown += '\n' + conclusions.read_text() + '\n'
    (root / 'REPORT.md').write_text(markdown)
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>全量消融实验</title><style>body{font:14px system-ui;margin:24px;background:#f6f8fa;color:#182330}h1{font-size:23px}.scroll{overflow:auto}table{border-collapse:collapse;background:white}th,td{padding:12px;white-space:nowrap;border-bottom:1px solid #e1e5eb;text-align:right}th:first-child,td:first-child{text-align:left}li{margin:10px 0;line-height:1.6}</style><h1>' + html.escape(title) + '</h1><div class="scroll"><table><tr>'
    page += ''.join('<th>' + html.escape(h) + '</th>' for h in headers) + '</tr>'
    page += ''.join('<tr>' + ''.join('<td>' + html.escape(c) + '</td>' for c in row) + '</tr>' for row in cells) + '</table></div><h2>审计</h2><ul>'
    page += ''.join('<li>' + html.escape(row['label'] + '：' + ('；'.join(row['auditIssues']) or '输入/开关/清理/归档检查通过')) + '</li>' for row in rows) + '</ul><h2>局限</h2><ul>'
    page += ''.join('<li>' + html.escape(note) + '</li>' for note in notes) + '</ul></html>'
    (root / 'REPORT.html').write_text(page)
    print(markdown, flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--wait-pid', type=int)
    args = parser.parse_args()
    if args.wait_pid:
        try:
            fd = os.pidfd_open(args.wait_pid)
        except ProcessLookupError:
            pass
        else:
            try:
                select.select([fd], [], [])
            finally:
                os.close(fd)
    write_report(ROOT)


if __name__ == '__main__':
    main()
