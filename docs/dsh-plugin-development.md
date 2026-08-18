# dsh 插件开发规范

> 依据:DeepSeek Harness 仓库 `0.1.0-rc.5` 源码 + `dsh-agent-teams@0.1.6` 实测参照
> 用途:agent-bus 插件的开发基准。所有结论均标注了源码位置,可自行复核。

本文档只记录**仓库外插件**(通过 `dsh plugin add` 安装,不修改 dsh 源码)的规则。

---

## 1. 插件的最小构成

官方最小骨架(`docs/user/develop/basic/publish.md:26-62`)只需三个文件:

```
package.json       # 声明 dsh.bundle
cordis.patch.yml   # profile 列出本 bundle 时应用的层
index.js           # patch 行引用的插件模块
```

TypeScript 项目在此之上加 `src/`、`tsconfig.json`、`tsdown.config.ts`。

**没有脚手架,且这是一个已记录的决定。** `.agents/notes/implemented/simplification/2026-08-11-remove-sdk-project-toolchain.md` 删除了整套工具链(`create-sdk` / `dsh-scripts` / `dsh-helper`),明确写下 "local-plugin scaffolding ... intentionally unavailable",重新引入需要新提案。所以从空目录手写,或复制一个已知可用的插件结构。

---

## 2. `package.json` 的 `dsh` 段

**只有三个子键会被真正读取:**

| 键 | 读取位置 | 作用 |
|---|---|---|
| `dsh.bundle.patch` | `packages/boot/app-boot/src/profile.ts:391` | 声明本包导出的 patch 层路径 |
| `dsh.profile.bundles` | `profile.ts:300` | profile 自己用,插件不写 |
| `dsh.client` | `packages/client/modules/src/index.ts:345` | 浏览器半边 |

类型定义(`profile.ts:41-70`):

```ts
export interface DshBundleManifest {
  /** The patch layer this bundle exports, relative to its package root. */
  patch: string
}
export interface DshManifestSection {
  bundle?: DshBundleManifest
  profile?: DshProfileManifest
}
```

`patch` 是必需字符串。profile 列出了某个 bundle 但它没有 `dsh.bundle`,会**直接失败**:`profile bundle "<name>" declares no dsh.bundle in its package.json`。

> **注意:`dshx.contributes` 不存在。** 全仓(含 `node_modules` 与 lockfile)零命中。贡献通过 patch 行 + cordis 注册完成,没有 manifest 里的 `contributes` 块。`dsh-agent-teams` 的 `package.json:72-79` 有一个顶层 `dshClient` 块,那是它自己针对旧 loader 约定的兼容回退,不是官方键。

### 依赖声明方式

`DshManifestSection` 的 JSDoc 写明 "other consumers own additional keys",`dsh.client` 就是走这个扩展口。

**`@deepseek-ai/cordis` 必须是 peerDependency**(`AGENTS.md:100`)。否则会拿到重复的 cordis 实例,依赖注入静默失效。profile 目录的 `nodeLinker: hoisted` + `autoInstallPeers: false` 就是为了让你的 peer 落到安装目录的**单一副本**上。

`dsh-agent-teams` 的实测做法(`package.json:88-147`)值得照抄:

- **完全没有 `dependencies` 字段**,所有 `@deepseek-ai/*` 都是 peer
- 每个 peer 同时在 `peerDependenciesMeta` 里标 `optional: true` —— 不自动安装,也不硬失败
- peer 用 caret(`^0.1.0-rc.6`),devDependencies 用**精确版本**(`0.1.0-rc.6`,无 caret)保证本地构建可复现

---

## 3. patch 层机制

**patch 不往 `cordis.yml` 里插行。** `cordis.yml` 每次启动都被强制重写为 `[]`(`apps/cli/src/profile-boot.ts:60-64`):

```
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

这个重写是无条件且承重的(`profile-boot.ts:88-96`):vendored Loader 的树写回会在插件自我卸载时把组合结果烙进该文件,导致**下次启动重复插入每一个 bundle**。组合全部在内存中完成(`composeEntries`,`profile.ts:413-420`)。

### 层序

1. `dsh.profile.bundles` 里每个 bundle 的 patch,按列表顺序
2. profile 的 `cordis.patch.yml`
3. `$DSH_HOME/cordis.patch.yml`(home 级,**优先级高于** profile 级)
4. 每个 `--patch` overlay,按 argv 顺序
5. 启动器 overlay(`agent-presets` 根、`DSH_TELEMETRY_DISABLED` 开关)

### patch 文件写法

顶层是 include `PatchOptions` 的 YAML 数组。最小形式:

```yaml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

`dsh-agent-teams` 的实际写法(`cordis.patch.yml:10-22`),注意包名要加引号:

```yaml
- insert:
    - id: agent-teams
      # Node-resolvable package name — must stay in sync with package.json
      # `name`. Quoted because `@` is a reserved indicator in YAML and cannot
      # open a plain scalar.
      name: '@nanmicoder/dsh-agent-teams'
      config:
        stateDir: .agent-teams
        memberProvider: spawn
```

三条会咬人的语义:

- **patch 替换目标行的整个 `config`,没有深合并。** 想改一个键就得重述该行需要的每个键。
- **行序不携带加载语义**(`bundle/base/cordis.patch.yml:12-13`);激活由服务可用性驱动。
- patch 指向一个组合树里不存在的 id 只是 **stderr 警告,不是错误**。空文件或只有注释的 patch 会**抛错**(解析成 nothing 而非 list);要禁用一层就写 `[]`。

**传递性:只有直接列在 `dsh.profile.bundles` 里的条目会贡献层。** 元 bundle 必须在自己的 patch 里显式重新导出别人的行(`2026-08-05-profile-plugin-bundles.md:26`)。

---

## 4. `dsh plugin add` 实际做什么

它**不是安装器,是 pnpm 转发器**(`apps/cli/src/plugin.ts:120-158`):

1. profile 不存在则初始化(`web` → `[dsh-base, dsh-web-app]`,`headless` → `[dsh-base, dsh-headless]`)
2. 相对路径 spec 按 `process.cwd()` 改写(因为 pnpm 的 cwd 是 profile 目录)
3. `spawnSync('pnpm', args, { cwd: profileDir, stdio: 'inherit', shell: win32 })`
4. 退出码 0 时回写 `dsh.profile.bundles`

**接受的 spec 形式** = pnpm 接受的一切,CLI 没有白名单:registry 名、`github:owner/repo`、git URL、tarball、本地路径、alias。

**写入位置**(`$DSH_HOME/profiles/<name>/`):

| 文件 | 内容 |
|---|---|
| `package.json` | `dependencies` + `dsh.profile.bundles` |
| `cordis.patch.yml` | 首次创建为 `[]` |
| `pnpm-workspace.yaml` | `packages: [.]` + `nodeLinker: hoisted` + `autoInstallPeers: false` |
| `cordis.yml` | 每次启动重写为 `[]`,**不要编辑** |

没有 `dsh.bundle` 的依赖只得到一句警告:`warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer`。

**验证组合结果:`dsh --profile <name> --dump-config`**(`dump-config.ts:30-52`)。不启动而输出组合后的完整树,每段带 `# ==` 注释标明来源文件,`!!js` 保持未求值,未命中的 patch 目标在 stderr 警告。

### git 安装 vs npm/tarball

git 安装拉取的是源码,TypeScript 包需要自带 `prepare` 脚本,**且用户必须在 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 里显式放行**。`publish.md:173` 对这个放行的定性很直白 —— "permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under",并建议钉住 commit SHA。

发布到 npm(`lib/` 预构建)或 `pnpm pack` 的 tarball **完全不需要这个放行**。

---

## 5. 宿主半边:插件模块

### 必需导出

```ts
export const name = 'agent-teams'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']
export interface Config { /* ... */ }
export const Config: z<Config> = z.object({ /* ... */ })
export function apply(ctx: Context, config: Config): void { /* ... */ }
```

### Config 必须是 Schemastery schema

`docs/user/develop/basic/config.md:9-45`:导出一个 `Config` 类型**和**一个同名 Schemastery schema,默认值写在字段上。**不要导出普通对象** —— 它没有实现 cordis 要求的 Standard Schema 接口。

硬规则(`config.md:78-92`):任何两个部署可能想设成不同值的东西**必须**是 config 字段。判据是「能否不改代码、只改 `cordis.yml` 就变更它」。

### 类型声明合并

只为了让 `ctx.xxx` 可见时,用 type-only import(`dsh-agent-teams/src/index.ts:22-25`):

```ts
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
```

### 注册即效果

通过 `ctx` 的注册在卸载时自动清理(`docs/user/develop/basic/index.md:66-85`)。只有需要显式拆除的资源才用 `ctx.effect(() => { ...; return () => cleanup() })`。工具注册本身已是 effect 化的,销毁 fiber 即注销工具。这也让 HMR 免费可用。

### 可选服务要惰性绑定

这是 `dsh-agent-teams` 里最值得学的一段(`src/index.ts:134-223`)。Web server 和 workspace registry 在 headless profile 下不存在,且在并发激活下可能晚于本插件绑定。它的做法是:

```ts
let webRegistered = false
const registerWebSurface = (): void => {
  if (webRegistered) return
  const webServer = (ctx.get('webServer') ?? ctx.get('httpServer')) as WebRouteHost | undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined
  if (webServer === undefined || workspaceRegistry === undefined) return
  webRegistered = true
  ctx.effect(() => webServer.register({ /* ... */ }), 'agent-teams: activity route')
}
registerWebSurface()
ctx.on('internal/service', (name) => {
  if (/* name 命中候选键 */) registerWebSurface()
})
```

要点:先试一次,再在每次服务绑定事件时重试;webless profile 下插件退化为纯工具形态,**永不阻塞启动**。若把这些服务写进 `inject`,headless 下会永久等待。

同一文件还演示了跨版本服务改名的兼容写法(`src/index.ts:49-52`):`WEB_SERVER_KEYS = ['webServer', 'httpServer']`,新名在前。

---

## 6. 工具注册

```ts
ctx.tools.register(defineTool({
  name: 'read_file',
  description: 'Read a file from disk.',
  parameters: { path: { type: 'string', required: true, description: 'Absolute path' } },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) { /* args 已按 schema 类型化 */ },
}))
```

### `execute()` 契约(`docs/cookbook/adding-a-tool.md:41-49`)

- 参数已按 `ParameterSchemaSpec` 预校验;DSL 表达不了的仍需手查(非空字符串、正数、跨字段规则)
- 把 `args` 当只读。不要改定义的 schema,也不要注册后换回调
- 返回**一个符合 `output.schema` 的规范 JSON 值** —— 不要返回内容块,不要返回需要调用方解析的散文
- 抛错或返回 schema 不合规的值 ⇒ `isError`。基础设施故障用抛错;成功的领域结果(如非零退出码)要表达在规范值里
- 尊重 `exec.signal`
- `exec.agent.inject({ content, source })` 追加的上下文**下一次**模型请求才可见,不是唤醒。要用 try/catch 防已销毁的 agent

### UI 渲染意图是设计的一部分

必须上手就定(`adding-a-tool.md:67-90`)。`presentCall(args)` 返回:

- `{ card: 'generic', title, kind?, rawInput?, content?, locations? }` —— 默认。`kind` 决定图标;凡是碰文件就给 `locations: [{ path, line? }]`
- `{ card: 'terminal', title, description?, cwd? }` —— 调用本身就是 shell 命令
- `{ card: 'diff', title, diffs, locations? }` —— `diffs: [{ path, oldText, newText }]`,新文件用 `oldText: null`

`presentResult(args, { content, isError, meta? })` 另有 `search`(`shape: 'matches'|'paths'`)和 `web` 两种卡。注意**没有 `search` 调用视图** —— 发现类调用的 pending 状态用 generic 卡。

三条硬规则:

- **纯函数。** 这些方法在实时流式**和**会话日志重放时都会跑,必须是 `args`(+ 结果)的纯函数。无 I/O、无会话状态、无时钟/随机。想在 `presentCall` 里拿文件旧内容或 cwd,说明那属于持久化结果元数据
- **仅供 UI 的格式化不进模型结果。** ```` ```console ```` 围栏、diff、相对化路径,都不属于规范值
- `defineTool` 对显示路径做**软校验**:参数畸形或是旧日志的参数时,包装器返回 `undefined` 走 generic 回退,而不是抛错。显示永远不能让重放崩掉

### Code Mode 免费获得

`adding-a-tool.md:61-65`:每个可见工具都是 `await tools.<name>(args)`。所以 `output.schema` 要按编程 API 设计 —— 返回句柄和字段,把给人看的解释放在 `output.render`。

---

## 7. 浏览器半边

### 两个声明必须同时存在

`package.json` 里声明 `dsh.client`,**且** `exports["./client"]` → `lib/client.js`。缺一即抛(`client/modules/src/index.ts:356`)。

```ts
interface DshClientDeclaration {
  inject?: string[]
  platform: string
  /** Boot phase-one prefetch mark; absent means lazy (fetched on demand). */
  immediately?: boolean
}
```

逐字段校验(`index.ts:109-129`),每个畸形字段各自抛错。`platform !== 'web'` 会被缓存成永久否定,静默不成为 client 行。

**`inject` 边仅供预检显示与 HMR 比对,不排序激活**(`packages/client/AGENTS.md:96`);激活顺序由 cordis fiber 等服务决定。

### 唯一的 UI 组合 API 是 slots

```ts
ctx.slots.register({ name, children?, store?, inject? }, Component)
```

要注册进**别人的** slot,必须用 `ctx.slots.inject(name, () => ctx.slots.register(...))`;裸 `register` 进未声明的 slot 是错误。`children` 键同时是声明和授权。**组件永远看不到 `ctx`。**

`dsh-agent-teams` 的 client 入口(`src/client/index.tsx:21-44`)展示了两种挂载方式:

```ts
export const inject = ['conversationEvents', 'slots', 'sessions']

export function apply(ctx: ClientContext): void {
  // 1) web shell 没有右上角 slot,所以用 body portal 挂浮层
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(<ActivityPanel /* ... */ />)
  ctx.effect(() => () => { root.unmount(); host.remove() }, 'agent-teams: activity panel')

  // 2) 注册进会话内的 chat-node slot
  ctx.conversationEvents.register(agentTeamsCardDefinition)
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'agent-teams', inject: () => ({ /* ... */ }),
  }, AgentTeamsCard))
}
```

### 构建配置必须自行复刻

`packages/client/tsdown.client.ts` **不是可发布包**(`packages/client` 下没有 `package.json`),仓库外无法 import。`dsh-agent-teams/tsdown.config.ts` 是一份可用的复刻,关键点:

```ts
const config: UserConfig = {
  entry: { client: 'lib/client/index.js' },   // 注意:入口是 tsc 产物,不是 src
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  clean: false,                                // 默认 clean 会擦掉 node 半边
  external: [...CLIENT_EXTERNALS],
  noExternal: (id) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}
```

`PLUGIN_ID` 要**从 package.json 读**而不是硬编码 —— 宿主按包名查找 bundle,重命名后若 client 半边仍注册旧 id,只会在浏览器里失败,而宿主半边已经正常加载了。

externals 必须恰好是这张冻结表(`packages/client/web/src/platform.ts:8-16`):

```ts
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const
```

加上一个有文档记载的豁免:`@deepseek-ai/dsh-client-runtime/client`。**表外的 `require` 保证运行时抛错。**

### 构建期纯度门

`tsdown.client.ts:208-225` 的 `dsh-client-bundle-purity` 插件会在构建时**抛错**,拦截任何不属于平台模块、inline-safe wire 层、或生成的 `/remote` 的 `@deepseek-ai/*` **值导入**:

> cross-plugin value imports are forbidden; collaborate through cordis services (type-only imports are erased and never reach this gate)

允许 inline 的正则(`dsh-agent-teams/tsdown.config.ts:38-44`):

```ts
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/
```

**type-only 导入被擦除,不受此门约束。**

### 最小参考实现

`packages/client/ui-sidebar` 和 `ui-user-questions` 是最小骨架(`client/AGENTS.md:92`);`ui-workspace` 是完整范例;最接近「扩展贡献面板」的是 `packages/extensions/ui-cordis`。

---

## 8. TypeScript 配置

`dsh-agent-teams` 用两份 tsconfig 分离宿主与浏览器。

`tsconfig.json`(宿主半边):

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true, "noImplicitAny": true, "noUncheckedIndexedAccess": true,
    "declaration": true, "declarationDir": "lib/types", "outDir": "lib", "rootDir": "src",
    "allowImportingTsExtensions": true, "rewriteRelativeImportExtensions": true,
    "types": ["node"]
  },
  "include": ["src"],
  "exclude": ["src/client"]
}
```

`tsconfig.client.json`(浏览器半边):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "types": [] },
  "include": ["src/client", "src/event-types.ts", "src/css-modules.d.ts"],
  "exclude": []
}
```

注意 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` —— 源码里写 `./tools.ts`,编译后重写为 `.js`。这与 dsh 仓库自身的约定一致(本地相对导入带 `.ts`)。

构建脚本三步:

```json
"build": "tsc -p tsconfig.json && tsc -p tsconfig.client.json && tsdown"
```

先出宿主 `lib/`,再出 `lib/client/`,最后 tsdown 把 `lib/client/index.js` 打成 `lib/client.js`。

---

## 9. 仓库外插件的边界

### 不能扩 `SessionEventMap`

这是最硬的一条,由生成代码而非政策强制。`packages/core/session/src/known-event-types.ts:8-18`:

> "Every `SessionEventMap` member declared in **this repository** ... **Downstream (out-of-repo) plugin events are outside this list by construction; a registration surface for them is deferred until such a consumer exists.**"

机制:生成器的 glob 是相对仓库根的 `packages/*/*/src/**/*.ts`(`scripts/gen-persistence-catalog.ts:171`),产出一个冻结的 `ReadonlySet`。仓库外的包**在构造上**就进不去。

强制点在 `packages/session/session-persistence/src/coordinator.ts:1061`:

```ts
private assertEventsSupported(meta: SessionHeader, events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue
    throw this.unsupported(meta, `... refusing to interpret the log ...`)
  }
}
```

所以:类型上可以 `declare module` 合并、`Session.append()` 也会接受,但**之后每次读该日志都抛 `SessionFormatUnsupportedError`**,除非带 `ignorable: true`。而 `ignorable` 的契约(`types.ts:412-422`)规定它只能用于「丢失也不影响重建」的纯信息记录。

**结论:必须在重放后存活的状态一律落 storage domain,不进 session log。**

### `storage` 三行只在 web-app

`storage` / `storage-json` / `storage-domain` 只出现在 `packages/bundle/web-app/cordis.patch.yml:51-62`,`base` 里没有。

后果:注入 `storageDomain` 的插件在 `web` profile 下能激活,在 `headless` 或自定义 profile 下**静默永不激活**(cordis 无限等待服务)。要保证可移植性,自己的 patch 必须插入这三行:

```yaml
- id: storage
  name: '@deepseek-ai/dsh-storage'
- id: storage-json
  name: '@deepseek-ai/dsh-storage-json'
  config:
    root: !!js dshHomePath('storages')
- id: storage-domain
  name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

用法:`defineDomain`(zod record schemas)→ `await ctx.storageDomain.open(spec)` → 自持生命周期,用 `ctx.effect` 的 disposer 调 `Domain.close()`。`open` 的拒绝码:`already-open` / `backend-not-found` / `facet-unsupported` / `invalid-record`。

已记录的限制:`domain/changed` **仅进程内**;无跨表事务、无二级索引、无多段 key。

### 稳定性预期

没有单一的「public API」文档。最接近的是 `packages/README.md` 的分组表:多数组标为 "Product — stable API",`test-support/` 是 "lower compatibility expectations",`e2b/` 是 "POC"。

另外 `AGENTS.md:7` 的预发布立场:在首个 tag 发布前,「prefer the correct foundation over compatibility shims: rename or repackage freely」。所以要预期改名。`dsh-agent-teams` 的应对是候选键数组(新名在前)+ 结构化接口切片,值得照抄。

---

## 10. 已知的版本陷阱

本地 dsh 仓库是 `0.1.0-rc.5`;npm 上 `@deepseek-ai/dsh` 是 `0.1.0-rc.6`,但 `dsh-tools` / `dsh-workspace` / `dsh-storage-domain` / `dsh-session` 只有 **`0.0.1-rc.1`** —— 差一个大版本。

`dsh-agent-teams` 声明兼容 `^0.1.0-rc.6`,说明它依赖的是已发布的 rc.6 那批。开发期若要用本地仓库的 API,依赖得指向本地源码;要发布给别人用,得等 npm 版本追上。

---

## 11. 开发与验证循环

```sh
pnpm install
pnpm build                                  # tsc 宿主 → tsc 客户端 → tsdown
dsh plugin --profile web add .              # 本地路径安装,保持软链到 checkout
dsh --profile web --dump-config              # 验证组合结果
dsh web                                     # 重启后刷新 Web UI
```

改动源码后要重跑 `pnpm build`。

`dsh-agent-teams` 没有 `tests/` 目录,验证靠 `pnpm verify` 串起四个脚本(`verify.mjs` / `lifecycle-verify.mjs` / `stress-verify.mjs` / `verify:skill`),并在 `prepublishOnly` 里跑 `pnpm build && pnpm verify`。

> 注意:dsh 仓库的质量门(`verify-export-jsdoc`、`test:coverage`、`doc-sync` 等)只跑在 `packages/*/*/src` 上,**不会跑到仓库外的包**。所以那些 JSDoc 与文档要求对我们是约定而非强制 —— 但既然目标是符合规范,应当自愿遵守。
