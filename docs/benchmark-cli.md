# Benchmark CLI

Benchmark runs use the existing MCTAgent HTTP/AgentService path. The CLI does
not implement deployment tools, workflow scheduling, model calls, or process
management itself.

## Run

```bash
npm run benchmark -- \
  --task '部署 benchmark 中指定的 Minecraft 服务端，并确保 MCDR 正确接管且服务端可运行' \
  --mode full \
  --model 'deepseek-v4.1-flash'
```

The command logs in to MCTAgent, creates a new server instance by default,
submits one benchmark request, waits for the existing workflow turns, and
prints the execution records as JSON. `--json` keeps stdout machine-readable;
live timing updates are always written to stderr (redirect it to retain a log).

Each workflow node reports elapsed time at status changes and every 15 seconds
while active. Final `timings` includes workflow nodes, execution turns, model/tool
steps, and individual tool calls. Workflow node timestamps are polling observations
(start uses the owning turn's creation time); execution/step/tool timestamps come
from existing persisted records. Parallel durations overlap and must not be summed.
A step spans model inference **and** its tool execution, not pure model latency.
Timeout results retain collected timings and request cancellation of the active agent.

Useful options:

- `--task-file`: read a UTF-8 task file instead of `--task`. Prefer this for
  orchestration: server/workspace paths in inline task arguments can otherwise
  be mistaken for active server processes by conservative process inspection.
- `--base-url`: MCTAgent HTTP entrypoint. Defaults to `http://127.0.0.1:1143`.
- `--password`: panel password, or `MCTAGENT_PASSWORD`.
- `--server-id`: reuse an existing instance. This is intentionally explicit
  because it can modify a live server.
- `--name`: name of the new isolated server instance.
- `--mode full|basic`: records the benchmark condition. `full` uses the same
  effective prompt, Skill, workflow, tools, and execution path as Web. The
  `basic` uses a minimal system prompt, factual runtime context, and the same
  tools/AgentService, without global/domain prompts, Skills, deployment workflow
  tools/scheduling, or appended domain recovery instructions. Tool descriptions,
  errors and backend safety/permission checks remain; this is not a tool-schema
  ablation. It never enables `ask_user`.
- `--model`: per-instance model override.
- `--timeout-ms`: end-to-end timeout.

## Non-interactive rule

Benchmark executions never register the `ask_user` tool. The task must contain
all information needed to identify and deploy the target package. The task
input is treated as the user's confirmed choice for the identification gate.
Other confirmation controls and workflow gates remain active. If the model
requires information that is not in the task, the run fails and records the
failure; the CLI never invents an answer.

## Scope

The CLI is an orchestration client only. The following continue to come from
the same code used by Web:

- prompt and Skill assembly;
- deployment workflow DAG and turn gates;
- tool schemas and tool execution;
- model calls and retries;
- execution, step, tool-call, and usage persistence;
- server process management.

Checkpoint scoring and external service health evaluation should consume the
result JSON from a separate evaluator rather than trusting the model's final
text.
