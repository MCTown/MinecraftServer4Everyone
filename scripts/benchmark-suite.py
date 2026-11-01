#!/usr/bin/env python3
"""Serial isolated deployment experiment. Never uses the production HTTP API."""
import argparse
import collections
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import select
import shutil
import signal
import socket
import sqlite3
import stat
import struct
import subprocess
import time
import traceback
import urllib.request
import uuid
import zipfile

PROJECT = pathlib.Path(__file__).resolve().parent.parent
BASELINE = pathlib.Path('/tmp/opencode/twilight-prompt-comparison-20261021')
MODEL = 'deepseek-v4-flash-vision-exp'
CONDITIONS = ('MCT-full', 'MCT-minimal', 'Opencode-minimal')
PHASES = ('identify_modpack', 'prepare_server_slot', 'check_java_dependencies', 'configure_python', 'extract_to_workspace', 'install_modloader', 'configure_mcdr', 'final_mcdr_test', 'unclassified')
PROXY = 'http://192.168.31.236:7890'
TIMEOUT = 1800


def iso():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.chmod(0o600)
    temp.replace(path)


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def jsonl(path):
    rows = []
    try:
        for line in path.read_text(errors='replace').splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return rows


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def stamp(value):
    if isinstance(value, (int, float)):
        return value
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
    except (ValueError, AttributeError, TypeError):
        return None


def occupied(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(('127.0.0.1', port)) == 0


class API:
    def __init__(self, port):
        if port == 1143:
            raise RuntimeError('Production API is forbidden')
        self.base = f'http://127.0.0.1:{port}'
        self.cookie = ''

    def login(self):
        req = urllib.request.Request(self.base + '/api/auth/login', data=b'{"password":"ilovemct"}', headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=5) as response:
            self.cookie = response.headers['Set-Cookie'].split(';')[0]

    def __call__(self, route, method='GET', data=None, ctype='application/json'):
        body = None if data is None else json.dumps(data).encode() if ctype == 'application/json' else data
        req = urllib.request.Request(self.base + route, method=method, data=body, headers={'Cookie': self.cookie, **({'Content-Type': ctype} if body is not None else {})})
        with urllib.request.urlopen(req, timeout=90) as response:
            return json.load(response)


def run_node(code, env=None, data=None):
    result = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', code], cwd=PROJECT, env=env, input=data, capture_output=True, text=True, check=True)
    return result.stdout


def credentials():
    # Read-only source DB; decrypted secrets stay in memory or private child environments.
    db = sqlite3.connect(f'file:{PROJECT}/workspace/data/app.db?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    row = dict(db.execute('select * from model_configs order by is_default desc limit 1').fetchone())
    settings = dict(db.execute('select key,value from app_settings'))
    db.close()
    encrypted = {'model': row['encrypted_api_key']}
    for key in ('curseforge_api_key', 'modrinth_api_key', 'brave_search_api_key', 'tavily_api_key'):
        if settings.get(key):
            encrypted[key] = settings[key]
    env = dict(os.environ, BENCH_SECRET_VALUES=json.dumps(encrypted))
    plain = json.loads(run_node('import {decryptSecret} from "./apps/server/src/security/encrypt.ts"; const v=JSON.parse(process.env.BENCH_SECRET_VALUES); console.log(JSON.stringify(Object.fromEntries(Object.entries(v).map(([k,v])=>[k,decryptSecret(v)]))));', env))
    return row, plain


def processes(root):
    root = root.resolve()
    out = []
    for file in pathlib.Path('/proc').iterdir():
        if not file.name.isdigit() or int(file.name) == os.getpid():
            continue
        try:
            cwd = pathlib.Path(os.readlink(file / 'cwd'))
            if not cwd.is_relative_to(root):
                continue
            status = (file / 'status').read_text()
            state = next(x.split()[1] for x in status.splitlines() if x.startswith('State:'))
            if state == 'Z':
                continue
            ppid = int(next(x.split()[1] for x in status.splitlines() if x.startswith('PPid:')))
            cmd = (file / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace').strip()
            ticks = int((file / 'stat').read_text().rsplit(')', 1)[1].split()[19])
            boot = int(next(x.split()[1] for x in pathlib.Path('/proc/stat').read_text().splitlines() if x.startswith('btime ')))
            out.append({'pid': int(file.name), 'ppid': ppid, 'cwd': str(cwd), 'command': cmd, 'startedAtMs': (boot + ticks / os.sysconf('SC_CLK_TCK')) * 1000})
        except (OSError, StopIteration, ValueError):
            pass
    return out


def is_java(proc):
    return bool(re.search(r'(?:^|/)java(?:\s|$)', proc['command'].split(' ', 1)[0] + ' '))


def is_mcdr(proc):
    tokens = proc['command'].split()
    if not tokens:
        return False
    # Both the console-script entry point and `python .../bin/mcdreforged start`
    # are real MCDR processes; missing them caused a false negative and an
    # ineffective API stop in earlier trials.
    executable = pathlib.Path(tokens[0]).name
    if executable in ('mcdreforged', 'mcdreforged.exe'):
        return True
    if re.fullmatch(r'python[\d.]*', executable) and len(tokens) > 1 \
            and pathlib.Path(tokens[1]).name in ('mcdreforged', 'mcdreforged.exe'):
        return True
    return any(token == '-m' and index + 1 < len(tokens) and tokens[index + 1] == 'mcdreforged'
               for index, token in enumerate(tokens))


def descendant(pid, parent):
    for _ in range(40):
        try:
            text = pathlib.Path(f'/proc/{pid}/status').read_text()
            pid = int(next(x.split()[1] for x in text.splitlines() if x.startswith('PPid:')))
        except (OSError, StopIteration):
            return False
        if pid == parent:
            return True
        if pid <= 1:
            return False
    return False


def wait_gone(rows, seconds):
    fds = []
    try:
        for proc in rows:
            try:
                fds.append(os.pidfd_open(proc['pid']))
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + seconds
        while fds and time.monotonic() < deadline:
            ready, _, _ = select.select(fds, [], [], max(0, deadline - time.monotonic()))
            for fd in ready:
                fds.remove(fd)
                os.close(fd)
        return not fds
    finally:
        for fd in fds:
            os.close(fd)


def stop_child(proc):
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        # Do not escalate automatically: halt instead of silently destroying state.
        raise RuntimeError(f'Owned helper {proc.pid} did not exit after SIGTERM')


def stop_server(ws, port, api=None, sid=None):
    started = time.monotonic()
    before = processes(ws)
    game = [p for p in before if is_java(p) or is_mcdr(p)]
    result = {'startedAt': iso(), 'before': before, 'actions': []}
    if game:
        if api and sid:
            try:
                result['actions'].append({'apiStop': api(f'/api/servers/{sid}/stop', 'POST')})
            except Exception as error:
                result['actions'].append({'apiStopError': str(error)})
            # A shell-launched MCDR is not the managed process the API owns, so
            # the stop request can succeed while the game keeps running. Fall
            # back to a graceful stdin stop of the traced MCDR once it is clear
            # the API path did not take effect. Never escalate to a force kill.
            wait_gone(game, 60)
            if [p for p in processes(ws) if is_java(p) or is_mcdr(p)]:
                for proc in [p for p in processes(ws) if is_mcdr(p)]:
                    try:
                        fd = os.open(f'/proc/{proc["pid"]}/fd/0', os.O_WRONLY | os.O_NONBLOCK)
                        try:
                            os.write(fd, b'stop\n')
                            result['actions'].append({'stdinStopPid': proc['pid'], 'reason': 'API stop did not cover an unmanaged MCDR'})
                        finally:
                            os.close(fd)
                    except OSError as error:
                        result['actions'].append({'stdinStopError': str(error)})
                wait_gone(game, 120)
        else:
            mcdr = [p for p in game if is_mcdr(p)]
            if not mcdr:
                raise RuntimeError('Unmanaged Java found; cannot safely send normal stop. Suite halted.')
            for proc in mcdr:
                fd = os.open(f'/proc/{proc["pid"]}/fd/0', os.O_WRONLY | os.O_NONBLOCK)
                try:
                    os.write(fd, b'stop\n')
                    result['actions'].append({'stdinStopPid': proc['pid']})
                finally:
                    os.close(fd)
            wait_gone(game, 180)
    remaining = [p for p in processes(ws) if is_java(p) or is_mcdr(p)]
    if remaining:
        result['remaining'] = remaining
        result['passed'] = False
        result['durationMs'] = round((time.monotonic() - started) * 1000)
        return result
    # Auxiliary FIFO holders are safe to terminate only after MCDR/Java exited.
    helpers = processes(ws)
    for proc in helpers:
        try:
            os.kill(proc['pid'], signal.SIGTERM)
        except ProcessLookupError:
            pass
    wait_gone(helpers, 20)
    result.update(after=processes(ws), portReleased=not occupied(port), finishedAt=iso(), durationMs=round((time.monotonic() - started) * 1000))
    result['passed'] = not result['after'] and result['portReleased']
    return result


def vi(value):
    out = bytearray()
    while True:
        b = value & 127
        value >>= 7
        out.append(b | (128 if value else 0))
        if not value:
            return bytes(out)


def status_probe(port):
    def rv(sock):
        value = 0
        for i in range(5):
            byte = sock.recv(1)
            if not byte:
                raise EOFError('truncated VarInt')
            value |= (byte[0] & 127) << (7 * i)
            if not byte[0] & 128:
                return value
        raise ValueError('invalid VarInt')
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=5) as sock:
            sock.settimeout(5)
            host = b'127.0.0.1'
            handshake = vi(0) + vi(767) + vi(len(host)) + host + struct.pack('>H', port) + vi(1)
            sock.sendall(vi(len(handshake)) + handshake + b'\x01\x00')
            size, packet, length = rv(sock), rv(sock), rv(sock)
            if size != len(vi(packet)) + len(vi(length)) + length:
                raise ValueError('status packet framing mismatch')
            if length > 1_000_000:
                raise ValueError('oversize status')
            body = bytearray()
            while len(body) < length:
                data = sock.recv(length - len(body))
                if not data:
                    raise EOFError('truncated status')
                body.extend(data)
            response = json.loads(body)
            version = response.get('version', {}) if isinstance(response, dict) else {}
            valid = packet == 0 and isinstance(version.get('name'), str) and type(version.get('protocol')) is int
            return {'passed': valid, 'response': response, 'packetSize': size}
    except Exception as error:
        return {'passed': False, 'error': str(error)}


def yaml_config(file):
    code = 'import {readFileSync} from "node:fs";import {parse} from "yaml";console.log(JSON.stringify(parse(readFileSync(process.env.BENCH_YAML_PATH,"utf8"))));'
    try:
        return json.loads(run_node(code, dict(os.environ, BENCH_YAML_PATH=str(file)))), None
    except Exception as error:
        return {}, str(error)


def plugin_inventory(template):
    out = []
    for file in sorted((template / 'plugins').iterdir()):
        if file.suffix not in ('.mcdr', '.pyz'):
            continue
        with zipfile.ZipFile(file) as archive:
            meta = json.loads(archive.read('mcdreforged.plugin.json'))
        out.append({'id': meta['id'], 'version': meta['version'], 'file': file.name, 'sha256': sha(file)})
    return out


def loaded_plugins(text):
    loaded = {}
    pattern = r'(?:插件\s+|Plugin\s+)([a-z][a-z0-9_]*)@([\w.+-]+)\s+(已加载|loaded|已卸载|unloaded|已重载|reloaded)'
    for match in re.finditer(pattern, text, re.I):
        if match[3].lower() in ('已加载', 'loaded', '已重载', 'reloaded'):
            loaded[match[1]] = match[2]
        else:
            loaded.pop(match[1], None)
    return loaded


def owned_output(run, mcdr):
    launches = jsonl(run / 'owned-launches.jsonl')
    if not launches or not mcdr:
        return None
    launch = launches[-1]
    if not any(p['pid'] == launch.get('rootPid') or descendant(p['pid'], launch.get('rootPid')) for p in mcdr):
        return None
    rows = [r for r in jsonl(run / 'owned-process-output.jsonl') if r.get('launchId') == launch.get('launchId')]
    streams = {stream: ''.join(r.get('text', '') for r in rows if r.get('stream') == stream) for stream in ('stdout', 'stderr')}
    clean = lambda value: re.sub(r'\x1b\[[0-9;]*m|§[0-9a-fk-or]', '', value, flags=re.I)
    streams = {k: clean(v) for k, v in streams.items()}
    return {'launch': launch, 'streams': streams, 'entries': len(rows)}


def loopback_bind_ok(listener_lines, port):
    """True only for a loopback-only bind of the trial port.

    A dual-stack JVM may print `[::ffff:127.0.0.1]:port` rather than the plain
    IPv4 spelling; both are loopback-only. A wildcard bind on the same port is
    never acceptable.
    """
    loopback = re.compile(r'(?:^|\s)(?:\[::ffff:)?127\.0\.0\.1(?:\]|):' + str(port) + r'\s')
    wildcard = re.compile(r'(?:^|\s)(?:\*|0\.0\.0\.0|\[::\]):' + str(port) + r'\s')
    return any(loopback.search(line) for line in listener_lines) and not any(wildcard.search(line) for line in listener_lines)


def evaluate(run, setup):
    root = pathlib.Path(setup['server']['directory'])
    ws = pathlib.Path(setup['workspace'])
    rows = processes(ws)
    mcdr, java = [p for p in rows if is_mcdr(p)], [p for p in rows if is_java(p)]
    owned = [p for p in java if any(descendant(p['pid'], m['pid']) for m in mcdr)]
    config, config_error = yaml_config(root / 'config.yml')
    def text(file):
        try:
            return file.read_text(errors='replace')[-8_000_000:]
        except OSError:
            return ''
    mcdr_log = text(root / 'logs/MCDR.log')
    # Select the most recent MCDR launch rather than concatenated historic evidence.
    starts = list(re.finditer(r'^.*MCDReforged\s+[\d.]+\s+(?:正在启动|is starting).*$', mcdr_log, re.M | re.I))
    if starts:
        mcdr_log = mcdr_log[starts[-1].start():]
    game_log = text(root / 'server/logs/latest.log')
    fresh = bool(mcdr)
    try:
        fresh = fresh and (root / 'server/logs/latest.log').stat().st_mtime * 1000 >= max(p['startedAtMs'] for p in mcdr) - 2000
    except (OSError, ValueError):
        fresh = False
    captured = owned_output(run, mcdr)
    if captured:
        # Keep stream chunks contiguous; never join stderr inside a stdout line.
        mcdr_log = '\n'.join(captured['streams'].values())
    loaded = loaded_plugins(mcdr_log)
    expected = plugin_inventory(PROJECT / 'benchmark/mcdr-template')
    missing = [p['id'] for p in expected if p['id'] not in loaded]
    plugin_errors = [line for line in mcdr_log.splitlines() if re.search(r'(?:插件|plugin).*?(?:加载失败|failed to load)|ModuleNotFoundError', line, re.I)]
    ready_log = mcdr_log if captured else game_log if fresh else ''
    done = [line for line in ready_log.splitlines() if re.search(r'Done \([\d.]+s\)!', line)]
    properties = dict(re.findall(r'^\s*([\w.-]+)\s*[=:]\s*(.*?)\s*$', text(root / 'server/server.properties'), re.M))
    status = status_probe(setup['minecraftPort']) if owned else {'passed': False, 'error': 'No owned MCDR Java; did not probe another instance'}
    listener_lines = subprocess.run(['ss', '-H', '-ltnp'], capture_output=True, text=True, check=True).stdout.splitlines()
    listeners = [line for line in listener_lines if any(f'pid={p["pid"]},' in line for p in java)]
    bind_ok = loopback_bind_ok(listeners, setup['minecraftPort'])
    mcdr_ok = config.get('working_directory') == 'server' and isinstance(config.get('start_command'), str) and 'mcdreforged' not in config.get('start_command', '')
    memory = []
    for proc in owned:
        command = proc['command']
        for arg in re.findall(r'(?:^|\s)@([^\s]+)', command):
            file = (pathlib.Path(proc['cwd']) / arg.strip('"\'')).resolve()
            if file.is_relative_to(ws):
                command += '\n' + '\n'.join(line for line in text(file).splitlines() if not line.lstrip().startswith('#'))
        memory.append({'pid': proc['pid'], 'xms': re.findall(r'(?:^|\s)-Xms([^\s]+)', command), 'xmx': re.findall(r'(?:^|\s)-Xmx([^\s]+)', command)})
    def mb(value):
        match = re.fullmatch(r'([\d.]+)([gGmMkK]?)', value)
        return float(match[1]) * {'g': 1024, 'm': 1, 'k': 1 / 1024, '': 1 / (1024 * 1024)}[match[2].lower()] if match else None
    memory_ok = bool(memory) and all(p['xmx'] and mb(p['xmx'][-1]) is not None and mb(p['xmx'][-1]) <= 3584 for p in memory)
    game_ok = bool(owned and done and bind_ok and status['passed'])
    checks = {
        'mcdrConfigured': {'passed': mcdr_ok, 'workingDirectory': config.get('working_directory'), 'handler': config.get('handler'), 'error': config_error},
        'mcdrLoadedAtStartup': {'passed': bool(mcdr and owned), 'mcdrPids': [p['pid'] for p in mcdr], 'javaPids': [p['pid'] for p in owned]},
        'pluginsLoaded': {'passed': bool(mcdr and loaded and not missing), 'expected': expected, 'loaded': loaded, 'missing': missing, 'errors': plugin_errors[-30:], 'scope': 'last load/unload event per ID in latest launch; all template plugins required; prior errors retained; no claim of external-service or gameplay functionality'},
        'serverStarted': {'passed': game_ok, 'freshGameLog': fresh, 'done': done[-1:]},
        'minecraftStatus': status,
        'isolatedListener': {'passed': bind_ok, 'listeners': listeners},
        'safeConfig': {'passed': properties.get('server-ip') == '127.0.0.1' and properties.get('server-port') == str(setup['minecraftPort']) and all(properties.get(k) == 'false' for k in ('enable-rcon', 'enable-query')), 'properties': {k: properties.get(k) for k in ('server-ip', 'server-port', 'enable-rcon', 'enable-query')}},
        'memoryLimit': {'passed': memory_ok, 'processes': memory},
    }
    alerts = [line[:1500] for line in (mcdr_log + '\n' + game_log).splitlines() if re.search(r'\b(?:ERROR|FATAL)\b|NoClassDefFoundError|ClassNotFoundException', line)]
    evidence = {'evaluatedAt': iso(), 'checks': checks, 'processes': rows, 'ownedLaunch': captured['launch'] if captured else None, 'logAlerts': {'count': len(alerts), 'lines': alerts[-40:], 'affectsGameVerdict': False}, 'logSources': ['owned child stdout/stderr grouped by launchId'] if captured else ['logs/MCDR.log (latest launch)', 'server/logs/latest.log (mtime checked against current MCDR start)'], 'limitations': ['No player login or full gameplay test.', 'Plugin load does not prove plugin features or remote services work.', 'ERROR/FATAL counts do not determine game health.'] + ([] if captured else ['No external owned stdout/stderr observer was attached; file logs plus process ancestry/status used.'])}
    save(run / 'evidence.json', evidence)
    # Preserve evaluator-owned snapshots before teardown; not the mixed UI console.
    (run / 'mcdr-current-launch.txt').write_text(mcdr_log)
    (run / 'minecraft-current-launch.txt').write_text(game_log)
    return evidence


def usage_metrics(run):
    records = [r for r in jsonl(run / 'wire-usage.jsonl') if r.get('model') == MODEL]
    requests = [r for r in jsonl(run / 'model-requests.jsonl') if r.get('request', {}).get('model') == MODEL]
    unfinished = sorted({r['id'] for r in requests} - {r['id'] for r in records if r.get('id')})
    with_usage = [r for r in records if isinstance(r.get('usage'), dict)]
    totals = collections.Counter()
    normalized = []
    for record in with_usage:
        u = record['usage']
        p, out = u.get('prompt_tokens', u.get('input_tokens')), u.get('completion_tokens', u.get('output_tokens'))
        details = u.get('prompt_tokens_details', u.get('input_tokens_details', {})) or {}
        hit = u.get('prompt_cache_hit_tokens', details.get('cached_tokens'))
        miss = u.get('prompt_cache_miss_tokens')
        if isinstance(hit, (int, float)):
            totals['observed_cache_hit_tokens'] += hit
        for key, value in u.items():
            if isinstance(value, (int, float)):
                totals[key] += value
        if isinstance(hit, (int, float)) and isinstance(miss, (int, float)) and hit >= 0 and miss >= 0 and hit + miss > 0:
            item = {'inputTokens': hit + miss, 'cacheHitTokens': hit, 'cacheMissTokens': miss, 'outputTokens': out, 'source': 'explicit_hit_plus_miss', 'rawPromptMatches': p == hit + miss}
        elif isinstance(p, (int, float)) and isinstance(hit, (int, float)) and 0 <= hit <= p and p > 0:
            item = {'inputTokens': p, 'cacheHitTokens': hit, 'cacheMissTokens': p - hit, 'outputTokens': out, 'source': 'prompt_includes_cached'}
        else:
            item = {'inputTokens': None, 'cacheHitTokens': hit, 'outputTokens': out, 'source': 'inconsistent_or_unavailable', 'rawPromptTokens': p}
        normalized.append(item)
    complete = not unfinished and len(normalized) == len(records) and bool(records) and all(x['inputTokens'] is not None for x in normalized)
    input_tokens = sum(x['inputTokens'] for x in normalized) if complete else None
    hits = sum(x['cacheHitTokens'] for x in normalized) if complete else None
    outputs = sum(x['outputTokens'] for x in normalized) if complete and all(isinstance(x['outputTokens'], (int, float)) for x in normalized) else None
    result = {'source': 'same byte-forwarding wire observer for all conditions', 'requests': max(len(requests), len(records)), 'finishedRequests': len(records), 'unfinishedRequestIds': unfinished, 'usageReportingRequests': len(with_usage), 'coverageComplete': not unfinished and len(with_usage) == len(records) and bool(records), 'rawTotals': dict(totals), 'normalized': {'status': 'available' if complete else 'inconsistent_or_incomplete', 'inputTokens': input_tokens, 'outputTokens': outputs, 'totalTokens': input_tokens + outputs if input_tokens is not None and outputs is not None else None, 'cacheHitTokens': hits, 'cacheRate': hits / input_tokens if input_tokens else None}, 'perRequest': normalized, 'caveat': 'Explicit hit+miss defines input when both exist; raw prompt/total remain unmodified. No inference from SDK-adjusted usage; no monetary cost claim.'}
    save(run / 'usage.json', result)
    return result


def llm_grade(run, condition, model_row, secrets, evidence, result):
    # Scoring is a separate evaluator request and is excluded from deployment usage/time.
    final = ''
    if condition.startswith('MCT'):
        messages = read_json(run / 'messages.json', [])
        if isinstance(messages, list):
            final = '\n'.join(str(m.get('content', '')) for m in messages if m.get('role') == 'assistant')[-12000:]
        if not final and isinstance(result, dict):
            final = '\n'.join(str(step.get('result', {}).get('content', '')) for turn in result.get('details', []) for step in turn.get('steps', []) if step.get('result', {}).get('content'))[-12000:]
    else:
        exported = read_json(run / 'session-export.json', {})
        messages = exported.get('messages', []) if isinstance(exported, dict) else []
        for message in reversed(messages):
            if message.get('type') == 'assistant' or message.get('info', {}).get('role') == 'assistant':
                parts = message.get('content', message.get('parts', []))
                final = '\n'.join(p.get('text', '') for p in parts if isinstance(p, dict) and p.get('type') == 'text')
                if final:
                    break
    material = {
        'condition': condition,
        'executionStatus': result.get('status') if isinstance(result, dict) else None,
        'externalChecks': (evidence or {}).get('checks', {}),
        'logAlerts': (evidence or {}).get('logAlerts', {}),
        'toolErrors': read_json(run / 'timings.json', {}).get('toolErrors'),
        'runnerTiming': read_json(run / 'runner-result.json', {}),
        'finalAgentReport': final[-12000:],
    }
    prompt = ('作为独立评审，按 100 分制评价一次 Minecraft 服务端部署实验，不信任 Agent 自报成功。'
              '权重：外部游戏启动与状态响应25，MCDR 接管及配置15，模板插件加载15，端口/内存/隔离安全15，证据完整与完成状态可核验15，报告真实性和局限披露10，效率5。'
              '只依据材料；未知不能当通过；日志 ERROR/FATAL 不单独否定游戏；插件加载不等于远程功能可用。'
              '返回 JSON：score(0-100整数), breakdown(各项得分与满分), rationale(简短), deductions(数组), confidence(0-1)。\n材料：'
              + json.dumps(material, ensure_ascii=False)[:30000])
    request = urllib.request.Request(model_row['base_url'].rstrip('/') + '/chat/completions', data=json.dumps({
        'model': MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'temperature': 0,
        'stream': False,
    }).encode(), headers={'Authorization': 'Bearer ' + secrets['model'], 'Content-Type': 'application/json'})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
        text = payload.get('choices', [{}])[0].get('message', {}).get('content', '')
        match = re.search(r'\{.*\}', text, re.S)
        if not match:
            raise ValueError('Evaluator response did not contain JSON')
        grade = json.loads(match.group())
        if not isinstance(grade.get('score'), int) or not 0 <= grade['score'] <= 100:
            raise ValueError('Evaluator score is not an integer from 0 to 100')
        out = {'status': 'scored', 'model': MODEL, 'score': grade['score'], 'breakdown': grade.get('breakdown'), 'rationale': grade.get('rationale'), 'deductions': grade.get('deductions'), 'confidence': grade.get('confidence'), 'rawUsage': payload.get('usage'), 'durationMs': round((time.monotonic() - started) * 1000), 'excludedFromDeploymentUsage': True, 'requestPrompt': prompt}
    except Exception as error:
        out = {'status': 'unavailable', 'model': MODEL, 'error': str(error), 'durationMs': round((time.monotonic() - started) * 1000), 'excludedFromDeploymentUsage': True}
    save(run / 'llm-grade.json', out)
    return out


def classify(name, args):
    text = json.dumps(args, ensure_ascii=False).lower()
    if name in ('begin_deployment_workflow', 'update_agent_workflow_progress'):
        return 'unclassified'
    if any(word in name for word in ('startup', 'current_server_command', 'current_server_validation', 'start_current', 'stop_current', 'stopped', 'runtime')) and 'python' not in name:
        return 'final_mcdr_test'
    if any(word in name for word in ('java', 'jdk')):
        return 'check_java_dependencies'
    if any(word in name for word in ('python', 'plugin_dependencies')):
        return 'configure_python'
    if any(word in name for word in ('setup_neoforge', 'setup_forge', 'setup_fabric')):
        return 'install_modloader'
    if any(word in name for word in ('extract', 'mrpack', 'download_mod', 'materialize_curseforge')):
        return 'extract_to_workspace'
    if 'slot' in name or 'upload' in name or 'download_server' in name:
        return 'prepare_server_slot'
    if 'search' in name or 'modpack' in name:
        return 'identify_modpack'
    if any(word in text for word in ('stop\n', 'mcdreforged --', '-m mcdreforged', 'latest.log', 'mcdr.log', 'ss -', 'list\n', 'done \\', 'pgrep', '/proc/')):
        return 'final_mcdr_test'
    if any(word in text for word in ('pip install', 'pip --', 'requirements.txt', 'python3 --version', 'python --version', 'site-packages')):
        return 'configure_python'
    if any(word in text for word in ('config.yml', 'chathub', 'permission.yml', 'start_command', 'mcdr_config')):
        return 'configure_mcdr'
    if any(word in text for word in ('installserver', 'installer.jar', 'fabric-installer')):
        return 'install_modloader'
    if any(word in text for word in ('mods/', 'user_jvm_args', 'unzip', 'extractall', 'eula=', 'server.properties', 'run.sh')):
        return 'extract_to_workspace'
    if any(word in text for word in ('java -version', '/jdks', 'java --version', 'java_home')):
        return 'check_java_dependencies'
    if any(word in text for word in ('manifest.json', 'zipinfo', 'unzip -l', 'zipfile.zipfile', 'readme')):
        return 'identify_modpack'
    return 'unclassified'


def command_outcome(output):
    """Extract structured shell failure information without trusting prose."""
    if not isinstance(output, str):
        return {'error': False, 'exitCode': None, 'signal': None, 'timedOut': False}
    tool_error = output.startswith('TOOL_ERROR')
    try:
        if tool_error and '{' in output:
            value, _ = json.JSONDecoder().raw_decode(output[output.index('{'):])
        else:
            value = json.loads(output)
    except (TypeError, ValueError):
        return {'error': tool_error, 'exitCode': None, 'signal': None, 'timedOut': False, 'reason': 'tool_error' if tool_error else None}
    if not isinstance(value, dict) or not any(key in value for key in ('exitCode', 'signal', 'timedOut')):
        return {'error': tool_error, 'exitCode': None, 'signal': None, 'timedOut': False, 'reason': 'tool_error' if tool_error else None}
    exit_code = value.get('exitCode')
    signal_name = value.get('signal')
    timed_out = value.get('timedOut') is True
    failed = tool_error or (isinstance(exit_code, (int, float)) and exit_code != 0) or bool(signal_name) or timed_out
    return {'error': failed, 'exitCode': exit_code, 'signal': signal_name, 'timedOut': timed_out,
            **({'reason': 'nonzero_exit'} if failed and isinstance(exit_code, (int, float)) and exit_code != 0 else {}),
            **({'reason': 'signal'} if failed and signal_name else {}),
            **({'reason': 'timeout'} if failed and timed_out else {})}


def union_ms(intervals):
    out = 0
    end = None
    for start, finish in sorted(intervals):
        out += max(0, finish - max(start, end if end is not None else start))
        end = max(end or finish, finish)
    return round(out)


def timing_metrics(run, condition):
    calls, steps, workflow = [], [], []
    if condition.startswith('MCT'):
        result = read_json(run / 'result.json', {})
        for turn in result.get('details', []):
            for call in turn.get('toolCalls', []):
                args = call.get('arguments', {})
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except ValueError:
                        pass
                outcome = command_outcome(call.get('output', ''))
                calls.append({'id': call['id'], 'name': call['name'], 'phase': classify(call['name'], args), 'startedAtMs': stamp(call.get('startedAt')), 'finishedAtMs': stamp(call.get('finishedAt')), 'status': call.get('status'), 'error': outcome['error'], 'exitCode': outcome.get('exitCode'), 'signal': outcome.get('signal'), 'timedOut': outcome.get('timedOut'), 'errorReason': outcome.get('reason')})
            steps += [{'id': x['id'], 'startedAtMs': stamp(x.get('startedAt')), 'finishedAtMs': stamp(x.get('finishedAt'))} for x in turn.get('steps', [])]
        workflow = result.get('timings', {}).get('workflow', [])
    else:
        events = jsonl(run / 'events.jsonl')
        for event in events:
            if event.get('type') == 'tool_use':
                part = event.get('part', {})
                state = part.get('state', {})
                t = state.get('time', part.get('time', {}))
                outcome = command_outcome(state.get('output', state.get('error', '')))
                metadata = state.get('metadata', {})
                exit_code = metadata.get('metadata', {}).get('exit') if isinstance(metadata, dict) else None
                if isinstance(exit_code, int):
                    outcome.update(exitCode=exit_code, error=exit_code != 0, reason='nonzero_exit' if exit_code else None)
                failed = state.get('status') == 'error' or outcome['error']
                calls.append({'id': part.get('id'), 'name': part.get('tool'), 'phase': classify(part.get('tool', ''), state.get('input', {})), 'startedAtMs': stamp(t.get('start')), 'finishedAtMs': stamp(t.get('end')), 'status': state.get('status'), 'error': failed, 'exitCode': outcome.get('exitCode'), 'signal': outcome.get('signal'), 'timedOut': outcome.get('timedOut'), 'errorReason': outcome.get('reason')})
        starts = {}
        for event in events:
            part = event.get('part', {})
            if event.get('type') == 'step_start':
                starts[part.get('messageID')] = event.get('timestamp')
            if event.get('type') == 'step_finish':
                steps.append({'id': part.get('messageID'), 'startedAtMs': starts.get(part.get('messageID')), 'finishedAtMs': event.get('timestamp')})
    dedup = {c['id']: c for c in calls}
    calls = list(dedup.values())
    phases = []
    for phase in PHASES:
        selected = [c for c in calls if c['phase'] == phase]
        intervals = [(c['startedAtMs'], c['finishedAtMs']) for c in selected if c['startedAtMs'] is not None and c['finishedAtMs'] is not None]
        phases.append({'id': phase, 'toolCalls': len(selected), 'toolActiveUnionMs': union_ms(intervals), 'spanMs': round(max(x[1] for x in intervals) - min(x[0] for x in intervals)) if intervals else None, 'status': 'observed' if selected else 'not_observed', 'source': 'tool semantic classification; intervals may overlap across phases; not pure model time'})
    wires = jsonl(run / 'wire-usage.jsonl')
    model_intervals = [(stamp(r['startedAt']), stamp(r['finishedAt'])) for r in wires if r.get('model') == MODEL]
    result = {'phases': phases, 'workflow': workflow, 'workflowTimingCaveat': 'MCT-full workflow boundaries are polling observations, not comparable with semantic tool phase spans.', 'modelWireActiveUnionMs': union_ms(model_intervals), 'toolActiveUnionMs': union_ms([(c['startedAtMs'], c['finishedAtMs']) for c in calls if c['startedAtMs'] is not None and c['finishedAtMs'] is not None]), 'modelSteps': len(steps), 'toolCalls': len(calls), 'toolErrors': sum(bool(c['error']) for c in calls), 'askUserCalls': sum(c['name'] in ('ask_user', 'question') for c in calls), 'steps': steps, 'calls': calls}
    save(run / 'timings.json', result)
    return result


def archive_workspace(ws, run):
    # Preserve runtime modifications and newly installed dependencies as well.
    output = run / 'workspace.tar.gz'
    with (run / 'archive.log').open('w') as log:
        subprocess.run(['tar', '-czf', str(output), '-C', str(ws.parent), ws.name], stdout=log, stderr=subprocess.STDOUT, check=True, timeout=900)
        subprocess.run(['tar', '-tzf', str(output)], stdout=subprocess.DEVNULL, stderr=log, check=True, timeout=180)
    save(run / 'workspace-artifact.json', {'originalPath': str(ws), 'archive': str(output), 'sha256': sha(output), 'bytes': output.stat().st_size, 'verifiedReadable': True, 'excludedPaths': [], 'runtimePathsMayNeedAdjustmentAfterRestore': True})
    # Only this newly-created run's temporary workspace, after successful archive and stop.
    if not ws.is_relative_to(pathlib.Path('/tmp/opencode/benchmark-suite-20261021')) or processes(ws):
        raise RuntimeError('Refusing workspace deletion outside suite root or with active processes')
    shutil.rmtree(ws)


def write_rollup(outroot):
    summaries = [read_json(folder) for folder in sorted(outroot.glob('*/*/summary.json'))]
    summaries = [item for item in summaries if isinstance(item, dict)]
    save(outroot / 'results.json', summaries)
    import csv
    with (outroot / 'results.csv').open('w', newline='') as stream:
        writer = csv.writer(stream)
        writer.writerow(['server', 'condition', 'status', 'wall_time_ms', 'raw_prompt_tokens', 'raw_completion_tokens', 'raw_total_tokens', 'observed_cache_hit_tokens', 'normalized_input_tokens', 'cache_rate', 'model_steps', 'tool_calls', 'tool_errors', 'mcdr_config', 'mcdr_owns_java', 'plugins_loaded', 'game_started', 'llm_score', 'cleanup_passed'])
        for item in summaries:
            checks, raw, usage = item.get('checks', {}), item.get('rawUsage', {}), item.get('usage', {})
            writer.writerow([item.get('server'), item.get('condition'), item.get('status'), item.get('wallTimeMs'), raw.get('prompt_tokens'), raw.get('completion_tokens'), raw.get('total_tokens'), raw.get('observed_cache_hit_tokens'), usage.get('inputTokens'), usage.get('cacheRate'), item.get('modelSteps'), item.get('toolCalls'), item.get('toolErrors'), checks.get('mcdrConfigured'), checks.get('mcdrLoadedAtStartup'), checks.get('pluginsLoaded'), checks.get('serverStarted'), item.get('llmReview', {}).get('score'), item.get('cleanup', {}).get('passed')])
    return summaries


def copy_config(ws):
    src = sqlite3.connect(f'file:{PROJECT}/workspace/data/app.db?mode=ro', uri=True)
    dst = sqlite3.connect(ws / 'data/app.db')
    for table in ('app_settings', 'model_configs', 'skills'):
        cols = [r[1] for r in src.execute(f'pragma table_info({table})')]
        for row in src.execute(f'select * from {table}'):
            row = list(row)
            if table == 'skills':
                target = ws / 'skills' / row[cols.index('id')]
                shutil.copytree(row[cols.index('path')], target, dirs_exist_ok=True)
                row[cols.index('path')] = str(target)
            dst.execute(f'insert or replace into {table} ({",".join(cols)}) values ({",".join("?" for _ in cols)})', row)
    dst.commit()
    dst.close()
    src.close()


def make_task(entry, archive, name, port):
    kind = '服务端包' if entry.get('serverPack') else '客户端 manifest 整合包（无官方服务端包，需要根据包内 manifest 组装兼容服务端）'
    return (f'部署本次提供并已确认的本地{kind}：{archive.name}（{entry["project"]["name"]}）。'
            '使用提供的原始 MCDReforged 模板管理启动，完成所需 Java、Loader、独立 Python、MCDR 和模板插件配置，验证 Minecraft 与所有模板插件加载。'
            f'服务端名称 {name}；Minecraft 只绑定 127.0.0.1:{port}，禁用 RCON/query，内存上限及推荐值 3584M，已同意 EULA。'
            '仅操作本次 workspace，不影响其他实例，不更换已确认包和版本。不能提问；缺少无法自行核实的必要条件则明确失败，不伪造成功。'
            '日志 ERROR/FATAL 与游戏运行、插件加载分别报告，不仅凭报错禁模组或重启。'
            '模板外部生产消息桥未获得本轮连接授权，禁止向生产 ChatHub 发送消息；可以保留插件加载并阻断外连，但须单独报告远程功能未验收。'
            '下载使用提供的代理与官方 API。成功后保持 MCDR 与 Minecraft 运行供外部验收，由 runner 正常停服。')


def execute_run(entry, condition, index, outroot, tmproot, model_row, secrets, http_port, ablation_profile=None):
    slug = entry['project']['slug']
    run = outroot / slug / condition
    if (run / 'summary.json').exists():
        old = read_json(run / 'summary.json')
        if not old.get('cleanup', {}).get('passed'):
            raise RuntimeError(f'Previous run needs cleanup: {run}')
        artifact = read_json(run / 'workspace-artifact.json', {})
        if not artifact.get('verifiedReadable'):
            raise RuntimeError(f'Previous run archive is not proven: {run}')
        if not (run / 'workspace.tar.gz').is_file():
            # An archive removed after verification is deliberate disk
            # reclamation, not an incomplete trial; the digest is retained.
            pruned = artifact.get('pruned')
            if not isinstance(pruned, dict) or pruned.get('sha256') != artifact.get('sha256') \
                    or pruned.get('verifiedReadableBeforePrune') is not True:
                raise RuntimeError(f'Previous run archive is missing without verified pruning: {run}')
        print('SKIP existing', slug, condition, flush=True)
        return old
    if run.exists() and any(run.iterdir()):
        raise RuntimeError(f'Incomplete output exists; inspect before reuse: {run}')
    run.mkdir(parents=True, mode=0o700, exist_ok=True)
    ws = tmproot / slug / condition / 'workspace'
    ws.mkdir(parents=True, mode=0o700)
    mc_port = 25700 + index
    if occupied(mc_port) or occupied(http_port):
        raise RuntimeError('Experiment port occupied; will not touch owner')
    archive = PROJECT / (entry.get('serverPack') or entry['clientPack'])['path']
    name = f'exp-{slug[:35]}-{condition.lower()}'
    setup = {'entry': entry, 'condition': condition, 'workspace': str(ws), 'minecraftPort': mc_port, 'model': MODEL, 'archive': str(archive), 'archiveSha256': sha(archive), 'templateFiles': {str(p.relative_to(PROJECT / 'benchmark/mcdr-template')): sha(p) for p in (PROJECT / 'benchmark/mcdr-template').rglob('*') if p.is_file()}, 'runtimeBaselines': {'java': str(BASELINE / 'jdks-baseline'), 'python': str(BASELINE / 'python-baseline'), 'note': 'copied with reflink when available; full runtime modifications included in archive'}, 'sourceHashes': {str(p.relative_to(PROJECT)): sha(p) for folder in ('apps/server/src', 'scripts') for p in (PROJECT / folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts}, 'memoryMb': 3584, 'proxy': PROXY, 'timeoutMs': TIMEOUT * 1000, 'createdAt': iso(), 'server': {'id': name, 'directory': str(ws / 'servers' / name)}}
    save(run / 'setup.json', setup)
    start_prepare = time.monotonic()
    env = dict(os.environ, WORKSPACE_ROOT=str(ws), APP_HOST='127.0.0.1', APP_PORT=str(http_port), TMPDIR=str(ws.parent), APP_PASSWORD='ilovemct', BENCH_RESULT_DIR=str(run))
    if ablation_profile is not None:
        env['BENCH_ABLATION_PROFILE'] = ablation_profile
        setup['ablationProfile'] = ablation_profile
    for key in list(env):
        if key.startswith('OPENCODE_'):
            del env[key]
    backend = proxy_proc = cli = None
    api = None
    sid = None
    error = None
    result = {}
    evidence = None
    cleanup = None
    logs = []
    try:
        for name_runtime in ('jdks', 'python'):
            (ws / name_runtime).mkdir()
            subprocess.run(['cp', '-a', '--reflink=auto', str(BASELINE / (name_runtime + '-baseline')) + '/.', str(ws / name_runtime)], check=True)
        proxy_log = (run / 'proxy.log').open('w'); logs.append(proxy_log)
        proxy_env = dict(env, BENCH_RESULT_DIR=str(run), BENCH_UPSTREAM_URL=model_row['base_url'], BENCH_MODEL_KEY=secrets['model'])
        proxy_proc = subprocess.Popen(['node', 'scripts/benchmark-wire-proxy.mjs'], cwd=PROJECT, env=proxy_env, stdout=proxy_log, stderr=subprocess.STDOUT)
        for _ in range(100):
            ready = read_json(run / 'proxy-ready.json')
            if ready:
                break
            if proxy_proc.poll() is not None:
                raise RuntimeError('Usage observer exited')
            time.sleep(.05)
        else:
            raise RuntimeError('Usage observer did not become ready')
        endpoint = f'http://127.0.0.1:{ready["port"]}/v1'
        task = make_task(entry, archive, name, mc_port)
        if condition.startswith('MCT'):
            run_node('import {ensureRuntimeDirectories} from "./apps/server/src/runtime.ts";import {initDatabase} from "./apps/server/src/db/client.ts";await ensureRuntimeDirectories();initDatabase();', env)
            copy_config(ws)
            log = (run / 'backend.log').open('w'); logs.append(log)
            preloads = ['--import', './scripts/benchmark-ablation-preload.mjs'] if ablation_profile is not None else []
            backend = subprocess.Popen(['node', '--import', 'tsx', '--import', './scripts/benchmark-observer.mjs', *preloads, 'apps/server/src/main.ts'], cwd=PROJECT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            (run / 'backend.pid').write_text(str(backend.pid))
            api = API(http_port)
            for _ in range(150):
                try:
                    api.login()
                    break
                except Exception:
                    if backend.poll() is not None:
                        raise RuntimeError('Isolated backend exited')
                    time.sleep(.2)
            assert api('/api/meta')['workspaceRoot'] == str(ws)
            # Replace only the fresh runtime template snapshot before creating a server.
            template = ws / 'templates/reference'
            shutil.rmtree(template)
            shutil.copytree(PROJECT / 'benchmark/mcdr-template', template)
            settings = api('/api/settings/agent', 'PUT', {'autoConfirm': True, 'memoryMb': 3584, 'downloadProxyEnabled': True, 'downloadProxyUrl': PROXY, 'pythonPackageIndexUrl': 'https://pypi.tuna.tsinghua.edu.cn/simple'})
            api('/api/models', 'POST', {'displayName': 'Serial experiment wire observed', 'baseUrl': endpoint, 'apiKey': 'local-observer', 'modelName': MODEL, 'apiType': 'chat_completions', 'isDefault': True, 'contextSizeK': 200, 'availableModels': [MODEL]})
            server = api('/api/servers', 'POST', {'name': name})
            sid = server['id']
            setup['server'] = server
            setup['settings'] = settings
            root = pathlib.Path(server['directory'])
            save(run / 'workflow-snapshot.json', api('/api/settings/deployment-workflow'))
            save(run / 'global-prompt.json', api('/api/prompts/global'))
            boundary = 'Benchmark' + uuid.uuid4().hex
            body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{archive.name}"\r\nContent-Type: application/zip\r\n\r\n'.encode() + archive.read_bytes() + f'\r\n--{boundary}--\r\n'.encode())
            setup['slot'] = api(f'/api/servers/{sid}/agent/server-slot/upload', 'POST', body, 'multipart/form-data; boundary=' + boundary)
            task += f' 本地包已上传当前服务端槽位；模板已经位于当前服务端根目录 {root}。'
            args = ['node', 'scripts/benchmark.mjs', '--base-url', api.base, '--server-id', sid, '--mode', 'full' if condition == 'MCT-full' else 'basic', '--model', MODEL, '--timeout-ms', str(TIMEOUT * 1000), '--json', '--task-file', str(run / 'task.txt')]
        else:
            root = pathlib.Path(setup['server']['directory'])
            root.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(PROJECT / 'benchmark/mcdr-template', root)
            inputs = ws / 'inputs'; inputs.mkdir()
            shutil.copy2(archive, inputs / archive.name)
            # Keep isolated OpenCode session/config/log data inside the archived
            # trial workspace, not in an unarchived sibling directory.
            home = ws / '.benchmark-home'; home.mkdir()
            env.update(HOME=str(home), XDG_CONFIG_HOME=str(home / '.config'), XDG_DATA_HOME=str(home / '.local/share'), XDG_STATE_HOME=str(home / '.local/state'), XDG_CACHE_HOME=str(home / '.cache'), BENCH_MODEL_KEY='local-observer', PWD=str(ws), CURSEFORGE_API_KEY=secrets.get('curseforge_api_key', ''), MODRINTH_TOKEN=secrets.get('modrinth_api_key', ''))
            system = '你是 Minecraft 服务端部署助手。使用提供的工具完成用户任务，仅操作当前测试 workspace，不影响其他实例。不得伪造执行结果。此为非交互测试，不得向用户提问或等待回答；必要信息无法获取时明确失败。持续运行进程仅可在本测试目录内创建并记录 PID，以便验收后清理。'
            permissions = [{'action': '*', 'resource': '*', 'effect': 'allow'}] + [{'action': a, 'resource': '*', 'effect': 'deny'} for a in ('question', 'ask_user', 'skill', 'subagent')]
            config = {'$schema': 'https://opencode.ai/config.json', 'model': 'benchmark/' + MODEL, 'default_agent': 'benchmark', 'snapshots': False, 'warming': False, 'agents': {'benchmark': {'mode': 'primary', 'system': system, 'permissions': permissions}}, 'permissions': permissions, 'providers': {'benchmark': {'name': 'Same upstream byte-observed', 'env': ['BENCH_MODEL_KEY'], 'package': '@opencode/ai/providers/openai-compatible', 'settings': {'baseURL': endpoint}, 'body': {'reasoning_effort': 'high'}, 'models': {MODEL: {'name': MODEL, 'limit': {'context': 200000, 'output': 32768}, 'capabilities': {'tools': True}}}}}}
            save(ws / 'opencode.json', config)
            (run / 'system-prompt.txt').write_text(system)
            save(run / 'opencode-config.json', config)
            task += (f' 环境映射（仅事实，不提供部署步骤）：workspace={ws}；MCDR 模板根目录={root}，原始包={inputs / archive.name}；Java={ws}/jdks，独立 Python={ws}/python；下载代理={PROXY}，Python 包镜像=https://pypi.tuna.tsinghua.edu.cn/simple。'
                     '官方 API 凭据在环境变量 CURSEFORGE_API_KEY/MODRINTH_TOKEN（如非空），禁止打印凭据。没有面板工具，使用原生文件/Shell 工具。常驻服务记录 PID、持久命令输入入口和独立日志；完成后保持运行供外部验收。')
            args = ['/home/apricityx/.npm-global/bin/opencode', 'run', '--standalone', '--auto', '--format', 'json', '--agent', 'benchmark', '--model', 'benchmark/' + MODEL, task]
        # Prevent accidental production bridge side effects equally in all conditions.
        # No deployment answer, Loader version, or prior successful outputs are supplied.
        chat = root / 'config/chathub/chathub.json'
        if chat.exists():
            cfg = json.loads(chat.read_text())
            cfg.update(server_url='ws://127.0.0.1:9/benchmark-disabled', password='', node_id=f'exp-{index}', name=setup['server'].get('name', name))
            chat.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
            setup['templateSafetyOverlay'] = {'server_url': 'ws://127.0.0.1:9/benchmark-disabled', 'node_id': f'exp-{index}', 'password': 'cleared', 'scope': 'external ChatHub not tested; original template SHA recorded'}
        setup['prepareMs'] = round((time.monotonic() - start_prepare) * 1000)
        setup['backendPid'] = backend.pid if backend else None
        save(run / 'setup.json', setup)
        (run / 'task.txt').write_text(task)
        started = time.monotonic()
        started_at = iso()
        print('RUN', slug, condition, f'port={mc_port}', flush=True)
        output = run / ('result.json' if condition.startswith('MCT') else 'events.jsonl')
        with output.open('w') as out, (run / 'timing.log').open('w') as err:
            cli = subprocess.Popen(args, cwd=PROJECT if condition.startswith('MCT') else ws, env=env, stdout=out, stderr=err, start_new_session=True)
            try:
                code = cli.wait(timeout=TIMEOUT + 100)
            except subprocess.TimeoutExpired:
                if api and sid:
                    api(f'/api/servers/{sid}/agent/cancel', 'POST')
                stop_child(cli)
                code = 124
        elapsed = round((time.monotonic() - started) * 1000)
        if condition.startswith('MCT'):
            result = read_json(run / 'result.json', {'status': 'runner_failed'})
            # Include background Job/Inbox state, not just the model's final completion claim.
            for suffix, filename in [('tools/jobs', 'jobs.json'), ('inbox', 'inbox.json'), ('messages', 'messages.json')]:
                try:
                    save(run / filename, api(f'/api/servers/{sid}/agent/{suffix}'))
                except Exception as err:
                    save(run / filename, {'error': str(err)})
            try:
                save(run / 'inbox-events.json', api(f'/api/servers/{sid}/agent/inbox/events?after=0'))
            except Exception as err:
                save(run / 'inbox-events.json', {'error': str(err)})
        else:
            result = {'status': 'cli_exited' if code == 0 else 'timed_out' if code == 124 else 'failed', 'exitCode': code, 'wallTimeMs': elapsed}
            save(run / 'result.json', result)
            session = next((e.get('sessionID') for e in jsonl(run / 'events.jsonl') if e.get('sessionID')), None)
            if session:
                with (run / 'session-export.json').open('w') as out, (run / 'export.log').open('w') as err:
                    subprocess.run(['/home/apricityx/.npm-global/bin/opencode', 'session', 'export', '--standalone', session], cwd=ws, env=env, stdout=out, stderr=err, timeout=60)
        save(run / 'runner-result.json', {'startedAt': started_at, 'finishedAt': iso(), 'wallTimeMs': elapsed, 'exitCode': code, 'prepareMs': setup['prepareMs']})
        evaluate_start = time.monotonic()
        evidence = evaluate(run, setup)
        setup['evaluationMs'] = round((time.monotonic() - evaluate_start) * 1000)
    except BaseException as err:
        error = repr(err)
        (run / 'runner-error.txt').write_text(traceback.format_exc())
        print('RUN_ERROR', slug, condition, error, flush=True)
    finally:
        try:
            if cli and cli.poll() is None:
                if api and sid:
                    api(f'/api/servers/{sid}/agent/cancel', 'POST')
                stop_child(cli)
            if api and sid:
                api(f'/api/servers/{sid}/agent/cancel', 'POST')
                for job in api(f'/api/servers/{sid}/agent/tools/jobs'):
                    if job.get('status') in ('running', 'queued', 'pending'):
                        api(f'/api/servers/{sid}/agent/tools/jobs/{job["id"]}', 'DELETE')
            cleanup = stop_server(ws, mc_port, api, sid)
            save(run / 'cleanup.json', cleanup)
        except BaseException as err:
            cleanup = {'passed': False, 'error': repr(err), 'processes': processes(ws)}
            save(run / 'cleanup.json', cleanup)
        if cleanup and cleanup.get('passed'):
            stop_child(backend)
            stop_child(proxy_proc)
        for log in logs:
            log.close()
    usage = usage_metrics(run)
    timings = timing_metrics(run, condition)
    runner = read_json(run / 'runner-result.json', {})
    grade = llm_grade(run, condition, model_row, secrets, evidence, result)
    summary = {'server': slug, 'condition': condition, 'directory': str(run), 'status': result.get('status', 'runner_failed'), 'runnerError': error, 'wallTimeMs': runner.get('wallTimeMs', result.get('wallTimeMs')), 'prepareMs': setup.get('prepareMs'), 'evaluationMs': setup.get('evaluationMs'), 'usage': usage['normalized'], 'rawUsage': usage['rawTotals'], 'usageCoverage': {'requests': usage['requests'], 'reporting': usage['usageReportingRequests']}, 'modelSteps': timings['modelSteps'], 'toolCalls': timings['toolCalls'], 'toolErrors': timings['toolErrors'], 'askUserCalls': timings['askUserCalls'], 'phaseTimings': timings['phases'], 'modelWireActiveUnionMs': timings['modelWireActiveUnionMs'], 'toolActiveUnionMs': timings['toolActiveUnionMs'], 'checks': {k: v['passed'] for k, v in (evidence or {}).get('checks', {}).items()}, 'logAlerts': (evidence or {}).get('logAlerts', {}).get('count'), 'cleanup': cleanup, 'llmReview': {'status': 'pending', 'scale': '0-100; independent assistant review, not model self-rating'}, 'finishedAt': iso()}
    summary['llmReview'] = {'status': grade['status'], 'score': grade.get('score'), 'model': MODEL, 'excludedFromDeploymentUsage': True}
    save(run / 'summary.json', summary)
    if not cleanup or not cleanup.get('passed'):
        raise RuntimeError(f'Cleanup not proven for {slug}/{condition}; serial suite halted')
    archive_workspace(ws, run)
    print('DONE', slug, condition, json.dumps({'wallTimeMs': summary['wallTimeMs'], 'checks': summary['checks'], 'cacheRate': summary['usage']['cacheRate']}), flush=True)
    return summary


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--server', action='append')
    parser.add_argument('--condition', action='append', choices=CONDITIONS)
    parser.add_argument('--http-port', type=int, default=8801)
    options = parser.parse_args()
    outroot = PROJECT / 'exp'
    tmproot = pathlib.Path('/tmp/opencode/benchmark-suite-20261021')
    tmproot.mkdir(mode=0o700, exist_ok=True)
    lock = (tmproot / 'suite.lock').open('w')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    manifest = json.loads((PROJECT / 'benchmark/manifest.json').read_text())
    row, secrets = credentials()
    entries = manifest['entries']
    inventory = {'createdAt': iso(), 'model': MODEL, 'conditions': CONDITIONS, 'entries': entries, 'order': 'manifest order; full -> minimal -> OpenCode; strictly serial', 'timeoutMs': TIMEOUT * 1000, 'memoryMb': 3584, 'javaBaseline': str(BASELINE / 'jdks-baseline'), 'pythonBaseline': str(BASELINE / 'python-baseline'), 'limitations': ['One observation per condition, not three replicates per condition.', 'Fixed order; warm filesystem/network/upstream caches and machine load can influence results.', 'System comparison: MCT domain tools and full workflow differ from OpenCode native tools.', 'All original template plugin IDs are required for plugin-load pass; remote ChatHub intentionally blocked equally.', 'Phase semantic classification is inferred from tool operations; unknown is retained, not filled with fabricated zero durations.']}
    if not (outroot / 'experiment.json').exists():
        save(outroot / 'experiment.json', inventory)
        hashes = {str(p.relative_to(PROJECT)): sha(p) for folder in ('apps/server/src', 'scripts', 'templates/reference') for p in (PROJECT / folder).rglob('*') if p.is_file()}
        save(outroot / 'source-sha256.json', hashes)
        with (outroot / 'source-tracked.patch').open('w') as output:
            subprocess.run(['git', 'diff', '--binary'], cwd=PROJECT, stdout=output, check=True)
    summaries = []
    for i, entry in enumerate(entries):
        if options.server and entry['project']['slug'] not in options.server:
            continue
        for j, condition in enumerate(CONDITIONS):
            if options.condition and condition not in options.condition:
                continue
            if shutil.disk_usage(PROJECT).free < 3 * 1024 ** 3:
                raise RuntimeError('Less than 3 GiB free; stopping before another deployment')
            save(outroot / 'progress.json', {'status': 'running', 'server': entry['project']['slug'], 'condition': condition, 'updatedAt': iso(), 'runnerPid': os.getpid(), 'completed': len(summaries)})
            summaries.append(execute_run(entry, condition, i * 3 + j, outroot, tmproot, row, secrets, options.http_port))
            write_rollup(outroot)
    save(outroot / 'progress.json', {'status': 'completed', 'updatedAt': iso(), 'runnerPid': os.getpid(), 'completed': len(summaries)})
    subprocess.run(['python3', 'scripts/benchmark-report.py', '--verify-hashes'], cwd=PROJECT, check=True)
    print('SUITE FINISHED', len(summaries), flush=True)


if __name__ == '__main__':
    main()
