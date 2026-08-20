# dsh-agent-bus

[English](README.md) | **中文**

<p>
  <a href="https://github.com/MistyBridge/dsh-agent-bus/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT"></a>
  <a href="https://github.com/MistyBridge/dsh-agent-bus"><img src="https://img.shields.io/badge/platform-DeepSeek%20Harness-1a73e8" alt="DeepSeek Harness"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24-339933" alt="Node.js"></a>
</p>

**别再当 Agent 之间的传话筒。**

dsh-agent-bus 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件。它让同一工作区里的活跃会话可以互相派活、验收结果、按顺序跑完一个多步骤计划——投递走的还是你已经在用的 Inbox。

专家还是那些专家。复制粘贴的人不再是你。

## 为什么要做这个

Harness 已经能在一个工作区里开多个 Agent。它并不能让它们**协作**。

没有这个插件时：

- 规划会话没法给编码会话派活。你得把 brief 贴过去。
- 编码会话没法等验收会话。你得把 patch 贴过去。
- 一句问候如果被写成「任务」，会卡在 `working` 直到两小时超时——因为没有人会 report，也没有人会 settle。
- 第 3 步失败了，你得从聊天记录里把第 1、2 步重新拼回来。

那不是团队。那是你自己在当总线。

## 你实际能得到什么

**说话就是说话。** 提问、确认、「看一下这个」用 `send_note`。不落台账、不验收、不做超时戏。对方离线，消息入队，上线再送。

**干活就是干活。** `create_task` 是一件有正文、可选验收标准、有验收人的工作。执行方 report；验收方通过，或把**同一条任务**连同修改意见打回去。重做全程同一个 id。

**计划可以在你不插手时往下跑。** `create_flow` 是一张命名 DAG。你（或规划 Agent）先写 plan，再按 `flow_id` 和 `dependencies` 拆任务。B 在 A 被验收之前根本不会投递。A 被取消或终态失败，B、C 跟着失败——不会留下还在空转的执行者。

**下一棒读到的是链条，不是考古。** 结算后，执行方可以给每个后向任务附交接（数值、决策、注意事项）。投递时拼进下游正文。第 3 棒不必靠 `get_task` 把第 1 棒翻出来。

**你看得到。** Web 界面右侧胶囊打开工作台：任务列表，以及按流程的 DAG 画布。点节点看全文要求。已归档的祖先留在图上，淡显。

## 快速开始

```sh
dsh plugin --profile web add dsh-agent-bus
dsh web
```

本地开发：

```sh
dsh plugin --profile web add .
dsh --profile web --dump-config
dsh web
```

web-app bundle 已挂载存储和工作区注册表。自定义或 headless profile 须在自己的 `cordis.patch.yml` 里声明 `storage`、`storage-json`、`storage-domain`、`workspace`——否则加载即失败。记不住账的网关，不应以静默降级形态启动。

需要 Node.js `^22.19.0` 或 `>=24`。

## 它怎么工作

投递是 harness 的 Inbox：一次 `followup()` 一轮 turn，空闲会话才取下一项。本插件**不**再造一条队列。

插件负责的是**台账**——谁派的、谁做、什么叫完成、谁依赖谁——以及读这份台账的面板。

没有接收侧工具。执行方看到的是普通一轮对话。做完调用 `report_task`。

```
消息     send_note              →  对方用散文回复（也可以不回）
任务     create_task            →  queued → submitted → working → completed → settle
流程     create_flow + 任务     →  DAG 在前置结算后自动投递下一节点
```

选能覆盖需求的最轻通道。把聊天写成任务，工作会卡死在 `working`；把任务写成聊天，就丢掉验收。

## 工具

| 你想… | 用 |
|---|---|
| 问一句、不是派活 | `send_note` |
| 给一个同伴一件要验收的活 | `create_task` |
| 按顺序跑一个多步骤计划 | `create_flow`，再带 `flow_id` / `dependencies` 的 `create_task` |
| 交差 / 验收 / 重做 / 停掉 / 反问 / 换人 | `report_task` · `settle_task` · `cancel_task` · `request_input` · `reassign_task` |
| 把上下文交给下一棒 | `submit_handoff` |
| 改还没投递的节点，或查记录 | `edit_task` · `list_flows` · `list_tasks` · `get_task` |
| 看谁在线，声明自己能做什么 | `list_peers` · `update_card` |

## 文档

| | |
|---|---|
| [`docs/usage.md`](docs/usage.md) | 操作手册：工具、状态机、模板 |
| [`docs/v1.5-resilience-spec.md`](docs/v1.5-resilience-spec.md) | 离线消息、转派、离线宽限 |
| [`docs/v1.4-event-driven-scheduling-spec.md`](docs/v1.4-event-driven-scheduling-spec.md) | 事件驱动排期、流程、交接 |
| [`docs/a2a-alignment.md`](docs/a2a-alignment.md) | A2A 任务状态对齐 |

## License

MIT
