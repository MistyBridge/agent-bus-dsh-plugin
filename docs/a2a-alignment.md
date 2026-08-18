# A2A 对齐设计(已确认版)

> 2026-08-18 与用户逐条讨论确认。本文档是实现的唯一依据;后续变更须回到讨论流程。

## 一、任务状态机(100% A2A 词表)

枚举 = A2A TaskState 原文八个,零自造状态;扩展语义全部压进字段(`reason` / `outcome` / `question` / `supersedes`),不进状态名。

| 状态 | 语义 | 产生/转移 |
|---|---|---|
| `submitted` | 已投递给 worker,待开工 | send_message 落库;input_required 答案送达 |
| `working` | 执行中 | claimed 事件(submitted→working;input_required→working) |
| `input-required` | worker 提问,等派发方补输入 | request_input |
| `auth-required` | 枚举保留,本插件不产生 | — |
| `completed` | **终态**。worker 已 report,report 即 artifact | report_task |
| `failed` | **终态**。reason 区分:timeout / no-response / discarded / rejected-by-dispatcher | 超时扫查、inbox 丢弃、判定失败(新任务重做) |
| `canceled` | **终态**。派发方取消 | cancel_task |
| `rejected` | 枚举保留,预留 | — |

完整流转:

```
submitted ─claimed→ working
submitted ─cancel→ canceled
submitted ─discarded→ failed(reason: discarded)

working ─report→ completed
working ─request_input→ input-required
working ─超时→ failed(reason: timeout)
working ─cancel→ canceled
working ─discarded→ failed(reason: discarded)

input-required ─答案送达→ working(claimed 时转移,不重新排队)
input-required ─超时→ failed(reason: no-response)

completed ─settle→ 仅写 outcome/feedback 字段,状态不动
```

- **判定不改状态**:`settle_task` 完全被动,只在 completed 行上记录 outcome/feedback。
- **重做 = 新任务**:判定 failure 后由派发方发新 `send_message`(可选 `supersedes` 引用原 taskId,构成重做链)。`retries` 字段仅作重做链计数,不参与流转。无自动重投。
- **超时**:`taskTimeoutMs` 默认 2 小时(Config);working 超时→failed(timeout),input-required 超时→failed(no-response)。不自动重投。

## 二、工具面(9 个)

| 工具 | 参数 | 行为 | 鉴权 |
|---|---|---|---|
| `list_peers` | — | 同工作区 live 会话 + 卡片 + 状态 + 排队数,排除归档 | 同工作区 |
| `send_message` | target, content, mode?, task_id?, supersedes? | 派发新任务 / 回复 input_required / 重做 | 同工作区 + 限流 |
| `list_tasks` | scope(inbox/outbox), status? | 列任务,渲染带摘要;status 过滤 | 本人 |
| `get_task` | task_id | 全文读取 | 同工作区 |
| `report_task` | task_id, result | working→completed;对 canceled 任务只追加摘要(不改状态) | 仅被派方 |
| `settle_task` | task_id, outcome, feedback? | 仅写 outcome/feedback,不改状态 | 仅派发方 |
| `cancel_task` | task_id, reason? | 取消+打断+要求 worker 出摘要;摘要通知派发方(v1.1 推送,现经 get_task 可见) | 仅派发方 |
| `request_input` | task_id, question | working→input-required | 仅被派方 |
| `update_card` | description?, capabilities? | 覆盖式更新自己的卡片 | 仅本人 |

## 三、Agent Card(规范化 capabilities)

- `description`:模型可读自由文本(≤200 字)
- `capabilities`:机器可读,`[{ id, label }]`;`id` = kebab-case `^[a-z][a-z0-9-]{0,31}$`(机器键,将来鉴权/路由用),`label` ≤50 字
- 约束:最多 8 项;id 去重;格式非法拒绝写入;整体覆盖;无单独清空操作(空数组即清空)
- 存储:domain `peers` 表,键 = session id
- 将来:`send_message.required_capabilities`(目标必须声明全部 id),本期不做,格式本期锁死

## 四、取消流程(cancel_task)

1. 状态 → canceled
2. 打断 worker(interrupt,keepInbox)
3. 向 worker 发消息:「任务已取消,请用 report_task 提交已完成部分的摘要」
4. worker 摘要追加到行(仅字段,状态不动)
5. 派发方:get_task 可读;v1.1 推送

## 五、落盘规划

| 数据 | 位置 |
|---|---|
| 台账 + 卡片 | `~/.dsh/storages/agent_bus.json`(storage domain) |
| 对话日志 | dsh 会话 jsonl,只追加事件不自建 |
| 长内容外置(v1.1) | 由我们管理:先评估 spill seam,不合则 `~/.dsh/agent-bus/cache/` 按 taskId 寻址 |

## 六、domain 版本

状态枚举改名 + peers 表 = 破坏性变更,domain 版本升 v2,旧数据直接拒绝(无迁移,符合预发布立场)。
