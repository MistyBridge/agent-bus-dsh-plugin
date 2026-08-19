# dsh-agent-bus

> DeepSeek Harness 工作区 Agent 协作网关:轻量消息 · 任务生命周期 · 流程 DAG 自动排期

同工作区的活跃会话可以互相协作:一句沟通走消息,一个交付物走任务,一个多步骤工程走流程。投递复用 dsh 原生 Inbox(一条一 turn、空闲才取下一项),插件不建第二个队列;任务台账由持久化存储域记录,会话日志即消息记录。

## ✨ 特性

| 能力 | 说明 |
|---|---|
| 🗨️ **双通道** | `send_note` 轻量消息(无记录无验收)与 `create_task` 正式任务(完整生命周期)分流 |
| 🧭 **路由分级** | SMALL → send_note · MEDIUM → create_task · LARGE → create_flow,模型面显式决策准则 |
| 📐 **流程 DAG** | `create_flow` 容器:先 plan 文档 → 拆分任务(`flow_id` + `dependencies`)→ 自动排期;一个流程恒为一个 DAG,跨容器依赖天然禁止 |
| ⚡ **事件驱动调度** | 任务状态变更即事件(`TaskChanged`),SSE 推送面板,客户端调度器就绪即投递(`POST /dispatch` 幂等);服务端 60s sweep 兜底 |
| 🔁 **失败自动传播** | 依赖终态失败 → 下游递归自动 failed,无需人工处理;重试由任务节点内建(同 id 重做) |
| 📦 **交接文档** | 结算任务的执行方为每个后向任务提交结构化交接文档,投递时自动拼入下游内容——链条传递的是上下文,不是考古 |
| 🗂️ **会话与侧边栏同源** | 会话目录逐字节复用 workspace registry:侧边栏显示的即活跃,手动归档的即归档;无任何插件自己的过滤逻辑 |
| 📊 **实时面板** | 任务卡片、流程 DAG 视图(按流程选择,归档祖先淡显)、token 消耗、归档分区 |

## 🏗️ 架构

```
┌───────────────────────────── 浏览器面板 ─────────────────────────────┐
│  流程列表 → 点选 → DAG 渲染(节点=流程内任务,实时绑定)                    │
│  事件驱动调度器:TaskChanged → 依赖满足? → POST /dispatch              │
└───────────────▲──────────────────────────┬──────────────────────────┘
                │ SSE                        │ HTTP
┌───────────────┴──────────────────────────▼──────────────────────────┐
│                        dsh-agent-bus(host 插件)                      │
│  ledger(存储域 agent_bus v9)                                          │
│    tasks: queued → submitted → working → completed → settle          │
│    flows: 流程容器(派生 active/archived)                              │
│    handoffs: 前置交接文档                                              │
│  事件:每次持久写后 emit TaskChanged                                   │
└───────────────▲──────────────────────────┬──────────────────────────┘
                │ followup()                │ claim / discard
┌───────────────┴──────────────────────────▼──────────────────────────┐
│                    dsh Agent Inbox(执行权威)                         │
│          一条一 turn,空闲才取下一项;认领/弃置事件回流台账             │
└──────────────────────────────────────────────────────────────────────┘
```

## 🛠️ 工具(14 个,按路由分级)

| 规模 | 工具 | 作用 |
|---|---|---|
| SMALL | `send_note` | 轻量消息:提问/确认/协调 ping,无记录、无验收、无恢复 |
| MEDIUM | `create_task` | 单任务节点:content + `dependencies?` + `acceptance_criteria?` + `flow_id?` + reviewer;依赖未清 → 待投递(queued)自动排期 |
| LARGE | `create_flow` | 流程容器:先 plan 文档,再拆任务建 DAG |
| — | `submit_handoff` | 结算任务的执行方为每个后向任务提交交接文档 |
| — | `edit_task` | 改未派发任务的依赖拓扑 / 内容 / 验收标准 / 流程归属 |
| — | `list_flows` / `list_tasks` / `get_task` | 查询:流程目录(含归档派生)/ 活跃任务(归档自动不可见)/ 全量记录(含交接文档) |
| — | `report_task` / `settle_task` / `cancel_task` / `request_input` | 生命周期:交差(→待验收)/ 验收(成功释放下游,失败同 id 重做)/ 取消(自动传播)/ 暂停等输入 |
| — | `list_peers` / `update_card` | 发现与自我声明(description + capabilities) |

没有接收侧工具:dsh 的 `followup()` 把任务变成对方的一个普通 turn,worker 读到的就是用户输入,无需认领步骤。

## 🚀 安装

```sh
dsh plugin --profile web add dsh-agent-bus
# 或本地路径(开发):
dsh plugin --profile web add .
dsh --profile web --dump-config   # 验证组合
dsh web                            # 重启生效
```

依赖:profile 必须挂载 `storage` / `storage-json` / `storage-domain` / `workspace` 四行(web 的 `dsh-web-app` bundle 自带)。headless 或自定义 profile 需在自己的 `cordis.patch.yml` 里补这四行,否则插件加载即失败——这是刻意的:收不到记录的网关不应以静默降级形态启动。

## 🧭 使用准则

```
小型需求(一句话沟通)   → send_note
中型任务(单个交付物)   → create_task  (report → settle → rework/cancel,超时兜底)
大型工程(多步骤)       → create_flow  (plan 文档 → 拆任务建 DAG → 自动排期 + 失败传播)
```

## 📚 文档

| 文档 | 内容 |
|---|---|
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | 当前契约:事件驱动调度、流程、交接文档、路由分级(§7/§8) |
| [`docs/v1.3-two-channel-spec.md`](docs/v1.3-two-channel-spec.md) | 双通道设计与通知词汇表 |
| [`docs/v1.2-dag-spec.md`](docs/v1.2-dag-spec.md) | DAG 数据模型与排期语义(第 6 章已标注由 v1.4 取代) |
| [`docs/v1.1-task-panel-spec.md`](docs/v1.1-task-panel-spec.md) | 任务面板快照契约 |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A 词汇表对齐 |

## 📄 License

MIT
