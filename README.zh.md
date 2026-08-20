# dsh-agent-bus

[English](README.md) | **中文**

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工作区 Agent 协作网关:轻量消息、任务生命周期、可自动排期的流程 DAG。

同工作区的活跃会话可以互相沟通、派发工作、编排多步骤工程。投递复用 dsh 原生 Inbox(`followup()`,一条一 turn),插件不建第二个队列。台账记录任务与流程;会话日志即消息记录。

## 特性

| | |
|---|---|
| **双通道** | `send_note` 走沟通(无台账、无验收)。`create_task` 走必须交付并验收的工作。 |
| **按规模路由** | SMALL → 消息 · MEDIUM → 任务 · LARGE → 流程。模型面写明选用准则。 |
| **流程 DAG** | `create_flow` 是命名容器。先写 plan,再拆成任务(`flow_id` + `dependencies`)。一个流程就是一张 DAG;跨流程依赖会被拒绝。 |
| **事件驱动排期** | 台账写入即 `TaskChanged`。面板经 SSE 订阅,就绪则 `POST /dispatch`。宿主 60s sweep 覆盖客户端离线。 |
| **失败传播** | 终态失败(`failed` / `canceled`)沿下游递归 failed。重做是同一 task id(`settle` failure → `submitted`,`retries++`)。 |
| **交接文档** | 结算后执行方可给每个后向任务附结构化上下文。投递时拼进下游内容,下一棒读到的是链条状态而不是旧报告考古。 |
| **韧性** | 离线消息入队,上线补投。`reassign_task` 转派执行者或验收者。执行方离线宽限期通知发起方决策,不立即失败。 |
| **面板** | Web profile 右侧胶囊工作台:任务列表、按流程的 DAG 画布、token、归档。 |

## 架构

```
┌──────────────────────────── 浏览器面板 ─────────────────────────────┐
│  胶囊 → 任务列表 · 流程列表 → DAG(节点 = 该流程内任务)                │
│  调度:TaskChanged → 依赖是否已结算? → POST /dispatch                 │
└───────────────▲──────────────────────────────┬──────────────────────┘
                │ SSE                          │ HTTP
┌───────────────┴──────────────────────────────▼──────────────────────┐
│                      dsh-agent-bus(宿主插件)                         │
│  ledger(存储域 agent_bus)                                            │
│    tasks:  queued → submitted → working → completed → settle        │
│    flows:  容器(活跃 / 归档由任务派生)                               │
│    handoffs · 待补投消息                                             │
└───────────────▲──────────────────────────────┬──────────────────────┘
                │ followup()                   │ claimed / discarded
┌───────────────┴──────────────────────────────▼──────────────────────┐
│                   dsh Agent Inbox(执行权威)                          │
│              一条一 turn;空闲会话才取下一项                           │
└─────────────────────────────────────────────────────────────────────┘
```

没有接收侧工具。`followup()` 把投递变成对方的一个普通 turn,worker 读到的就是用户输入。

## 工具

| 规模 | 工具 | 作用 |
|---|---|---|
| SMALL | `send_note` | 沟通 / 提问 / ping。不落任务行。目标离线则入队,上线补投。 |
| MEDIUM | `create_task` | 单任务节点:内容,可选 `dependencies`、`acceptance_criteria`、`flow_id`、`reviewer`。依赖未清时停在 `queued`,调度器就绪后投递。 |
| LARGE | `create_flow` | 流程容器。先 plan,再把任务放进 DAG。 |
| 生命周期 | `report_task` / `settle_task` / `cancel_task` / `request_input` / `reassign_task` | 交差、验收或同 id 重做、取消(向下游传播)、暂停提问、转派执行者或验收者。 |
| 链条 | `submit_handoff` | 结算后给每个后向任务提交交接文档。 |
| 编辑 / 查询 | `edit_task` / `list_flows` / `list_tasks` / `get_task` | 改未派发任务;列流程与活跃任务;读全文记录。 |
| 发现 | `list_peers` / `update_card` | 同工作区 live 会话与自维护能力卡片。 |

## 安装

```sh
dsh plugin --profile web add dsh-agent-bus
# 开发时用本地路径:
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

profile 必须挂载 `storage` / `storage-json` / `storage-domain` / `workspace`。web-app bundle 已自带。headless 或自定义 profile 须在自己的 `cordis.patch.yml` 里补这四行,否则加载即失败——收不到记录的网关不应以静默降级形态启动。

需要 Node.js `^22.19.0` 或 `>=24`。

## 选用准则

```
一句话沟通或确认     → send_note
一个要验收的交付物   → create_task   (report → settle → 重做 / 取消)
多步骤工程           → create_flow   (plan → DAG → 自动投递 + 失败传播)
```

把聊天写成任务,工作会永久卡在 `working`;把任务写成聊天,就丢掉了让工作可追责的生命周期。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/usage.md`](docs/usage.md) | 操作手册:工具、状态机、流程模板 |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | 离线消息、转派、离线宽限 |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | 事件驱动排期、流程、交接文档 |
| [`docs/v1.3-two-channel-spec.md`](docs/v1.3-two-channel-spec.md) | 双通道与通知词汇表 |
| [`docs/v1.2-dag-spec.md`](docs/v1.2-dag-spec.md) | DAG 数据模型(面板章节已被 v1.4 取代) |
| [`docs/v1.1-task-panel-spec.md`](docs/v1.1-task-panel-spec.md) | 面板快照契约 |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A 任务状态对齐 |

## License

MIT
