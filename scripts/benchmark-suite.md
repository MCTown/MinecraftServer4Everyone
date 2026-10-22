# Serial Deployment Benchmark

The suite reads `benchmark/manifest.json` in manifest order and runs each package
once under `MCT-full`, `MCT-minimal`, and `Opencode-minimal`, in that order.
This is one observation per condition, not three replicates per condition.

```sh
python3 -u scripts/benchmark-suite.py
```

For a single condition:

```sh
python3 -u scripts/benchmark-suite.py --server the-pixelmon-modpack --condition MCT-full
```

## Boundaries

- The main HTTP API on port 1143 is forbidden by the runner.
- Each trial gets a fresh workspace below `/tmp/opencode/benchmark-suite-20261021`.
- Model: `deepseek-v4-flash-vision-exp`; reasoning effort: high; memory: 3584 MiB.
- Runtime inputs are copied from the established Java/Python baselines.
- Same original MCDR template and package bytes; SHA-256 values are recorded.
- The original template's production ChatHub identity/password are replaced with
  a unique identity and a deliberately unreachable loopback endpoint equally in
  every condition. Plugin load and external bridge functionality are distinct.
- MCT-full retains the current system prompt, skills, tools and workflow.
  MCT-minimal uses the backend's existing `basic` benchmark condition.
  OpenCode-minimal uses native tools, an isolated HOME and a minimal system prompt.
  Interactive questions, subagents and additional skills are denied for OpenCode;
  MCT benchmark modes do not register `ask_user`.
- Runs are serial under a process lock. Normal stop is sent only to the current
  trial through its owned API or verified MCDR stdin. No automatic force-kill.
- Remaining game processes or occupied ports halt the suite. A verified archive
  is retained before deleting only that trial's temporary workspace.
- Existing summaries are skipped only when their cleanup is proven. Incomplete
  trial directories require inspection; they are never silently overwritten.
  A verified workspace archive must also exist before a completed trial is skipped.
- MCT tasks are passed through `--task-file`, so task paths cannot make the
  benchmark client appear to be a residual server in command-line inspection.
  Infrastructure-invalid attempts are preserved under `exp/invalid-attempts/`
  and excluded from the formal matrix, not relabeled as deployment failures.

## Results

Every trial writes to `exp/<slug>/<condition>/`:

- `setup.json`, `task.txt`: input hashes, environment, exact task and safety overlay.
- `model-requests.jsonl`: actual model request payloads, including system prompts.
- `wire-usage.jsonl`, `usage.json`: unchanged upstream usage plus conservative
  normalization. `cached_tokens > prompt_tokens` without explicit miss counts
  is inconsistent; no guessed rate or billable input total is produced.
- `result.json`, `timings.json`: persisted execution/tool details, semantic phases,
  model/tool interval unions and workflow observations where available.
- `evidence.json`: process ancestry, loopback listener, Minecraft protocol status,
  MCDR configuration, expected plugin load, memory and independent log alerts.
- `owned-launches.jsonl`, `owned-process-output.jsonl`: launch identity and actual
  owned child stdout/stderr, never the mixed presentation console (observer-enabled
  trials only; missing coverage is explicitly disclosed).
- `llm-grade.json`: separate evaluator request, rubric, score, rationale and usage.
  This subjective score is not a substitute for external checks and is excluded
  from deployment time/usage. Same model family is used, in a separate request.
- `cleanup.json`: normal stop actions and final process/port state.
- `workspace.tar.gz`, `workspace-artifact.json`: full trial workspace, including
  resulting server files, runtime, database, configuration and logs. Archive is
  tested and hashed before its temporary original is removed.
- `summary.json`: compact trial result. `exp/results.json` and `exp/results.csv`
  aggregate all summaries; `exp/progress.json` reports the active condition.

Results are local, ignored by Git and may contain sensitive configuration or tool
output. Do not publish raw archives or transcripts without redaction.

## Timing Interpretation

Deployment wall time begins at CLI launch and ends at CLI exit. Preparation,
external evaluation, LLM review, shutdown and archiving are separate work.
Model wire intervals contain network and generation time. Tool intervals can run
concurrently. Semantic phase spans can overlap and must not be added as if they
partitioned wall time. A phase not observed is unknown, not an invented zero.
MCT workflow boundaries are polling observations, not exact model-only durations.

This fixed-order, single-run matrix is a system comparison. Domain-specific MCT
tools/workflow versus native OpenCode tools, cache warming, downloads, machine
load and model randomness prevent attributing all differences to prompts alone.
Minecraft status and plugin load do not establish player login, full gameplay,
plugin functionality or production external service behavior.

## Checks

```sh
python3 scripts/benchmark-suite.test.py -v
python3 scripts/benchmark-report.test.py -v
node --test scripts/benchmark-cli.test.mjs scripts/benchmark-wire-proxy.test.mjs scripts/benchmark-timing.test.mjs
python3 -m py_compile scripts/benchmark-suite.py
node --check scripts/benchmark-wire-proxy.mjs
node --check scripts/benchmark-observer.mjs
git diff --check
```

After the matrix, generate the completion audit and report:

```sh
python3 scripts/benchmark-report.py --verify-hashes
```

This writes `exp/audit.json`, `exp/phase-timings.csv`, `exp/REPORT.md` and
`exp/REPORT.html`. A deployment failure can be a completed experiment; missing
metrics, cleanup proof, scoring or archive evidence cannot. The audit enumerates
all 21 expected directories rather than counting only summaries that exist.
