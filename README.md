# dsh-agent-bus

**English** | [中文](README.zh.md)

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node.js"></a>
</p>

**Stop being the messenger between your agents.**

dsh-agent-bus is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin. It lets live sessions in the same workspace assign work to each other, review the result, and run a multi-step plan in order — on the harness inbox you already have.

You keep the specialists. You stop copy-pasting.

## Why this exists

Harness already runs several agents in one workspace. It does not let them *collaborate*.

Without this plugin:

- A planner cannot give a coder a job. You paste the brief.
- A coder cannot wait for a reviewer. You paste the patch.
- A greeting sent as a “task” sits in `working` until a two-hour timeout, because nothing ever reports or settles.
- When step 3 fails, you reconstruct steps 1–2 from chat logs.

That is not a team. That is you as a human bus.

## What you actually get

**Talk stays talk.** A question, a ping, a “look at this” is `send_note`. No ledger, no review, no timeout theatre. If the peer is offline, the note waits and delivers when they come back.

**Work stays work.** `create_task` is a job with a body, an optional acceptance bar, and a reviewer. The worker reports; the reviewer accepts or sends the *same* task back with feedback. The id never changes across rework.

**A plan can run without you in the loop.** `create_flow` is a named DAG. You (or the planner agent) write the plan, then create tasks with `flow_id` and `dependencies`. Task B is not even delivered until A is accepted. If A is canceled or fails for good, B and C fail with it — no orphaned workers.

**The next agent reads the chain, not the archaeology.** After settle, the executor can attach a handoff (numbers, decisions, caveats). Dispatch concatenates that into the downstream task. Step 3 does not have to `get_task` its way through step 1.

**You can see it.** On the web profile a capsule on the right opens a workbench: a task list, and a per-flow DAG canvas. Click a node for the full requirement. Archived ancestors stay on the graph, faded.

## Quick start

```sh
dsh plugin --profile web add dsh-agent-bus
dsh web
```

From a local checkout:

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

The web-app bundle already mounts storage and the workspace registry. A custom or headless profile must declare `storage`, `storage-json`, `storage-domain`, and `workspace` in its own `cordis.patch.yml` — load fails loudly otherwise. A gateway that cannot record must not boot as a silent prompt.

Requires Node.js `^22.19.0` or `>=24`.

## How it works

Delivery is the harness inbox: one `followup()` per turn, idle sessions take the next item. This plugin does **not** add a second queue.

The plugin’s job is the **ledger** — who asked, who does it, what “done” means, what depends on what — plus a panel that reads that ledger.

There is no receive-side tool. The worker sees an ordinary turn. They do the work and call `report_task`.

```
note     send_note              →  peer replies in prose (or not)
task     create_task            →  queued → submitted → working → completed → settle
flow     create_flow + tasks    →  DAG auto-dispatches each node after its predecessors settle
```

Pick the lightest channel that still matches the ask. Chat-as-task is how work gets stuck in `working`. Task-as-chat is how you lose review.

## Tools

| You want to… | Use |
|---|---|
| Ask a peer something that is not a job | `send_note` |
| Give one peer one deliverable to review | `create_task` |
| Run a multi-step plan in order | `create_flow`, then `create_task` with `flow_id` / `dependencies` |
| Finish / accept / rework / stop / ask back / move the job | `report_task` · `settle_task` · `cancel_task` · `request_input` · `reassign_task` |
| Pass context down the chain | `submit_handoff` |
| Fix an undispatched node, or look things up | `edit_task` · `list_flows` · `list_tasks` · `get_task` |
| See who is live, declare what you can do | `list_peers` · `update_card` |

## Docs

| | |
|---|---|
| [`docs/usage.md`](docs/usage.md) | Handbook (Chinese): tools, state machine, templates |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | Offline notes, reassign, offline grace |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | Event-driven dispatch, flows, handoffs |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A task-state alignment |

## License

MIT
