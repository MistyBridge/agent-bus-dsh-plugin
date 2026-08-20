# 验证指南

dsh-agent-bus 的四层验证体系:离线检查 → 组合验证 → 真实 e2e → GUI 验证。CI 覆盖第一层;后三层需要运行中的 dsh。

## 1. 离线检查(CI 自动)

```sh
pnpm install
pnpm test       # vitest 单元测试(162+ 用例:状态机/校验/事件/流程/交接文档)
pnpm build      # tsc 双配置 + tsdown 客户端 bundle
```

| 检查 | 覆盖 |
|---|---|
| `ledger` 测试 | 状态机转换、queued 迁移、依赖校验(环/跨流程/上限)、传播、edit/reassign 语义、交接文档 |
| `panel` 测试 | 快照组装、会话目录 registry 同源、flows 派生归档、DAG 列 |
| `panel-model` 测试 | 客户端分区、节点集/祖先链、调度判定 |
| `message-channel` 测试 | 双通道 header、限流隔离、配置默认值 |
| `tools-render` 测试 | 待验收/待投递徽标、可见集规则、交接文档读取 |

## 2. 组合验证(profile 生效)

```sh
dsh plugin --profile web add .     # 或 npm 包
dsh --profile web --dump-config   # 验证组合:tools/agents/systemPrompt/sessionTitle/storageDomain/workspaceRegistry 全部注入
dsh web                            # 启动
```

- 启动日志无 `agent-bus` 错误;`http://127.0.0.1:3080/plugins/dsh-agent-bus/state` 返回 200。
- 快照含:`sessions`(与 dsh 侧边栏逐字节一致)、`flows`、`tasks`(queued/待验收徽标字段)、`stats`(含 queued)。
- SSE:`curl -N http://127.0.0.1:3080/plugins/dsh-agent-bus/events` 输出 `: connected`。
- dispatch 幂等:`POST /plugins/dsh-agent-bus/dispatch {"taskId": "<非queued任务>"}` 返回 `{"dispatched": false}`。

## 3. 真实 e2e(需要浏览器会话)

`tests/e2e/`(本地资产,不推送)驱动真实会话:

```sh
node --import tsx tests/e2e/abc-test.ts     # 三方生命周期:派发→执行→验收→负向(发起方禁 settle)
node --import tsx tests/e2e/dag-test.ts     # DAG 链式自动派发 + 失败自动传播
```

| 场景 | 断言 |
|---|---|
| 链式自动排期 | T2/T3 创建即 queued;T1 settle → 自动投递 T2(auto=true)→ 链式直至末端,无人工派发 |
| 失败传播 | 根任务 settle failure → dependent 自动 failed(reason=dependency-failed),从未被派发 |
| 待验收语义 | completed 无 outcome → list_tasks 显示「待验收」;reviewer settle 后消失 |

## 4. GUI 验证(浏览器面板)

- **会话目录**:与 dsh 左侧侧边栏完全一致——侧边栏显示的会话在活跃区(live 点仅状态标记),手动归档的会话在「归档 N」折叠区。
- **流程视图**:「活跃流程」显示已创建流程(名称 + 未结算/总数);点选 → DAG 渲染(节点=流程内任务);归档祖先淡显且不可交互;无流程任务不出现。
- **任务卡**:待投递(queued)徽章;待验收虚线徽章;验收标准与交接文档在详情区。
- **事件驱动**:任一任务状态变更,DAG 节点徽章与任务列表实时更新(SSE);断网时降级轮询不白屏。

## 已知限制(验收时注意)

- 投递仅达 live 会话;queued 任务在 worker 离线时由 sweep 持续重试,不丢。
- send_note 离线入队(v1.5):补投带「延迟送达」标记;3 次失败丢弃并通知发送方。
- 执行方离线超 15 分钟 → initiator 收到决策通知(不自动 fail,2h 超时兜底)。
- 模型可能完成工作但不更新任务状态 → reminder/offlineGrace/超时三层收敛。
