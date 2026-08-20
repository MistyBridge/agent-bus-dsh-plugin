# dsh-agent-bus

**English** | [中文](README.zh.md)

Workspace collaboration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents: lightweight notes, a durable task lifecycle, and flow DAGs that schedule themselves.

Live sessions in the same workspace can talk, assign work, and orchestrate multi-step jobs. Delivery uses the harness inbox (`followup()`, one item per turn). This plugin does not add a second queue. The ledger records tasks and flows; session logs are the record for notes.

## Features

| | |
|---|---|
| **Two channels** | `send_note` for chat (no ledger, no acceptance). `create_task` for work that must be delivered and reviewed. |
| **Route by scope** | SMALL → note · MEDIUM → task · LARGE → flow. The model is told to pick the matching channel. |
| **Flow DAGs** | `create_flow` is a named container. Plan first, then split into tasks (`flow_id` + `dependencies`). One flow is one DAG; cross-flow dependencies are rejected. |
| **Event-driven dispatch** | Ledger writes emit `TaskChanged`. The panel listens on SSE and POSTs `/dispatch` when a queued task is ready. A 60s host sweep covers offline clients. |
| **Failure propagation** | A terminal failure (`failed` / `canceled`) fails dependents recursively. Rework is the same task id (`settle` failure → `submitted`, `retries++`). |
| **Handoffs** | After settle, the executor can attach structured context for each downstream task. Dispatch concatenates those documents into the next worker's content. |
| **Resilience** | Offline notes queue and deliver when the peer is live. `reassign_task` moves executor or reviewer. Offline-executor grace notifies the initiator instead of failing immediately. |
| **Panel** | A workbench capsule on the web profile: task list, per-flow DAG canvas, tokens, archive. |

## Architecture

```
┌─────────────────────────── Browser panel ────────────────────────────┐
│  Capsule → task list · flow list → DAG (nodes = tasks in that flow)  │
│  Scheduler: TaskChanged → dependencies settled? → POST /dispatch     │
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ SSE                          │ HTTP
┌───────────────┴──────────────────────────────▼───────────────────────┐
│                     dsh-agent-bus (host plugin)                      │
│  ledger (storage domain agent_bus)                                   │
│    tasks:  queued → submitted → working → completed → settle         │
│    flows:  container (active / archived is derived)                  │
│    handoffs · pending notes                                          │
└───────────────▲──────────────────────────────┬───────────────────────┘
                │ followup()                   │ claimed / discarded
┌───────────────┴──────────────────────────────▼───────────────────────┐
│                 dsh agent inbox (execution authority)                │
│           One follow-up per turn; idle sessions take the next item   │
└──────────────────────────────────────────────────────────────────────┘
```

There is no receive-side tool. `followup()` turns a delivery into an ordinary turn on the peer; the worker reads it as user input.

## Tools

| Scope | Tool | Role |
|---|---|---|
| SMALL | `send_note` | Note / question / ping. No task row. Offline peers are queued and flushed when they come back. |
| MEDIUM | `create_task` | One task node: content, optional `dependencies`, `acceptance_criteria`, `flow_id`, `reviewer`. Unsettled deps stay `queued` until the scheduler delivers. |
| LARGE | `create_flow` | Flow container. Write the plan, then create tasks into the DAG. |
| Lifecycle | `report_task` / `settle_task` / `cancel_task` / `request_input` / `reassign_task` | Finish, accept or rework, cancel (propagates), pause for input, retarget executor or reviewer. |
| Chain | `submit_handoff` | Attach a handoff document to each downstream task after you settle. |
| Edit / query | `edit_task` / `list_flows` / `list_tasks` / `get_task` | Edit an undispatched task; list flows and active tasks; read a full record. |
| Discovery | `list_peers` / `update_card` | Live peers and self-declared capability cards. |

## Install

```sh
dsh plugin --profile web add dsh-agent-bus
# local checkout while developing:
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

The profile must mount `storage`, `storage-json`, `storage-domain`, and `workspace`. The web-app bundle already does. A headless or custom profile must add those rows in its own `cordis.patch.yml`; load fails loudly otherwise — a gateway that cannot record must not boot as a silent prompt stub.

Requires Node.js `^22.19.0` or `>=24`.

## Routing

```
A one-line ping or question     → send_note
One deliverable to review       → create_task   (report → settle → rework / cancel)
A multi-step effort             → create_flow   (plan → DAG → auto-dispatch + failure propagation)
```

Chat disguised as a task is how work gets stuck in `working`. A task disguised as chat drops the lifecycle that keeps work accountable.

## Docs

| Doc | Contents |
|---|---|
| [`docs/usage.md`](docs/usage.md) | Operator handbook (Chinese): tools, state machine, templates |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | Durable notes, reassign, offline grace |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | Event-driven dispatch, flows, handoffs |
| [`docs/v1.3-two-channel-spec.md`](docs/v1.3-two-channel-spec.md) | Notes vs tasks, notification vocabulary |
| [`docs/v1.2-dag-spec.md`](docs/v1.2-dag-spec.md) | DAG data model (panel chapter superseded by v1.4) |
| [`docs/v1.1-task-panel-spec.md`](docs/v1.1-task-panel-spec.md) | Panel snapshot contract |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A task-state alignment |

## License

MIT
