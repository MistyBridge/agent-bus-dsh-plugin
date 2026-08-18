# dsh-agent-bus

DeepSeek Harness 插件:工作区内的 agent 消息网关 + 任务台账。

同一工作区的活跃会话可以互相派发任务,任务状态由持久化台账记录。投递复用 dsh 原生 Inbox(一条一 turn,空闲才取下一项),插件不建第二个队列。

## 安装

```sh
dsh plugin --profile web add dsh-agent-bus
# 或本地路径(开发):
dsh plugin --profile web add .
dsh --profile web --dump-config   # 验证组合
dsh web                            # 重启生效
```

依赖:profile 必须挂载 `storage` / `storage-json` / `storage-domain` / `workspace` 四行(web 的 `dsh-web-app` bundle 自带)。headless 或自定义 profile 需在自己的 `cordis.patch.yml` 里补这四行,否则插件加载即失败——这是刻意的:收不到记录的网关不应以静默降级形态启动。

## 工具(9 个,命名对齐 A2A 操作集)

| 工具 | 作用 |
|---|---|
| `list_peers` | 同工作区活跃会话 + 自维护卡片(description/capabilities)+ 状态 + 排队数;排除归档会话 |
| `send_message` | 派发新任务 / 回复 `request_input`(传 task_id)/ 重做(传 supersedes)。`mode=followup`(默认)排队,`mode=steer` 打断对方当前 step |
| `list_tasks` | `scope=inbox/outbox` + 可选 `status` 过滤;渲染带提交摘要 |
| `get_task` | 同工作区可读全文(内容、问题、报告、判定、原因、重做链) |
| `report_task` | worker 提交结果(working→completed),随后**自动通知派发方验收**;对 canceled 任务只追加摘要不改状态 |
| `settle_task` | 派发方判定,仅写 outcome/feedback,状态不动(完全被动);收到完成通知后及时验收 |
| `cancel_task` | 仅派发方:取消+打断 worker+要求提交摘要,摘要落台账 |
| `request_input` | worker 暂停任务提问(working→input-required);派发方用 send_message 回答后恢复 |
| `update_card` | 自维护能力卡片:description(模型读)+ capabilities(机器读,规范化 id) |

没有接收侧工具:dsh 的 `followup()` 把任务变成对方的一个普通 turn,worker 读到的就是用户输入,无需认领步骤。

## 三方对象与任务状态机

每个任务创建时自动指明三个对象(条件允许时两两不同,允许发起方 = 验收方):

```
发起方 ──dispatch_task──> 执行方
                              │ report_task
                              ▼
执行方 <──通知── 验收方(report 后通知验收方)
   ▲                │ settle_task
   └──回退重做────── 验收 failure:同一任务回退 submitted + 修改意见 + retries++
验收方 ──settle success 后通知──> 发起方(结果回传)
```

```
submitted ─claimed→ working ─report→ completed ─settle success→ 终态(outcome=success)
    │            │  │                              └settle failure→ 回退 submitted(retries++,反馈即修改意见)→ 循环
    │            │  └request_input→ input-required ─答案claimed→ working
    │            │
    │            ├超时→ failed(timeout)   ├超时→ failed(no-response)
    │            └cancel→ canceled        └cancel→ canceled
    │
    ├cancel→ canceled
    └discarded→ failed(discarded)
```

- **重做 = 同一任务回退**:验收 failure 使任务回到 `submitted`、`retries`+1、feedback 即修改意见,执行方被自动唤醒重新执行——**任务 id 全程不变**,全生命周期在同一条记录上连续演进(为后续全生命周期可视化/统计铺路)。
- 验收方:`dispatch_task` 的 `reviewer` 参数指定,缺省 = 发起方;`settle_task` 仅验收方可调,`cancel_task` 仅发起方可调。
- 三条回环:report→通知验收方;settle success→通知发起方;settle failure→通知执行方重做。
- 超时:`taskTimeoutMs` 默认 2 小时,working 超时→failed(timeout),input-required 超时→failed(no-response)。
- 台账记录意图与结果,**不是** Inbox 的镜像。两者按设计漂移:interrupt 保留未认领队列但不退回已认领项;disposal 丢弃全部未认领项。
- 完整设计见 `docs/a2a-alignment.md` 与 `docs/design-notes.md`。

## 配置(cordis.patch.yml 内)

| 键 | 默认 | 作用 |
|---|---|---|
| `maxContentLength` | 16000 | 转述内容字符上限,超限**拒绝**而非截断 |
| `maxPendingPerAgent` | 20 | 单个接收者未完成任务的深度上限(dsh Inbox 自身无上限) |
| `maxSendsPerMinute` | 10 | 每个发送者每分钟派发上限(进程内滑动窗口) |
| `taskTimeoutMs` | 7200000 | working / input-required 超时转 failed 的时限(2 小时) |

## 设计决策(简)

- **投递复用原生,不建队列**:dsh Inbox 的 `next-turn` FIFO 一条一 turn、带持久化检查点,正是「逐个完成、空闲才取下一项」。自建会分叉排序权威。
- **权限从持久化关系推导,无 role 字段**:可达性 = 共享工作区成员;判定权 = 台账记录的派发者。PM 是涌现角色。
- **仓库外插件不能扩 SessionEventMap**(生成器 glob 固定在 dsh 仓库内),所有需重放后存活的状态落 storage domain。
- **移植自 CC_BOOS 的部件**:内容消毒(ANSI/C0/C1 剥离 + 长度上限)、深度上限、限流。**刻意不移植的**:PTY 注入层、Router Mode、DAG、文件锁、知识库、PMO 角色、离线 mailbox——详见 `docs/design-notes.md`。

## 开发

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # vitest 单元测试
```

TypeScript,`module: NodeNext`。devDependencies 用 `link:` 指向本地 dsh 源码。

## 已知限制

- 仅投递 live 会话;离线投递(dsh 已明确否决的离线 mailbox)不在本版。
- 执行中超时扫查未实现——被认领后 step 被拒的任务会停在执行中。
- `domain/changed` 仅进程内,跨进程可视化未做。
- 事件驱动迁移(inserted/claimed/discarded → 台账)未接线,当前状态由工具调用推进。
