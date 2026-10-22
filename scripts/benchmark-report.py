#!/usr/bin/env python3
"""Audit the complete matrix and generate evidence-backed local reports."""
import argparse
import csv
import hashlib
import html
import json
import pathlib

PROJECT = pathlib.Path(__file__).resolve().parent.parent
CONDITIONS = ('MCT-full', 'MCT-minimal', 'Opencode-minimal')
REQUIRED = ('setup.json', 'task.txt', 'result.json', 'runner-result.json',
            'timings.json', 'usage.json', 'evidence.json', 'cleanup.json',
            'llm-grade.json', 'workspace-artifact.json', 'workspace.tar.gz')
CHECKS = ('mcdrConfigured', 'mcdrLoadedAtStartup', 'pluginsLoaded', 'serverStarted')
PHASES = ('identify_modpack', 'prepare_server_slot', 'check_java_dependencies', 'configure_python',
          'extract_to_workspace', 'install_modloader', 'configure_mcdr', 'final_mcdr_test', 'unclassified')


def read(file):
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return {}


def digest(file):
    value = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def audit(root, entries, verify_hash=False):
    rows = []
    for entry in entries:
        slug = entry['project']['slug']
        for condition in CONDITIONS:
            folder = root / slug / condition
            summary = read(folder / 'summary.json')
            setup = read(folder / 'setup.json')
            timings, usage = read(folder / 'timings.json'), read(folder / 'usage.json')
            evidence, cleanup = read(folder / 'evidence.json'), read(folder / 'cleanup.json')
            grade, artifact = read(folder / 'llm-grade.json'), read(folder / 'workspace-artifact.json')
            issues = []
            if not summary:
                issues.append('missing_summary')
            issues += ['missing:' + filename for filename in REQUIRED if not (folder / filename).is_file()]
            if not cleanup.get('passed'):
                issues.append('cleanup_not_proven')
            if not artifact.get('verifiedReadable'):
                issues.append('archive_not_proven')
            archive = folder / 'workspace.tar.gz'
            if verify_hash and archive.is_file() and digest(archive) != artifact.get('sha256'):
                issues.append('archive_hash_mismatch')
            if grade.get('status') != 'scored' or type(grade.get('score')) is not int or not 0 <= grade['score'] <= 100:
                issues.append('llm_score_unavailable')
            if not set(PHASES).issubset({p.get('id') for p in timings.get('phases', [])}):
                issues.append('phase_timings_missing')
            if not usage.get('coverageComplete'):
                issues.append('usage_coverage_incomplete')
            if summary.get('server') != slug or summary.get('condition') != condition:
                issues.append('summary_identity_mismatch')
            checks = {key: evidence.get('checks', {}).get(key, {}).get('passed') for key in CHECKS}
            if any(type(value) is not bool for value in checks.values()):
                issues.append('external_check_fields_missing')
            if type(summary.get('wallTimeMs')) not in (int, float) or summary['wallTimeMs'] < 0:
                issues.append('wall_time_missing')
            if not setup.get('archiveSha256') or not setup.get('templateFiles'):
                issues.append('input_hashes_missing')
            rows.append({'server': slug, 'condition': condition, 'present': bool(summary),
                         'status': summary.get('status', 'not_completed'), 'wallTimeMs': summary.get('wallTimeMs'),
                         'checks': checks, 'checksPassed': all(value is True for value in checks.values()),
                         'rawUsage': usage.get('rawTotals', {}), 'normalizedUsage': usage.get('normalized', {}),
                         'cacheUnavailableReason': None if usage.get('normalized', {}).get('cacheRate') is not None else usage.get('caveat', 'not_observed'),
                         'phaseTimings': timings.get('phases', []), 'score': grade.get('score'),
                         'toolErrors': timings.get('toolErrors'), 'logAlerts': evidence.get('logAlerts', {}).get('count'),
                         'cleanupPassed': cleanup.get('passed') is True, 'archiveBytes': artifact.get('bytes'),
                         'auditIssues': issues, 'artifactsComplete': not issues})
    for entry in entries:
        slug = entry['project']['slug']
        folders = [root / slug / condition for condition in CONDITIONS]
        setups = [read(folder / 'setup.json') for folder in folders]
        for key in ('archiveSha256', 'templateFiles', 'model', 'memoryMb', 'proxy'):
            values = [setup.get(key) for setup in setups]
            if all(values) and any(value != values[0] for value in values[1:]):
                for row in rows:
                    if row['server'] == slug:
                        row['auditIssues'].append('condition_input_mismatch:' + key)
                        row['artifactsComplete'] = False
    return {'expected': len(entries) * len(CONDITIONS), 'completed': sum(r['present'] for r in rows),
            'artifactsComplete': sum(r['artifactsComplete'] for r in rows),
            'deploymentChecksPassed': sum(r['checksPassed'] for r in rows),
            'allArtifactsComplete': all(r['artifactsComplete'] for r in rows), 'archiveHashesChecked': verify_hash, 'rows': rows}


def display(value):
    if value is None:
        return '—'
    if isinstance(value, bool):
        return '通过' if value else '未通过'
    return str(value)


def report(root, result):
    root.mkdir(parents=True, exist_ok=True)
    (root / 'audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    with (root / 'phase-timings.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['server', 'condition', 'phase', 'status', 'tool_calls', 'tool_active_union_ms', 'span_ms', 'source'])
        for row in result['rows']:
            for phase in row['phaseTimings']:
                writer.writerow([row['server'], row['condition'], phase.get('id'), phase.get('status'), phase.get('toolCalls'), phase.get('toolActiveUnionMs') if phase.get('status') == 'observed' else None, phase.get('spanMs'), phase.get('source')])
    headers = ['服务端', '条件', '执行状态', '总耗时(s)', '原始 Prompt', '原始 Completion', '缓存率', 'MCDR配置', 'MCDR接管', '插件加载', '游戏启动', 'LLM评分', '工具错误', '日志告警', '清理', '产物审计']
    cells = []
    for row in result['rows']:
        cache = row['normalizedUsage'].get('cacheRate')
        values = [row['server'], row['condition'], row['status'], round(row['wallTimeMs'] / 1000, 1) if row['wallTimeMs'] is not None else None,
                  row['rawUsage'].get('prompt_tokens'), row['rawUsage'].get('completion_tokens'), f'{cache:.2%}' if cache is not None else '不可计算/未观测',
                  *[row['checks'][k] for k in CHECKS], row['score'], row['toolErrors'], row['logAlerts'], row['cleanupPassed'], '齐全' if row['artifactsComplete'] else '; '.join(row['auditIssues'])]
        cells.append([display(value) for value in values])
    intro = (f"已完成记录 {result['completed']}/{result['expected']}；产物审计齐全 {result['artifactsComplete']}/{result['expected']}；"
             f"四项外部部署检查均通过 {result['deploymentChecksPassed']}/{result['expected']}。部署未通过与实验记录缺失分开统计。")
    caveats = [
        '每条件单次、固定顺序、串行运行；缓存预热、网络和机器负载影响结果，不作统计显著性或纯提示词因果结论。',
        '原始 Prompt/Completion 是上游字段的逐请求求和。缓存口径不一致时不反推输入量、缓存率或成本；原始 usage 见各条件 usage.json。',
        '阶段时间见 phase-timings.csv：工具语义区间可能跨阶段重叠，不能相加冒充总耗时；未观测不等于零。模型 wire 活跃时间包含网络。',
        '模板插件加载只说明加载状态，不证明功能无异常。生产 ChatHub 外连统一阻断，远程功能未验收；日志 ERROR/FATAL 独立于游戏健康报告。',
        'LLM 评分为独立请求的主观综合评审，同模型家族，不能替代外部验收；评分请求耗时和用量不计入部署指标。',
        '已排除的基础设施无效尝试保存在 invalid-attempts/；它们不属于正式 21 项。',
        '归档可能包含敏感配置、数据库和工具输出，请勿未经脱敏公开。',
    ]
    markdown = '# 串行部署实验结果\n\n' + intro + '\n\n'
    markdown += '| ' + ' | '.join(headers) + ' |\n|' + '|'.join(['---'] * len(headers)) + '|\n'
    markdown += '\n'.join('| ' + ' | '.join(c.replace('|', '\\|').replace('\n', ' ') for c in row) + ' |' for row in cells)
    markdown += '\n\n## 口径与局限\n\n' + '\n'.join('- ' + item for item in caveats) + '\n'
    (root / 'REPORT.md').write_text(markdown)
    escape = html.escape
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>串行部署实验结果</title><style>body{font:14px system-ui;margin:24px;color:#182430;background:#f5f7fa}h1{font-size:24px}.table{overflow:auto}table{border-collapse:collapse;background:white}th,td{padding:10px;text-align:left;border-bottom:1px solid #e2e8ef;white-space:nowrap}th{background:#eaf0f7}li{margin:8px 0}details{margin:16px 0}code{font-family:monospace}</style><h1>串行部署实验结果</h1><p>' + escape(intro) + '</p><div class="table"><table><thead><tr>'
    page += ''.join('<th>' + escape(h) + '</th>' for h in headers) + '</tr></thead><tbody>'
    page += ''.join('<tr>' + ''.join('<td>' + escape(c) + '</td>' for c in row) + '</tr>' for row in cells) + '</tbody></table></div>'
    page += '<h2>阶段时间</h2><p>完整机器可读表：<a href="phase-timings.csv">phase-timings.csv</a>。活跃区间与跨度分开记录，未观测为未知。</p>'
    for row in result['rows']:
        if not row['phaseTimings']:
            continue
        page += '<details><summary>' + escape(row['server'] + ' / ' + row['condition']) + '</summary><div class="table"><table><tr><th>阶段</th><th>工具次数</th><th>活跃区间(s)</th><th>跨度(s)</th></tr>'
        for phase in row['phaseTimings']:
            values = [phase['id'], phase.get('toolCalls'), round(phase.get('toolActiveUnionMs', 0) / 1000, 2) if phase.get('status') == 'observed' else None, round(phase['spanMs'] / 1000, 2) if phase.get('spanMs') is not None else None]
            page += '<tr>' + ''.join('<td>' + escape(display(v)) + '</td>' for v in values) + '</tr>'
        page += '</table></div></details>'
    page += '<h2>口径与局限</h2><ul>' + ''.join('<li>' + escape(item) + '</li>' for item in caveats) + '</ul></html>'
    (root / 'REPORT.html').write_text(page)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=PROJECT / 'exp')
    parser.add_argument('--verify-hashes', action='store_true')
    args = parser.parse_args()
    entries = read(PROJECT / 'benchmark/manifest.json')['entries']
    result = audit(args.root, entries, args.verify_hashes)
    report(args.root, result)
    print(json.dumps({k: v for k, v in result.items() if k != 'rows'}, ensure_ascii=False))


if __name__ == '__main__':
    main()
