# dsh-memtree · 长期记忆

Long-term memory for DeepSeek Harness, ported from [QwenPaw](https://github.com/agentscope-ai/QwenPaw):
memory-as-file (`MEMORY.md`, daily notes, `digest/` knowledge), notes the agent writes itself during the
conversation, nightly Auto Dream consolidation, and hybrid BM25 + vector search with wikilink expansion.

把 [QwenPaw](https://github.com/agentscope-ai/QwenPaw) 的长期记忆机制移植为 DeepSeek Harness（DSH）插件。

QwenPaw 的长期记忆是一套完整的循环：**记录 → 引入 → 整理 → 连接 → 找回 → 展开**。它的核心不是"把所有聊天存起来"，而是
**Memory as File, File as Memory**——核心记忆、每日记忆和整理后的长期知识都是工作区里的普通 Markdown，索引只是可重建的派生状态。
本插件把同一套循环实现在 DSH 的 Host 插件里：文件布局、对话内按需记录、Auto Dream、混合检索和系统提示引导一一对应。

## 机制对照

| QwenPaw | 本插件 | 说明 |
| --- | --- | --- |
| `MEMORY.md` | `<root>/MEMORY.md` | 核心长期记忆，用户与 Agent 都可编辑；可选注入系统提示 |
| `memory/YYYY-MM-DD.md` | 同左 | 当天记忆笔记的索引页，`<!-- notes:auto -->` 区块自动重建，区块外手写内容保留 |
| `memory/YYYY-MM-DD/{topic}.md` | 同左 | 一个 session 对应一条主题笔记，由 Agent 按需写入 |
| `digest/{personal,procedure,wiki}/` | 同左 | Auto Dream 整理出的长期知识，Wikilink + `## Sources` 互连 |
| `mem_metadata/` | 同左 | 可重建的索引、图谱、Embedding 缓存与 dream 水位 |
| Auto Memory（每 5 个用户回合） | **已移除** | 不再有定时总结，也不再有单独的「汇总模型」调用：Agent 在当前对话里自己总结，并用 `memory_write` 写入 |
| Auto Dream（CREATE/CORROBORATE/REFINE/CORRECT） | `memory_dream` 工具 + 可选定时 | 只整理已变化的每日笔记，绝不改写每日笔记与 `MEMORY.md` |
| `memory_search`（BM25 + 向量 + RRF + 图谱展开） | `memory_search` 工具 | BM25 始终可用；配置 Embedding 后启用向量 + RRF；返回片段并支持沿 Wikilink 展开 |
| `MEMORY_GUIDANCE` 提示 | 系统提示 section | 告知文件位置、何时检索、如何用 `read` 渐进展开 |

## 目录结构

`<root>` 默认是 **`$DSH_HOME/long-term-memory/`**（本机 `/root/.dsh/long-term-memory/`），
下面**每个 Agent 模式一个子目录**（`perPreset: true`）：

- 记忆是**全局的、按模式隔离**的，**不会**在任何工作区里创建 `.dsh-memory/`；
  同一种模式在 `/root/workspace/a` 和 `/root/workspace/b` 里用的是同一棵树；
- `root` 写相对路径时相对 **`$DSH_HOME`** 解析，不是相对工作区；写绝对路径则完全由你指定；
- 只对**已启用**的模式建目录：面板里关掉的模式，切过去看一眼也不会产生任何文件。

```text
$DSH_HOME/long-term-memory/
├── standard/                          # 每个 Agent 模式一棵树（standard / ptc / minimal / cordis …）
│   ├── MEMORY.md                      # 少量、稳定的核心长期记忆
│   ├── memory/
│   │   ├── 2026-10-21.md              # 当天索引页（notes:auto 区块）
│   │   └── 2026-10-21/
│   │       └── 主题笔记.md             # 一个 session 一条主题笔记
│   ├── digest/
│   │   ├── personal/                  # 身份、偏好、关注范围、长期约定
│   │   ├── procedure/                 # 可复用流程 / runbook
│   │   └── wiki/                      # 定义、事实、观察、原则、心智模型
│   └── mem_metadata/                  # 索引、图谱、Embedding 缓存、dream 状态
└── cordis/                            # 创造模式：同样的结构
```

> `perPreset: false` 时所有模式共用 `<root>` 本身，不再加模式子目录。

一条已经沉淀的长期知识节点：

```markdown
---
name: 新能源汽车产业链
description: 跟踪整车需求、动力电池盈利与上游锂资源的传导关系。
kind: wiki
updated: 2026-10-21
---

# 新能源汽车产业链

需求从整车销量传导到动力电池排产，再影响正极材料和锂资源需求。
评估单环节的盈利敏感性时，先确认售价联动、库存成本与产品结构三条渠道。

## Sources

- [[memory/2026-10-21/主题笔记.md]]
```

## 界面风格（v0.14.0：按 ReMe 状态页重做信息架构与渲染）

面板不再只是"长得像"，而是按 ReMe 的状态页重建了页面结构与交互：

**页签**：总览 / 自动记忆 / 记忆整理 / 组件 / 日志 / 知识库 / 检索 / 设置。
**知识库图谱**：知识库页签顶部是一张仅含 `digest/` 节点的网状图（圆环布局、紫色节点），点击节点直接打开该知识；文档详情里新增「关联知识」区，分「上联（入链）/ 下联（出链）」两组胶囊，点击可跳到关联笔记。

**分组与折叠**：日志按日期分组、知识库按 `digest/<分类>`（个人 / 流程 / 知识）分组。组头是醒目的整条按钮——品牌色左边线 + 7% 底色 + 12.5px 加粗标题 + 右侧数量胶囊 + ▾/▸ 指示，知识库组头用紫色区分；组间 18px 间距 + 1px 分隔线。逐组展开/收起，`aria-expanded` 同步。library hero 只保留标记 / 标题 / 描述（不再显示文件数与目录，避免顶部堆数字）。设置页的每个分组同样可折叠（`details`）。

**稳定性**：Markdown 渲染包了一层错误边界（`MarkdownBoundary`），并传入原语要求的 `labels`；即使某个 Markdown 树抛错，也只降级成 `<pre>`，不会把整块面板渲染成空白。页头的「立即整理」按钮已移除，整理动作只保留在「记忆整理」页。


- **总览**：workspace hero（46px 标记 + eyebrow + 等宽根路径 + 健康徽章 + 四列 `dl` 元信息）→ 能力网格（核心记忆 / 日志与笔记 / 长期知识 / 索引片段）→ 两个 feature hero（自动记忆、记忆整理，各带 3 步 flow card 与"立即整理"按钮）→ 组件网格 → 折叠的「高级信息」。
- **自动记忆 / 记忆整理**：各自的 feature hero + flow card（判断 → 写记忆 → 刷新索引 / 扫描变化 → 提炼节点 → 推进水位），整理页带立即整理按钮与上次整理时间。
- **组件**：两列组件卡（文件存储 / 关键词索引 / 向量检索 / Wikilink 图谱），每张卡有标题、副标题、状态徽章与两列 `dl` 指标。
- **日志 / 知识库**：与 ReMe 的 Journal / Knowledge 一致 —— 顶部 library hero（J/K 方块标记 + 标题 + 描述 + 文件数 + 目录），左栏是**吸顶搜索框 + 计数 + 带 J/K 标记的文件行**（文件名 + 相对路径），右栏是**文档预览**：
  - `header`：类型 + 文件名 + 等宽相对路径（sticky，带模糊背景）
  - **文档元数据**：解析 YAML frontmatter 后以 `dt/dd` 网格渲染（不再是裸文本）
  - **文档内容**：用宿主共享的 `MarkdownText` 原语渲染 Markdown（标题、列表、代码、链接、表格），拿不到原语时降级为 `<pre>`
- **检索**：输入框 + 主色按钮；结果卡片复用组件卡样式，命中片段同样走 Markdown 渲染。
- **设置**：工具栏（状态圆点 + 同步/未保存 + `ltm-pending` 胶囊 + overrides 路径）、分组 section 卡、布尔项为复选框、底部还原/保存；「Agent 模式」成为设置里的一个 section（复选框开关）。

客户端半边因此声明依赖 `@deepseek-ai/dsh-client-ui-primitives`（`dsh.client.inject`），用它提供的 `MarkdownText` 渲染文档与检索片段。

## 核心记忆预算（硬约束）

`MEMORY.md` 每轮都会注入系统提示，所以它有**按字节计算的硬预算**（`inject.memoryMdMaxBytes`，默认 4096）：

- **写入即校验收**：`memory_write` / `memory_edit` 命中 `MEMORY.md` 且写入后会超预算时，**直接拒绝**并返回可操作的说明（告诉 Agent 该把内容写到 `memory/<日期>/<主题>.md`，或先精简再试）。文件保持原样，不会出现"写进去了但被截断"的半状态。
- **工具结果回报用量**：写 `MEMORY.md` 成功后，返回里会带 `核心记忆 1.7KB/4KB` 这样的标注，方便判断还剩多少空间。
- **系统提示写明规则**：引导段落里明确"只放长期有效的约定与边界；不要放过程、版本流水账、排障细节、每日进展"，并给出当前预算数字。
- 注入侧仍然按上限截断，作为最后一道保险。

预算是"每次写入后的文件大小"，不是增量；改小预算（最低 1024）不会被旧文件卡住，但下一次写入必须降到预算内。

## 工具

| 工具 | 作用 |
| --- | --- |
| `memory_search` | 混合检索个人知识库（`memory/` + `digest/`），返回 `路径:行号`、分数、片段以及 outlinks/inlinks；片段不足时用 `read` 沿路径渐进展开 |
| `memory_dream` | 把变化的每日笔记整理进 `digest/`，每条笔记只产生一个动作（CREATE / CORROBORATE / REFINE / CORRECT）；`dryRun` 可预演 |
| `memory_status` | 报告记忆根目录、文件数量、索引片段数、是否启用向量检索、上次整理时间 |
| `memory_write` | 新建 / 覆盖 / 追加一个记忆文件（`MEMORY.md`、`memory/<日期>/<主题>.md`、`digest/<类>/<主题>.md`）；写入后自动重建当天索引页并刷新检索索引 |
| `memory_edit` | 在某个记忆文件里精确替换一段文本（用于就地修正结论、更新偏好）；匹配不到或不唯一时报错，不猜 |

另外注册了 `/memory` 命令：

| 命令 | 作用 |
| --- | --- |
| `/memory` / `/memory status` | 记忆布局与索引状态 |
| `/memory search <关键词>` | 立即检索个人知识库 |
| `/memory dream` | 立即执行 Auto Dream；支持 `--dry-run`（预演）与 `--force`（忽略水位，处理全部每日笔记） |

## 编辑记忆（memory_write / memory_edit）

记忆树在 `$DSH_HOME/long-term-memory/`，**位于会话工作区之外**。而会话权限档位（`workspace-write`）只允许写工作区与临时目录，所以 Agent 自带的 `write` / `edit` 工具**改不到记忆文件**。这两个工具由插件在 Host 侧写入，因此在任何权限档下都能用，代价是路径必须由插件自己把关：

| 允许 | 拒绝 |
| --- | --- |
| `MEMORY.md` | `mem_metadata/`（索引、向量缓存等派生状态） |
| `memory/<YYYY-MM-DD>/<主题>.md`（主题笔记） | 记忆树之外的任何路径、含 `..`、非 `.md` |
| `memory/<YYYY-MM-DD>.md`（当日索引页 / 日记） | |
| `digest/<personal\|procedure\|wiki>/<主题>.md` | |

**当日索引页是「部分托管」的**，所以它可以写：

| 页面部分 | 谁维护 |
| --- | --- |
| `<!-- notes:auto -->` … `<!-- /notes:auto -->` 区块 | 插件按磁盘上真实存在的笔记重建 |
| frontmatter `description` | 仅当它还是自动值（`N note(s) today.`）时重算，你写的描述会保留 |
| 区块之外的正文（日记、复盘） | 归写入者，原样保留 |

写入后会自动重建受影响那天的索引页并刷新检索索引，所以新内容下一次 `memory_search` 立刻可见；即使写入时把 `notes:auto` 区块的标记整段删掉，重建也会把它补回来。`memory_write` 会保留已有 frontmatter（对 `MEMORY.md` 追加不会丢 `summary`/`read_when`）；`memory_edit` 要求匹配唯一，命中多处时报错而不是挑一个改。

两个工具随 `inject.edit`（默认开）注册，并且和其余记忆工具一起受「模式启用」约束：面板里关掉的模式拿不到写路径。

## 系统提示

- **引导 section**：说明 `MEMORY.md`、每日索引、主题笔记与 `digest/` 的职责，并规定"涉及用户过去的事实、偏好、决策或经验时先 `memory_search`，片段不足再 `read` 展开"。
- **会话自己的记忆树**：引导 section 会写明**本会话**的记忆树绝对路径与 Agent 模式 id（如 `/root/.dsh/long-term-memory/cordis`），并说明三件事：①记忆按模式隔离，别的模式的树不是你的记忆；②记忆树在工作区之外，不要去工作区建 `.dsh-memory/` 或找记忆；③`memory_search` 的结果路径是相对记忆树的，用 `read` 打开要拼上树根，而 `memory_write` / `memory_edit` 的 `path` 保持相对形式。该文本每次组装提示词时按当前模式重新解析，会话中途切模式也会跟着换树。
- **核心记忆 section**（Agent 作用域）：注入有字节上限的 `MEMORY.md` 内容，让稳定的长期约定无需工具调用即可见。
- **编辑指引**（`inject.edit` 开时）：在引导 section 里多一行「要改记忆就用 `memory_write` / `memory_edit`」，并说明当日索引页的日记正文可写、其中 `notes:auto` 区块由插件重建。

## 后台任务

- **对话内按需记录（没有后台调用）**：Agent 判断出现了值得长期保留的信息时，**自己在本轮把要点写成笔记正文**，再调用 `memory_write` 落盘；没有额外的汇总模型、没有定时任务，也不产生额外模型费用。用户说「总结一下 / 记一下」就是让 Agent 当场这样做。
- **Auto Dream**：默认每天 `04:00`（本地时间，离峰）对所有空闲会话整理一次；进程在 `HH:MM` 没运行时会顺延补跑一次，当天已整理过的记忆树不会重复整理；也可用工具/命令手动触发，或额外设置 `intervalMinutes`。整理后的索引在后台刷新。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖同一行 id 的 `config`：

```yaml
- id: long-term-memory
  name: 'dsh-memtree'
  config:
    root: long-term-memory
    language: zh
    search:
      maxResults: 8
      embeddings:
        enabled: true
        baseURL: https://api.example.com/v1
        apiKeyEnv: MY_EMBEDDING_KEY
        model: text-embedding-3-small
```

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `root` | `long-term-memory` | 记忆根目录；相对路径按 DSH home 解析（全局），也可写绝对路径 |
| `perPreset` | `true` | 在 root 下按 Agent 模式再分一层（`<root>/<模式>/`）；false 则所有模式共享一份 |
| `language` | `auto` | `auto` / `zh` / `en` |
| `autoDream.enabled` | `true` | 是否允许 Auto Dream |
| `autoDream.autoRun` | `true` | 是否按每日时刻自动整理 |
| `autoDream.dailyAt` | `'04:00'` | 每日整理时刻（本地时间，离峰更便宜） |
| `autoDream.maxNotesPerRun` | `4` | 每次最多整理几条笔记（限制一晚的花费） |
| `autoDream.intervalMinutes` | `0` | 额外的固定间隔（0 = 关闭） |
| `inject.edit` | `true` | 向 Agent 暴露 `memory_write` / `memory_edit`（仅在启用的模式里；关掉则 Agent 只能检索、不能改记忆） |
| `search.maxResults` | `8` | 返回文件数上限 |
| `search.maxSnippetLines` | `18` | 每个片段的最大渲染行数 |
| `search.expandLinks` | `true` | 是否沿 Wikilink 展开 |
| `search.embeddings.*` | 关闭 | OpenAI 兼容的 `/embeddings` 端点、模型与环境变量名 |
| `scope.mode` | `all` | `all`=每个 Agent 模式默认开启；`selected`=只在面板里勾选的模式开启 |
| `scope.presets` | `[]` | 例外列表：`all` 下为排除名单、`selected` 下为开启名单。默认为空——**所有模式一视同仁**，包括创造模式 `cordis` |
| `backgroundModel.*` | 空 | 夜间整理（dream）使用的模型路由：`baseURL` + `model` + `apiKeyEnv`（直连 OpenAI 兼容端点）；留空则用 Agent 默认模型 |
| `autoDream.model` | 空 | 对 `backgroundModel` 的 dream 专用覆盖 |
| `inject.guidance` | `true` | 是否注入记忆引导 |
| `inject.memoryMd` | `true` | 是否注入 `MEMORY.md` 摘要 |
| `inject.memoryMdMaxBytes` | `4096` | 摘要字节上限 |

## 工作模式（按 Agent 模式全局管理）

这里的「工作模式」指右上角切换的 **Agent 模式（Agent Preset）**：标准模式 `standard`、PTC 模式 `ptc`、极简模式 `minimal`、创造模式 `cordis`。

**每个模式在全局有一份记忆**，所有工作目录里跑同一模式的会话共享它（不是每个目录各存一份）：

```text
$DSH_HOME/long-term-memory/
├── standard/     # 标准模式：MEMORY.md、memory/、digest/、mem_metadata/
├── ptc/          # PTC 模式
├── minimal/      # 极简模式
└── cordis/       # 创造模式
```

- 当前模式由 `agentPresets.composedPreset(agent.ctx)` 解析（会话头 `agentPreset` 兜底）；
- `root` 默认 `long-term-memory`，相对路径按 **DSH home** 解析（默认 `/root/.dsh/long-term-memory`），也可写绝对路径；
- `perPreset: false` 时所有模式共用 `<root>` 一份。

**选择对哪些模式开启**：

- 面板 **设置 → 长期记忆 → 模式** 列出所有已注册模式（名称 + id + 全局记忆根），逐个开关；
- 开关持久化在 `$DSH_HOME/long-term-memory/presets.json`，与记忆内容分离；
- `scope.mode: all`（默认）默认全开、可单独关闭；`selected` 默认全关、只开勾选的；
- 关闭后：该模式的 Agent 不再收到记忆提示段，三个记忆工具从它的工具列表隐藏（`tools.restrict`），定时整理跳过它，`/memory` 提示未启用。

## 设置（在面板里配置模型、URL、节奏与密钥）

**设置 → 长期记忆 → 设置** 四组表单，保存后立即生效，无需改 profile 文件：

| 分组 | 字段 | 作用 |
| --- | --- | --- |
| 语义搜索（Embedding） | 启用 / Base URL / 模型 / 密钥值 | `memory_search` 的向量分支；留空则只做 BM25 关键词检索 |
| 记忆整理模型（Auto Dream） | 同上 | 把每日笔记整合成长期知识时使用 |
| 记忆节奏 | 启用 Auto Dream / 按计划自动整理 / 每日时间 `HH:MM` / 或固定间隔分钟 | 只控制夜间整理；对话汇总由 Agent 自行判断 |

### 密钥只写不回显

- 面板中密钥输入框是 `password` 类型，**永远显示为 `***`**；已配置时只显示「已配置：***（不可查看）」；
- 密钥值通过 Host 凭据服务写入（`credentials.set`），落到 `$DSH_HOME/.credentials.yaml`（0600），**因此重启不丢**；但**不写入插件文件、不返回给前端、不写日志**；
- 凭据名由插件内部解析（未配置时用固定槽位 `DSH_LONG_TERM_MEMORY_KEY`），**面板不再展示也不需要填写**。

#### `apiKeyEnv` 必须是凭据名，不能是密钥本体

`apiKeyEnv` 是 **引用名**（POSIX 标识符，如 `UNIAPI_API_KEY`），不是密钥值。Host 凭据库的 `refs:` 段只接受这种键，且**在下次启动加载整份文件时**校验：一旦出现 `sk-…: sk-…` 这类非法键，整份凭据文件会加载失败，表现为「重启后所有密钥都没了」。插件对此三层防护：

1. 配置归一化：`apiKeyEnv` 不匹配 `^[A-Za-z_][A-Za-z0-9_]*$` 时丢弃并回落到默认名；
2. 面板写入：`saveSettings` 收到密钥本体直接拒绝（400 `long-term-memory/bad-request`）；
3. 启动自愈：`overrides.json` 里历史遗留的密钥型 `apiKeyEnv` 会被改写成真实引用名、值抢救进凭据库（仅当该槽位为空）、并把文件重写为不含密钥的版本。

被拒的分组一律使用插件私有槽位 `DSH_LONG_TERM_MEMORY_KEY`，**不会**回落到 `DEEPSEEK_API_KEY` 等共享名字，避免覆盖别的凭据。

### 节奏

- **Auto Memory 已删除**：插件不再注册 `agent/turn-stopping`，没有回合计数、没有窗口游标、没有 `session-progress.json`，也没有单独的汇总模型调用。记忆是否写入、写什么，由 Agent 在当前对话里自己判断并用 `memory_write` 完成。
- **Auto Dream**：默认每天 `04:00` 整理一次（本地时间，离峰），也可用 `intervalMinutes` 追加固定间隔——
  - 每日时刻：`dailyAt: '04:00'`（本地时间，24 小时制，留空关闭）；
  - 固定间隔：`intervalMinutes: 0`（0 关闭）；
  - 单次上限：`maxNotesPerRun: 4`，没有变化的笔记不会触发模型调用。
- 定时器每 60 秒读取一次当前配置，因此面板改动**无需重载**即刻生效。`dailyAt` 按「到点即到期」判断：过了 `HH:MM` 当天还没整理过就补跑一次（进程重启、错过分钟都不会丢掉这一晚），每天每个记忆树最多整理一次；补跑前会读 `dream-state.json` 的水位，当天已经整理过的树直接跳过。

### 持久化位置

`$DSH_HOME/long-term-memory/overrides.json`（默认 `/root/.dsh/long-term-memory/overrides.json`），覆盖 profile 中的同名配置项：

```json
{
  "version": 1,
  "embeddings": {
    "enabled": true,
    "baseURL": "https://your-gateway.example.com/v1",
    "apiKeyEnv": "UNIAPI_API_KEY",
    "model": "text-embedding-v4",
    "timeoutMs": 20000
  },
  "dream": {
    "baseURL": "https://your-gateway.example.com/v1",
    "apiKeyEnv": "UNIAPI_API_KEY",
    "model": "your-dream-model",
    "maxTokens": 8192,
    "timeoutMs": 240000
  },
  "rhythm": {
    "autoDream": { "enabled": true, "autoRun": true, "dailyAt": "04:00", "intervalMinutes": 0 }
  }
}
```

## 夜间整理模型（YAML 兜底）

面板「设置」是首选配置入口；如果要用 YAML 做默认值，仍然支持 `backgroundModel` 作为兜底，`autoDream.model` 可单独覆盖（对话汇总不再调用任何后台模型，因此没有对应配置）：

```yaml
backgroundModel:
  baseURL: https://uniapi.ruijie.com.cn/v1
  apiKeyEnv: UNIAPI_API_KEY
  model: deepseek-v4-flash-wot
  maxTokens: 32000
  temperature: 0.2
  timeoutMs: 300000   # 生成 32k 预算可能需要 2-4 分钟
autoDream:
  model:
    model: qwen3.6-35b-a3b   # 仅 dream 换成另一个模型
```

- 有 `baseURL` → 直连 `POST {baseURL}/chat/completions`，自带模型与凭据；
- 只有 `provider` + `model` → 走 Host 已注册的 LLM 路由；
- 都为空 → 回退到 Agent 当前默认模型；
- 密钥仍按名字从 Host 凭据库解析，不写进配置文件。

### 输出预算与思考型模型（`did not contain a JSON object or array` 的真正原因）

背景模型如果是**思考型模型**（`glm-5.3-flash`、`o*`、`deepseek-reasoner` 等），它会先花输出 tokens 写
`reasoning_content`，再写正式回答。于是有个隐蔽的坑：

| 配置的 max_tokens | 实际发生 | 结果 |
|---|---|---|
| 2048 | 2048 个输出 token 全被思考吃掉（`reasoning_tokens: 2014`） | `content` 为空、`finish_reason: length` |
| 32000 | 思考 6623 + 正文 3130 | 正常返回 JSON |

`content` 为空时，旧的解析链会报 `LLM reply did not contain a JSON object or array; reply started with: `（后面什么都没有）。**这不是解析器的 bug，是预算不够**——而且是插件自己造成的：调用点曾把 `maxTokens: 2048` 写死，面板里配的 32000 根本没被使用。

现在的机制（`src/llm.js`）：

1. **预算由配置决定**：调用点不再传死数字，`LlmHelper` 用路由的 `maxTokens`（面板「最大输出 tokens」），缺省 8192；
2. **截断自动加预算**：空回复且 `finish_reason: length` 时按 ×4 重试，最多 2 次、上限 32768，并记录 `reasoning_tokens`；
3. **只有思考没有正文**时用 `reasoning_content` 兜底，而不是当成空回复；
4. **JSON 不合法再问一次**：把失败原因和回复开头回给模型，要求「只输出 JSON」，一次；
5. 仍失败才抛错，并且错误里写明真实原因与解法：`background model produced no text (finish_reason=length, reasoning_tokens=…, max_tokens=…) … raise 最大输出 tokens`。

**超时也必须跟着预算走。** 大预算意味着长生成：实测 32000 预算的一次 dream 调用耗时 **137 秒**（思考 6401 tokens + 正文 3075 字）。旧默认 `timeoutMs: 60000` 会在第 60 秒中断一个本来正常的请求，报 `The operation was aborted due to timeout`。现在的规则：

- 每次请求的超时 = `max(配置值, 30 秒 + 5 毫秒 × 预算)`，所以 2048 → 40 秒、8192 → 71 秒、32000 → 190 秒；
- 默认 `timeoutMs` 从 60 秒提到 240 秒，面板新增「超时（毫秒）」字段，留空即用上面的自适应规则；
- 整个调用（含重试）有 15 分钟硬上限，避免一次后台任务无限拖；
- 超时会给出可操作的错误，而不是裸的 abort 文案：
  `direct model timed out after 190s (max_tokens=32000, model=…) … lower 最大输出 tokens or raise 超时 (timeoutMs)`。

如果不想付思考的 token，把背景模型换成非思考模型（例如网关上的 `deepseek-v4-flash` 之类）即可——顺带也能把 137 秒压到几十秒。

## 知识面板

插件在 **设置 → 长期记忆** 增加一页面板（`settings.section`），数据全部来自 Host 路由 `api/long-term-memory/*`：

- **概览**：按「核心记忆 / 每日索引 / 主题笔记 / 长期知识」分组列出文件，右侧预览原文（含 frontmatter）。
- **搜索**：与 Agent 使用同一套混合检索（BM25 + 可选向量 + RRF + Wikilink 展开），结果显示 `路径:行号`、融合分、关键词分、向量分以及出链/入链数量。
- **图谱**：把记忆文件按 Wikilink 关系画成圆形布局，点击节点跳到原文。
- **模式**：列出标准 / PTC / 极简 / 创造等 Agent 模式及其记忆根目录，点击切换该模式是否启用长期记忆。
- **预演整理**：调用 Auto Dream 的 dry-run，只报告计划动作，不写文件。

面板是独立的客户端半边（`client.js`），宿主侧提供 4 条 POST 路由（`overview` / `file` / `search` / `dream`），继承 DSH 的浏览器鉴权。
**客户端半边在 Host 启动时扫描并缓存**：首次安装时若包里还没有 `client.js`，Host 会缓存「不是客户端包」的判定直到重启，之后刷新页面也不会出现面板。新增/修改客户端半边后：先重启 `dsh web`，再刷新页面。

## 向量检索（embedding）

`search.embeddings` 走 OpenAI 兼容的 `POST {baseURL}/embeddings`。密钥**不写进配置**：插件按内部槽位名解析，
插件每次检索时通过 Host 的 `credentials` 服务解析（provider 管理的凭据库优先，进程环境变量兜底），因此换 key 无需重启。

本次接入的 uniapi 配置（`text-embedding-v4`，1024 维）：

```yaml
- id: long-term-memory
  name: 'dsh-memtree'
  config:
    language: zh
    search:
      embeddings:
        enabled: true
        baseURL: https://uniapi.ruijie.com.cn/v1
        apiKeyEnv: UNIAPI_API_KEY
        model: text-embedding-v4
        timeoutMs: 20000
```

任何 embedding 失败（网络、鉴权、维度不符）都会记日志并退化为 BM25 + Wikilink 展开，不会让检索报错。
向量按 `sha256(文件路径 + mtime)` 缓存在 `mem_metadata/embeddings.json`，只有变化的文件会重新计算。

## 安装

```bash
dsh plugin --profile web add dsh-memtree
# 或本地开发：npm pack 后把 tgz 绝对路径交给 plugin_manager 装真实包（不要用 link: / 软链）
```

安装后用一个新会话验证：`memory_status` 应报告根目录与文件数量；让 Agent 记住一条偏好，
再开新会话问相关问题，`memory_search` 应能找回；`/memory dream` 应把每日笔记整理进 `digest/`。
面板在 **设置 → 长期记忆**；若刚新增了客户端半边，先刷新页面。

## 与 QwenPaw 的差异

- **没有 Python/ReMe 运行时**：BM25、RRF、分块、Wikilink 图谱、Auto Dream 编排全部用 JavaScript 重写，无外部依赖。
- **来源用会话而不是 JSONL**：QwenPaw 把对话另存为 `mem_session/*.jsonl`；DSH 的会话日志本身就是可追溯的事实来源，因此主题笔记记录 `session_id` 与 `source_session` 指向会话，而不是复制一份 JSONL。
- **Embedding 可选且外部化**：DSH 未内置向量模型，插件通过 OpenAI 兼容的 `/embeddings` 端点接入；未配置时 BM25 + Wikilink 展开照常工作（与 QwenPaw 行为一致）。
- **Auto Resource（Daily Paper / Auto Fin）未移植**：它们依赖 QwenPaw 的外部资料管线，不属于长期记忆内核。

## 保真度与已知偏差

移植依据是 QwenPaw 源码与其 ReMe 依赖的逐行提取。一致的机制包括：
合并写入同一 session 的当天主题笔记、`notes:auto` 区块的手术式重建、`personal/procedure/wiki` 分类与
CREATE/CORROBORATE/REFINE/CORRECT 四动作、Auto Link Wikilink + `## Sources`、BM25 `k1=1.5 / b=0.75`、
RRF `k=60`、1-hop outlink/inlink 展开、`路径:行号` 片段与渐进式展开、`MEMORY.md` 不进入索引也不被 dream 改写。

有意偏差（均为 DSH 环境适配或安全取舍）：

| 偏差 | 原因 |
| --- | --- |
| 分块上限 1200 字符（ReMe 默认 10000 字节） | 片段更小，适合渐进式披露与上下文预算 |
| RRF 等权（ReMe `vector_weight=0.7`） | 向量默认关闭；仅 BM25 时排序完全一致 |
| Auto Dream 允许 `SKIP` | ReMe 要求每条笔记必须产出一个动作；这里保留 skip 作为安全阀，避免无实质内容时强行造节点 |
| `## Sources` 由代码补一条裸 Wikilink | 提示词要求模型写成完整上下文句子；代码兜底保证证据链不断 |
| 无 23:00 夜间 cron | DSH 用可配置 `autoDream.intervalMinutes` + 工具/命令手动触发替代 |
| 无 rerank 与搜索答案合成 | QwenPaw 的 `/rerank` 是独立 HTTP 服务；本插件返回渲染片段，由主 Agent 自己综合 |
| 无 auto-recall 自动召回注入 | 因此也无需"抽取前剥离自动召回内容"；如需自动召回应作为独立插件 |
| 来源指向 DSH 会话而非 `mem_session/*.jsonl` | DSH 会话日志本身是可追溯的事实来源，避免复制对话 |

## 限制

- 同一工作目录的多个会话共享一份记忆；跨工作目录不共享（与 QwenPaw 的 Agent 工作区语义一致）。
- 索引在每次检索前做增量刷新；大量文件首次建索引会有一次性的分块开销。
- `MEMORY.md` 注入按字节截断，超长内容请自行精简或关闭 `inject.memoryMd`。
- 没有定时总结：不主动写记忆就不会产生每日笔记，此时夜间的 dream 因为「没有变化的笔记」而直接跳过，不产生模型费用。

## 开发

```bash
npm run lint   # node --check：index.js、client.js、src/*.js
```

测试套件（分块 / frontmatter / BM25 / Wikilink 图 / store 原子写 / Auto Dream 四动作 / 插件装配）
在开发工作区里用 `node --test` 运行，**未随包发布**；需要时请按 `src/` 的模块边界补用例。

## 验证记录

- `plugin_manager install_bundle` 返回 `application: applied`，`dsh-memtree` 已写入 profile bundles。
- `Config.listConfigs` 显示 `include:long-term-memory` 的 `status: schema`（激活且配置 schema 可用）。
- `Tool.listTools` 显示 `memory_search` / `memory_dream` / `memory_status` 三个模型可见工具。
- 实时端到端：在真实会话中调用工具，于 `$DSH_HOME/long-term-memory/<模式>/` 下生成
  `MEMORY.md`、每日索引页与主题笔记；`memory_dream` 用真实模型产出 REFINE 动作，写入 `## Sources`
  并推进 `mem_metadata/dream-state.json` 水位。
- 检索样例（真实数据，路径已按当前全局根目录格式）：

```text
========= memory/2026-10-21/主题笔记.md:10-10 [score=0.0164 keyword=12.8584] ==========
# 主题笔记
本 session 的关键判断与成立条件…
  outlinks (1):
    → digest/wiki/概念节点.md  name="概念节点"
  inlinks (1):
    ← digest/wiki/概念节点.md  name="概念节点"
========= digest/wiki/概念节点.md:14-20 [score=0.0159 keyword=5.3073] ==========
# 概念节点
## 结论
…（省略）
```

- **向量检索（真实端点）**：`text-embedding-v4`（1024 维）通过 uniapi 调用成功；对「上游原料降价怎么影响电池龙头利润」
  这种与文档没有字面重叠的问题，语义分支把宁德时代节点排到第一，并输出 `vector=` 分数：

```text
========== digest/wiki/宁德时代.md:14-20 [score=0.0325 vector=0.6980 keyword=3.3028] ==========
```

- **面板 API**：`test/plugin.test.mjs` 覆盖 `overview` / `file` / `search` 三条路由（真实 store + search），
  并验证越界路径（`../../etc/passwd`）被拒绝；Host 侧共注册 6 条路由（含 `workspaces` / `setWorkspace`）。
- **宿主内实时验证**（子 Agent 在真实会话调用工具）：`memory_status` 报告 `索引片段：12 个；向量检索：text-embedding-v4`；
  中文语义查询与英文跨语言查询的**每一条**结果头都带 `vector=`（如 `0.6980`、`0.7175`）；
  英文问句的 `keyword=` 仅 1.82–1.91，却仍召回正确的中文记忆，说明语义分支确实在工作；无报错、无超时，响应亚秒级。
- **模式门控**：`scope.mode=selected` 时未勾选的 Agent 模式不注入记忆提示段、隐藏三个记忆工具、`/memory` 提示未启用（有测试覆盖）；记忆根为全局 `<DSH_HOME>/long-term-memory/<模式>/`，跨工作目录共享。
- **夜间整理模型（真实端点）**：dream 走 `qwen3.8-flash`（uniapi），8192 输出预算、240 秒超时，返回合法 JSON 决策。
- `node --test test/*.test.mjs` → **53 passed / 0 failed**。

## License

MIT © yejianping
