# Full-agent mechanism ablation

This is an execution protocol, not a production optimization. Six conditions,
**one fresh deployment each**, as requested. No repeat is silently added.

Target: the same Pixelmon 9.3.14 original archive/template as the earlier matrix.
All use `deepseek-v4-flash-vision-exp`, high reasoning, 3584M, Java/Python
baselines and the existing full AgentService/tool/process-management path.

## Conditions

| Profile | Removed / changed | Kept |
| --- | --- | --- |
| control | Nothing | Original full prompt/skills/runtime/tools/workflow |
| no-skill | Enabled Skill contents | Base prompt, workflow, runtime, tools |
| no-progress | Model progress tool + mandatory reporting wording | Backend progress events, technical stages, scheduler |
| single-turn | Begin/scheduler tool + conflicting turn directives | Full technical stage instructions, progress tool, runtime facts |
| lean-runtime | Repeated policy lines in runtime snapshots | All runtime facts, current-round instructions, static full prompt |
| compact-static | Replace verbose static prompt with human semantic compression | Stage IDs, technical/safety contract, tools, scheduler, full runtime |

Control runs first. Remaining order was randomized with seed 20261022 before
observing outcomes: no-progress, lean-runtime, no-skill, compact-static,
single-turn. Fixed first control means cache/order effects are not eliminated.

## Evidence and boundaries

- Dedicated loopback backend only; experiment preload refuses production or
  workspaces outside the isolated ablation prefix. No production policy edits.
- The actual model request log verifies system text and tool schema interventions.
- Each profile gets an independent temporary workspace and original inputs;
  archive and template hashes must match the control.
- The task differs only by trial identity/path/port. Production ChatHub is blocked
  identically. Success claims need external MCDR/plugin/Minecraft/listener/memory
  checks, not the model's final prose.
- Serial suite lock; graceful stop; no next trial if cleanup is unproven.
- Full archive is verified before deleting only the completed trial workspace.
- Outputs: `exp/ablation-full-20261022/ablation-<profile>/MCT-full/`.
- Protocol/order is frozen in `protocol.json`; no repeat until separately agreed.

## Analysis

Primary: deployment wall time, model wire active time, number of model requests,
raw completion tokens, tool calls, progress calls and external quality checks.
Also inspect turns, Shell/Loader/start/validation calls to explain differences.
Each trial retains semantic stage timings and original usage. The upstream cache
accounting remains inconsistent, so no invented cache rate/input total/cost.

Separate evaluator requests produce secondary subjective grades; safety, outcome
and cleanup remain externally checked. Do not promote a faster failed deployment
as a successful optimization. One run cannot identify variance or statistical
significance. Single-turn and compact-static each change semantic instruction
structure, so neither isolates pure character-length latency.

Run `python3 scripts/benchmark-ablation-report.py` after completion to generate
`analysis.json`, `REPORT.md` and `REPORT.html`. This reads original evidence;
it does not rewrite trial timings, scores or checkpoints.

## Checks

```sh
node --test scripts/benchmark-ablation.test.mjs
python3 scripts/benchmark-ablation-report.test.py -v
python3 scripts/benchmark-suite.test.py -v
```
