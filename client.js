/**
 * Long-term memory settings panel (browser half).
 *
 * Renders one page in the Settings panel under `settings.section`: an overview of
 * the memory files with a preview pane, a semantic search tab that calls the same
 * hybrid retrieval the agent uses, and a wikilink graph.
 *
 * Data comes exclusively from the Host routes under `api/long-term-memory/*`, so the
 * panel never reads the filesystem itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-long-term-memory',
  factory(require) {
    const React = require('react')
    // ReMe renders documents with the shared Markdown primitive; degrade to <pre> if the
    // host does not expose it (e.g. an older shell or a unit-test harness).
    const Primitives = (() => {
      try {
        return require('@deepseek-ai/dsh-client-ui-primitives')
      } catch {
        return null
      }
    })()
    const MarkdownText = Primitives?.MarkdownText ?? Primitives?.default?.MarkdownText ?? null
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    // Shown in the page header so a stale browser bundle is obvious at a glance.
    const PANEL_VERSION = '0.18.4'
    const ZH = (navigator.language || 'en').toLowerCase().startsWith('zh')
    const TEXT = {
      zh: {
        navTitle: '长期记忆',
        title: '长期记忆',
        subtitle: 'Memory as File：每个 Agent 模式在全局维护一份记忆，跨工作目录共享、可读可改可带走。',
        workspaceTitle: '记忆工作区',
        mode: '模式',
        journal: '日志',
        knowledge: '知识库',
        autoMemoryTab: '自动记忆',
        dreamTab: '记忆整理',
        componentsTab: '组件',
        documentMetadata: '文档元数据',
        documentContent: '文档内容',
        fileCount: '个文件',
        searchFiles: '搜索文件',
        noSearchResults: '没有匹配的文件',
        fileListLimited: '仅显示前 200 个',
        selectFile: '从左侧选择一个文件',
        openCore: '打开 MEMORY.md',
        captureTitle: '自动记忆',
        captureDescription: 'Agent 判断对话里有值得保留的信息时，当场写成笔记；没有定时任务，也没有额外的汇总模型调用。',
        captureStep1: '判断',
        captureStep2: '写记忆',
        captureStep3: '刷新索引',
        consolidationTitle: '记忆整理',
        consolidationDescription: '把变化的日志提炼进长期知识：每条日志只产生一个动作（新建 / 佐证 / 精修 / 纠正 / 跳过）。',
        dreamStep1: '扫描变化',
        dreamStep2: '提炼节点',
        dreamStep3: '推进水位',
        consolidationAction: '立即整理',
        componentFiles: '文件存储',
        componentKeyword: '关键词索引',
        componentVector: '向量检索',
        componentGraph: 'Wikilink 图谱',
        capabilityCore: '核心记忆',
        capabilityJournal: '日志与笔记',
        capabilityKnowledge: '长期知识',
        capabilityChunks: '索引片段',
        coreTitle: '核心长期记忆',
        coreSubtitle: 'MEMORY.md · 跨模式稳定约定',
        modesSection: 'Agent 模式',
        modesSectionHint: '每个模式在全局维护一份独立记忆树；这里切换是否对该模式启用长期记忆。',
        journalDescription: '按天记录：原始经过、判断与结论，作为可追溯的证据层。',
        knowledgeGraph: '知识图谱',
        knowledgeGraphHint: '点击节点打开该知识；连线来自笔记里的 Wikilink。',
        relations: '关联知识',
        outbound: '下联',
        inbound: '上联',
        noRelations: '暂无关联',
        consolidationFootnote: '只处理有变化的日志；没有变化时不调用模型。',
        groupIndex: '索引',
        groupCore: '核心',
        collapseGroup: '收起分组',
        expandGroup: '展开分组',
        knowledgeDescription: '整理后的长期知识：Wikilink 互连、带 Sources 证据链。',
        captureFootnote: '记忆写入由 Agent 决定，一次 memory_write 即一次工具调用。',
        healthOk: '就绪',
        healthBad: '需要处理',
        openFile: '打开',
        dreamModelHint: '',
        memoryFiles: '记忆文件',
        advanced: '高级信息',
        filterPlaceholder: '筛选文件…',
        pending: '有未保存的修改',
        savedState: '已与 profile 配置同步',
        reset: '还原',
        enable: '开启',
        disable: '关闭',
        index: '索引',
        modesMemory: '记忆',
        refresh: '刷新',
        dreaming: '整理中…',
        dream: '预演整理',
        overview: '概览',
        search: '搜索',
        graph: '图谱',
        core: '核心记忆',
        'daily-index': '每日索引',
        'daily-note': '主题笔记',
        digest: '长期知识',
        other: '其他',
        chunks: '索引片段',
        vectors: '向量',
        vectorsOff: '未启用',
        vectorsReady: '已就绪',
        lastDream: '上次整理',
        never: '从未',
        empty: '还没有记忆文件。没有定时总结：Agent 判断对话里有值得保留的信息时，会用 memory_write 写在这里。',
        previewEmpty: '选择左侧文件查看内容。',
        loading: '加载中…',
        loadFailed: '加载失败',
        searchPlaceholder: '例如：锂价下跌对宁德时代利润的影响',
        searchButton: '检索',
        searching: '检索中…',
        searchEmpty: '输入问题后检索个人知识库（BM25 + 向量 + 图谱展开）。',
        noResults: '没有找到相关记忆。',
        score: '融合',
        keyword: '关键词',
        vector: '语义',
        outlinks: '出链',
        inlinks: '入链',
        files: '文件',
        graphEmpty: '记忆之间还没有 Wikilink 连接。',
        dreamDone: '整理完成',
        workspaces: '模式',
        workspacesHint: '每个 Agent 模式（标准 / PTC / 极简 / 创造…）在全局目录下单独维护一份记忆，跨工作目录共享；这里选择对哪些模式开启长期记忆。',
        enabled: '已开启',
        disabled: '已关闭',
        noMemory: '尚无记忆',
        hasMemory: '已有记忆',
        backgroundModel: '后台模型',
        modeSelectHint: '查看哪个模式的记忆',
        settings: '设置',
        settingsHint: '这些值保存在插件自己的配置里，覆盖 profile 中的默认值；密钥只保存名字，真实值仍在 Host 凭据库。',
        settingsEmbeddings: '语义搜索（Embedding）',
        settingsEmbeddingsHint: '配置后 memory_search 在 BM25 之外增加向量检索，并用 RRF 融合。留空则仅关键词检索。',
        settingsDream: '记忆整理模型（Auto Dream）',
        settingsDreamHint: '把每日笔记整合进长期知识时使用；留空则用 Agent 当前默认模型。',
        settingsRhythm: '记忆节奏',
        settingsRhythmHint: 'Auto Dream 是否按每日时刻或固定间隔自动整理。对话汇总不再有定时任务，由 Agent 自行判断何时写记忆。',
        fieldDreamEnabled: '启用 Auto Dream',
        fieldAutoRun: '按计划自动整理',
        fieldDailyAt: '每日整理时间（HH:MM）',
        fieldDailyAtHint: '本地时间，24 小时制；留空表示不用每日时刻。',
        fieldInterval: '或固定间隔（分钟）',
        fieldIntervalHint: '0 = 关闭；与每日时间可同时设置，任一命中即执行。',
        fieldSecret: '密钥值（只写，不回显）',
        fieldSecretEmpty: '未设置；输入后保存即可写入凭据库',
        secretConfigured: '已配置：***（不可查看）',
        secretMissing: '未配置',
        fieldEnabled: '启用',
        fieldBaseURL: '接口地址（Base URL）',
        fieldModel: '模型',
        fieldMaxTokens: '最大输出 tokens',
        fieldTimeout: '超时（毫秒）',
        fieldTimeoutHint: '留空按预算自动放大：30 秒 + 每 token 5 毫秒',
        fieldEmptyMeansAgent: '留空 = 使用 Agent 默认模型',
        save: '保存',
        saving: '保存中…',
        saved: '已保存并生效',
        persistedAt: '保存于',
        close: '关闭',
      },
      en: {
        navTitle: 'Long-Term Memory',
        title: 'Long-Term Memory',
        subtitle: 'Memory as File: each Agent mode keeps one global memory shared across workspaces.',
        workspaceTitle: 'Memory workspace',
        mode: 'Mode',
        journal: 'Journal',
        knowledge: 'Knowledge base',
        autoMemoryTab: 'Auto Memory',
        dreamTab: 'Consolidation',
        componentsTab: 'Components',
        documentMetadata: 'Document metadata',
        documentContent: 'Document',
        fileCount: 'files',
        searchFiles: 'Search files',
        noSearchResults: 'No matching files',
        fileListLimited: 'Showing the first 200',
        selectFile: 'Pick a file on the left',
        openCore: 'Open MEMORY.md',
        captureTitle: 'Auto memory',
        captureDescription: 'When the agent judges that this conversation produced something worth keeping, it writes the note itself right away. No schedule, no extra summarizer model.',
        captureStep1: 'Judge',
        captureStep2: 'Write note',
        captureStep3: 'Reindex',
        consolidationTitle: 'Consolidation',
        consolidationDescription: 'Distils changed daily notes into long-term knowledge: each note yields one action (create / corroborate / refine / correct / skip).',
        dreamStep1: 'Scan changes',
        dreamStep2: 'Distil node',
        dreamStep3: 'Advance watermark',
        consolidationAction: 'Consolidate now',
        componentFiles: 'File store',
        componentKeyword: 'Keyword index',
        componentVector: 'Vector search',
        componentGraph: 'Wikilink graph',
        capabilityCore: 'Core memory',
        capabilityJournal: 'Journal and notes',
        capabilityKnowledge: 'Long-term knowledge',
        capabilityChunks: 'Indexed chunks',
        coreTitle: 'Core long-term memory',
        coreSubtitle: 'MEMORY.md · stable cross-mode agreements',
        modesSection: 'Agent modes',
        modesSectionHint: 'Each mode keeps its own global memory tree; toggle whether long-term memory is enabled for it.',
        journalDescription: 'Day-by-day record: what happened, what was decided, kept as the evidence layer.',
        knowledgeGraph: 'Knowledge graph',
        knowledgeGraphHint: 'Click a node to open it; edges are the wikilinks between notes.',
        relations: 'Linked knowledge',
        outbound: 'Outbound',
        inbound: 'Inbound',
        noRelations: 'No links yet',
        consolidationFootnote: 'Only changed notes are processed; no change means no model call.',
        groupIndex: 'Index',
        groupCore: 'Core',
        collapseGroup: 'Collapse group',
        expandGroup: 'Expand group',
        knowledgeDescription: 'Consolidated knowledge: wikilinked nodes with a Sources trail.',
        captureFootnote: 'The agent decides what to write; one memory_write call is one tool call.',
        healthOk: 'Ready',
        healthBad: 'Needs attention',
        openFile: 'Open',
        dreamModelHint: '',
        memoryFiles: 'Memory files',
        advanced: 'Advanced',
        filterPlaceholder: 'Filter files…',
        pending: 'Unsaved changes',
        savedState: 'Synced with the profile config',
        reset: 'Reset',
        enable: 'Enable',
        disable: 'Disable',
        index: 'Index',
        modesMemory: 'Memory',
        refresh: 'Refresh',
        dreaming: 'Consolidating…',
        dream: 'Dry-run dream',
        overview: 'Overview',
        search: 'Search',
        graph: 'Graph',
        core: 'Core memory',
        'daily-index': 'Daily index',
        'daily-note': 'Topic notes',
        digest: 'Long-term knowledge',
        other: 'Other',
        chunks: 'chunks',
        vectors: 'Vectors',
        vectorsOff: 'off',
        vectorsReady: 'ready',
        lastDream: 'Last dream',
        never: 'never',
        empty: 'No memory files yet. There is no scheduled summary: the Agent writes here with memory_write when it judges something worth keeping.',
        previewEmpty: 'Select a file to preview it.',
        loading: 'Loading…',
        loadFailed: 'Failed to load',
        searchPlaceholder: 'e.g. how does a lithium price drop affect CATL margins?',
        searchButton: 'Search',
        searching: 'Searching…',
        searchEmpty: 'Ask a question to search the personal knowledge base (BM25 + vectors + link expansion).',
        noResults: 'No matching memories.',
        score: 'fused',
        keyword: 'keyword',
        vector: 'vector',
        outlinks: 'out',
        inlinks: 'in',
        files: 'files',
        graphEmpty: 'No wikilinks between memories yet.',
        dreamDone: 'Dream finished',
        workspaces: 'Modes',
        workspacesHint: 'Each Agent mode (Standard / PTC / Minimal / Create…) keeps one global memory shared across workspaces. Choose which modes enable it.',
        enabled: 'On',
        disabled: 'Off',
        noMemory: 'no memory yet',
        hasMemory: 'has memory',
        backgroundModel: 'background model',
        modeSelectHint: 'Which mode to inspect',
        settings: 'Settings',
        settingsHint: 'These values override the profile defaults and live in the plugin store. Secrets are never stored — only the credential name.',
        settingsEmbeddings: 'Semantic search (embeddings)',
        settingsEmbeddingsHint: 'Adds a vector branch to memory_search, fused with BM25 by RRF. Leave empty for keyword-only search.',
        settingsDream: 'Auto Dream model',
        settingsDreamHint: 'Used when daily notes are consolidated into long-term knowledge. Empty uses the Agent default model.',
        settingsRhythm: 'Cadence',
        settingsRhythmHint: 'Whether Auto Dream runs on a daily clock or a fixed interval. Conversation summaries have no schedule any more — the Agent decides when to write memory.',
        fieldDreamEnabled: 'Enable Auto Dream',
        fieldAutoRun: 'Run on schedule',
        fieldDailyAt: 'Daily time (HH:MM)',
        fieldDailyAtHint: 'Local 24-hour clock; empty disables the daily trigger.',
        fieldInterval: 'Or fixed interval (minutes)',
        fieldIntervalHint: '0 = off. Both can be set; either trigger runs the dream.',
        fieldSecret: 'Secret value (write-only)',
        fieldSecretEmpty: 'Not set; type a value and save to store it',
        secretConfigured: 'Configured: *** (not viewable)',
        secretMissing: 'Not configured',
        fieldEnabled: 'Enabled',
        fieldBaseURL: 'Base URL',
        fieldModel: 'Model',
        fieldMaxTokens: 'Max output tokens',
        fieldTimeout: 'Timeout (ms)',
        fieldTimeoutHint: 'Empty = scaled from the budget: 30 s + 5 ms per token',
        fieldEmptyMeansAgent: 'Empty = Agent default model',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved and applied',
        persistedAt: 'Saved at',
        close: 'Close',
      },
    }[ZH ? 'zh' : 'en']

    const GROUP_ORDER = ['core', 'daily-index', 'daily-note', 'digest', 'other']
    const GROUP_COLOR = {
      core: '#21a366',
      'daily-index': 'var(--dsw-alias-state-warn-primary)',
      'daily-note': 'var(--dsw-alias-state-success-primary)',
      digest: '#7656c9',
      other: 'var(--dsw-alias-state-idle-primary)',
    }


    /* ReMe-inspired theme for the long-term memory panel. */
    const LTM_STYLE_ID = 'ltm-reme-theme'
    const LTM_CSS = [
      '.ltm-page{width:100%;color:var(--dsw-alias-label-primary)}',
      '.ltm-page-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}',
      '.ltm-page-header h2{margin:0;font-size:22px;line-height:1.35}',
      '.ltm-page-header p{max-width:620px;margin:5px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.55}',
      '.ltm-header-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding-top:2px}',
      '.ltm-button{appearance:none;display:inline-flex;align-items:center;justify-content:center;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);padding:5px 11px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;text-decoration:none;white-space:nowrap;cursor:pointer}',
      '.ltm-button:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary)}',
      '.ltm-button.primary{border-color:#168653;background:#21a366;color:#fff}',
      '.ltm-button.primary:hover:not(:disabled){color:#fff;background:#1c9459}',
      '.ltm-button:disabled{opacity:.45;cursor:default}',
      '.ltm-button:focus-visible{outline:2px solid #21a366;outline-offset:1px}',
      '.ltm-select{appearance:none;box-sizing:border-box;min-height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);padding:5px 26px 5px 10px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;background-image:linear-gradient(45deg,transparent 50%,var(--dsw-alias-label-secondary) 50%),linear-gradient(135deg,var(--dsw-alias-label-secondary) 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}',
      '.ltm-select:focus-visible{outline:none;border-color:#21a366}',
      '.ltm-input{box-sizing:border-box;width:100%;min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);padding:6px 12px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}',
      '.ltm-input:focus-visible{outline:none;border-color:#21a366}',
      '.ltm-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.ltm-version{display:inline-block;margin-left:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 7px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:500;line-height:16px;vertical-align:middle}',
      '.ltm-tabs{display:flex;gap:4px;overflow-x:auto;border-bottom:1px solid var(--dsw-alias-border-l2);scrollbar-width:none}',
      '.ltm-tabs::-webkit-scrollbar{display:none}',
      '.ltm-tabs button{position:relative;appearance:none;flex:none;border:0;background:none;padding:10px 13px;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;cursor:pointer}',
      '.ltm-tabs button:hover{color:var(--dsw-alias-label-primary)}',
      '.ltm-tabs button.active{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.ltm-tabs button.active:after{content:"";position:absolute;right:9px;bottom:-1px;left:9px;height:2px;border-radius:2px;background:#21a366}',
      '.ltm-tabs button:focus-visible{outline:2px solid #21a366;outline-offset:-2px}',
      '.ltm-tab-panel{padding:18px 0 8px}',
      '.ltm-stack{display:flex;flex-direction:column;gap:14px}',
      '.ltm-overview-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px 18px;overflow:hidden;border:1px solid color-mix(in srgb,#21a366 34%,var(--dsw-alias-border-l2));border-radius:16px;background:linear-gradient(128deg,color-mix(in srgb,#21a366 14%,var(--dsw-alias-bg-layer-3)),var(--dsw-alias-bg-layer-3) 62%);padding:20px 22px}',
      '.ltm-overview-hero:after{position:absolute;right:-110px;bottom:-170px;width:230px;height:230px;border-radius:50%;background:color-mix(in srgb,#21a366 12%,transparent);content:"";pointer-events:none}',
      '.ltm-overview-brand{display:flex;min-width:0;align-items:center;gap:14px}',
      '.ltm-brand-mark{display:grid;width:46px;height:46px;flex:none;place-items:center;border-radius:14px;background:linear-gradient(135deg,#25b872,#168653);color:#fff;font-size:14px;font-weight:750;letter-spacing:-.4px;box-shadow:0 8px 22px color-mix(in srgb,#21a366 30%,transparent)}',
      '.ltm-eyebrow{display:block;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:650;letter-spacing:.09em;line-height:1.4;text-transform:uppercase}',
      '.ltm-overview-brand h3{margin:2px 0 0;font-size:17px;line-height:1.4}',
      '.ltm-overview-brand p{max-width:320px;margin:3px 0 0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-overview-health{position:relative;z-index:1;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}',
      '.ltm-badge{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 9px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.ltm-badge i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.ltm-badge.ok{border-color:color-mix(in srgb,#21a366 25%,transparent);color:#168653}',
      '.ltm-badge.ok i{background:#21a366;box-shadow:0 0 0 3px color-mix(in srgb,#21a366 12%,transparent)}',
      '.ltm-badge.bad{border-color:color-mix(in srgb,var(--dsw-alias-label-error) 24%,transparent);color:var(--dsw-alias-label-error)}',
      '.ltm-badge.bad i{background:var(--dsw-alias-label-error)}',
      '.ltm-badge.brand{border-color:color-mix(in srgb,#21a366 45%,transparent);color:color-mix(in srgb,#21a366 55%,var(--dsw-alias-label-primary))}',
      '.ltm-badge.brand i{background:#21a366}',
      '.ltm-overview-meta{grid-column:1 / -1;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:0;border-top:1px solid color-mix(in srgb,#21a366 26%,var(--dsw-alias-border-l2));padding-top:14px}',
      '.ltm-overview-meta div{min-width:0}',
      '.ltm-overview-meta dt{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}',
      '.ltm-overview-meta dd{margin:2px 0 0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px}',
      '.ltm-metric{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:12px 14px}',
      '.ltm-metric span{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}',
      '.ltm-metric strong{display:block;margin:3px 0 0;font-size:20px;font-weight:650;line-height:1.2;font-variant-numeric:tabular-nums}',
      '.ltm-details{border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0}',
      '.ltm-details summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:1.5}',
      '.ltm-details-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;padding-top:10px}',
      '.ltm-details-body dt{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}',
      '.ltm-details-body dd{margin:2px 0 0;overflow:hidden;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-section-heading{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:8px}',
      '.ltm-section-heading h3{margin:0;font-size:14px;line-height:1.5}',
      '.ltm-section-heading p{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.ltm-file-browser{display:grid;grid-template-columns:minmax(200px,280px) minmax(0,1fr);gap:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:10px}',
      '.ltm-file-browser>aside{display:flex;flex-direction:column;gap:2px;max-height:610px;overflow:auto;padding:2px;scrollbar-width:thin}',
      '.ltm-file-search{position:sticky;top:0;z-index:1;padding-bottom:6px;background:var(--dsw-alias-bg-layer-2)}',
      '.ltm-document{display:flex;min-width:0;flex-direction:column;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.ltm-document header{display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:9px 12px}',
      '.ltm-document header code{flex:1;min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-document pre{flex:1;margin:0;overflow:auto;padding:12px 14px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.62;white-space:pre-wrap;word-break:break-word}',
      '.ltm-component-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}',
      '.ltm-component{display:flex;min-width:0;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:13px 14px}',
      '.ltm-component header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}',
      '.ltm-component header>div{display:flex;min-width:0;flex-direction:column;gap:2px}',
      '.ltm-component header strong{font-size:13px;font-weight:600;line-height:1.5}',
      '.ltm-component header small{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}',
      '.ltm-component dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-l2);padding-top:11px}',
      '.ltm-component dt{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}',
      '.ltm-component dd{margin:3px 0 0;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:1.4;overflow-wrap:anywhere}',
      '.ltm-component footer{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:11px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}',
      '.ltm-notice{display:flex;align-items:flex-start;gap:8px;border-radius:9px;padding:9px 12px;font-size:12px;line-height:1.5;white-space:pre-wrap}',
      '.ltm-notice.error{background:color-mix(in srgb,var(--dsw-alias-label-error) 8%,transparent);color:var(--dsw-alias-label-error)}',
      '.ltm-notice.success{background:color-mix(in srgb,#21a366 9%,transparent);color:#168653}',
      '.ltm-empty{display:flex;min-height:160px;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}',
      '.ltm-result-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3);padding:12px 14px}',
      '.ltm-result-card header{display:flex;flex-wrap:wrap;align-items:center;gap:8px}',
      '.ltm-result-card header code{flex:1;min-width:0;overflow:hidden;color:color-mix(in srgb,#21a366 55%,var(--dsw-alias-label-primary));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.5;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}',
      '.ltm-result-card pre{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.62;white-space:pre-wrap;word-break:break-word}',
      '.ltm-search-bar{display:flex;align-items:center;gap:8px}',
      '.ltm-settings-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding:12px 0}',
      '.ltm-settings-status{display:flex;flex:1 0 100%;min-width:0;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}',
      '.ltm-settings-status code{min-width:0;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-dot{width:8px;height:8px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.ltm-dot.ok{background:#21a366}',
      '.ltm-dot.bad{background:var(--dsw-alias-label-error)}',
      '.ltm-pending{flex:none;border-radius:999px;background:var(--dsw-alias-bg-module-platform);padding:1px 8px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:17px;white-space:nowrap}',
      '.ltm-settings-section{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:14px 16px}',
      '.ltm-settings-section h4{margin:0;font-size:13px;font-weight:600;line-height:1.5}',
      '.ltm-settings-section>p{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55}',
      '.ltm-settings-fields{display:flex;flex-direction:column}',
      '.ltm-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}',
      '.ltm-field+.ltm-field,.ltm-check+.ltm-field,.ltm-field+.ltm-check,.ltm-check+.ltm-check{border-top:1px solid var(--dsw-alias-border-l2)}',
      '.ltm-field label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.ltm-field small{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}',
      '.ltm-check{display:flex;align-items:center;gap:9px;padding:12px 0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;cursor:pointer}',
      '.ltm-check input{margin:0;accent-color:#21a366}',
      '.ltm-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;border-top:1px solid var(--dsw-alias-border-l2);padding:12px 0 4px}',
      '.ltm-actions .ltm-saved{flex:1;min-width:0;color:#168653;font-size:12px;line-height:1.5}',
      '.ltm-reset{appearance:none;border:0;background:none;padding:0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1.5;cursor:pointer}',
      '.ltm-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}',
      '.ltm-reset:disabled{opacity:.4;cursor:default}',
      '.ltm-graph{width:100%;height:440px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-3)}',
      '.ltm-library-hero{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:13px;border:1px solid color-mix(in srgb,#21a366 32%,var(--dsw-alias-border-l2));border-bottom:0;border-radius:14px 14px 0 0;background:linear-gradient(135deg,color-mix(in srgb,#21a366 13%,var(--dsw-alias-bg-layer-3)),var(--dsw-alias-bg-layer-3) 70%);padding:15px 17px}',
      '.ltm-file-group-head.knowledge{border-color:color-mix(in srgb,#7656c9 34%,var(--dsw-alias-border-l2));border-left-color:#7656c9;background:color-mix(in srgb,#7656c9 14%,var(--dsw-alias-bg-layer-2))}',
      '.ltm-file-group-head.knowledge:hover{background:color-mix(in srgb,#7656c9 21%,var(--dsw-alias-bg-layer-2));border-color:color-mix(in srgb,#7656c9 48%,var(--dsw-alias-border-l2))}',
      '.ltm-file-group-head.knowledge .ltm-chevron{color:color-mix(in srgb,#7656c9 72%,var(--dsw-alias-label-primary))}',
      '.ltm-library-hero.knowledge{background:linear-gradient(135deg,color-mix(in srgb,#7656c9 15%,var(--dsw-alias-bg-layer-3)),var(--dsw-alias-bg-layer-3) 70%);border-color:color-mix(in srgb,#7656c9 38%,var(--dsw-alias-border-l2))}',
      '.ltm-library-hero h3{margin:0;font-size:15px;line-height:1.4}',
      '.ltm-library-hero p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5}',
      '.ltm-library-mark{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:linear-gradient(135deg,#25b872,#168653);color:#fff;font-size:13px;font-weight:700;box-shadow:0 6px 18px color-mix(in srgb,#21a366 26%,transparent)}',
      '.ltm-library-mark.knowledge{background:linear-gradient(135deg,#8b6ee0,#5b3fa8);box-shadow:0 6px 18px color-mix(in srgb,#7656c9 30%,transparent)}',
      '.ltm-file-limit{padding:9px;color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:center}',
      '.ltm-file-search{display:flex;align-items:center;gap:6px}',
      '.ltm-file-search>span{flex:none;color:var(--dsw-alias-label-tertiary);font-size:9px}',
      '.ltm-document-preview>header{position:sticky;z-index:1;top:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent);padding:14px 18px;backdrop-filter:blur(10px)}',
      '.ltm-document-preview>header span{color:var(--dsw-alias-label-tertiary);font-size:9px}',
      '.ltm-document-preview>header h3{margin:2px 0;font-size:15px;line-height:1.4}',
      '.ltm-document-preview>header code{display:block;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:9px;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-frontmatter,.ltm-document-content{padding:16px 18px}',
      '.ltm-frontmatter{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-module-platform) 45%,transparent)}',
      '.ltm-frontmatter h4,.ltm-document-content>h4{margin:0 0 11px;color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:650;letter-spacing:.06em;text-transform:uppercase}',
      '.ltm-frontmatter dl{display:grid;gap:8px;margin:0}',
      '.ltm-frontmatter dl>div{display:grid;grid-template-columns:minmax(76px,max-content) minmax(0,1fr);gap:14px}',
      '.ltm-frontmatter dt{color:var(--dsw-alias-label-tertiary);font:600 10px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.ltm-frontmatter dd{margin:0;overflow-wrap:anywhere;font-size:11px;line-height:1.5;white-space:pre-wrap}',
      '.ltm-document-content{padding-bottom:38px}',
      '.ltm-markdown{font-size:13px;line-height:1.7}',
      '.ltm-feature-hero{position:relative;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:18px;overflow:hidden;border:1px solid color-mix(in srgb,#21a366 32%,var(--dsw-alias-border-l2));border-radius:16px;background:linear-gradient(135deg,color-mix(in srgb,#21a366 13%,var(--dsw-alias-bg-layer-3)),var(--dsw-alias-bg-layer-3) 70%);padding:17px 19px}',
      '.ltm-feature-hero:after{position:absolute;right:-45px;top:-70px;width:190px;height:190px;border-radius:50%;background:color-mix(in srgb,#21a366 10%,transparent);content:"";pointer-events:none}',
      '.ltm-feature-hero.consolidation{border-color:color-mix(in srgb,#7656c9 38%,var(--dsw-alias-border-l2));background:linear-gradient(135deg,color-mix(in srgb,#7656c9 14%,var(--dsw-alias-bg-layer-3)),var(--dsw-alias-bg-layer-3) 70%)}',
      '.ltm-feature-hero.consolidation:after{background:color-mix(in srgb,#7656c9 6%,transparent)}',
      '.ltm-feature-hero h3{margin:2px 0 0;font-size:15px;line-height:1.4}',
      '.ltm-feature-hero p{max-width:520px;margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.55}',
      '.ltm-flow-card{border:1px solid var(--dsw-alias-border-l2);border-radius:13px;background:var(--dsw-alias-bg-layer-3);padding:15px 17px}',
      '.ltm-flow-card>h3{margin:0 0 12px;font-size:12px;line-height:1.5}',
      '.ltm-flow-card>p{margin:10px 0 0;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.5;text-align:center}',
      '.ltm-flow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}',
      '.ltm-flow-step{position:relative;display:flex;min-width:0;align-items:center;gap:8px;border-radius:9px;background:var(--dsw-alias-bg-module-platform);padding:10px 11px}',
      '.ltm-flow-step:not(:last-child):after{position:absolute;right:-17px;width:12px;border-top:1px solid var(--dsw-alias-label-dimmed);content:""}',
      '.ltm-flow-step>span{display:grid;width:24px;height:24px;flex:none;place-items:center;border-radius:7px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:650}',
      '.ltm-flow-step>strong{min-width:0;font-size:10px;line-height:1.35}',
      '.ltm-flow-card.consolidation .ltm-flow-step>span{color:#7656c9}',
      '.ltm-capability-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}',
      '.ltm-capability-grid article{display:flex;min-width:0;flex-direction:column;align-items:flex-start;gap:7px;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;background:var(--dsw-alias-bg-layer-3);padding:13px 15px}',
      '.ltm-capability-grid article>div{display:flex;min-width:0;flex-direction:column;gap:3px}',
      '.ltm-capability-grid span,.ltm-capability-grid small{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.45}',
      '.ltm-capability-grid strong{font-size:14px;line-height:1.3}',
      '.ltm-graph-card{border:1px solid var(--dsw-alias-border-l2);border-radius:13px;background:var(--dsw-alias-bg-layer-3);padding:13px 15px 6px}',
      '.ltm-graph-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.ltm-graph-head h3{margin:0;font-size:13px;line-height:1.5}',
      '.ltm-graph-head p{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
      '.ltm-relations{border-bottom:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,#7656c9 4%,transparent);padding:14px 18px}',
      '.ltm-relations h4{margin:0 0 10px;color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:650;letter-spacing:.06em;text-transform:uppercase}',
      '.ltm-relation-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.ltm-relation-group{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}',
      '.ltm-relation-group>span{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px}',
      '.ltm-relation{appearance:none;border:1px solid color-mix(in srgb,#7656c9 28%,transparent);border-radius:999px;background:color-mix(in srgb,#7656c9 8%,transparent);padding:2px 9px;color:#7656c9;font:inherit;font-size:11px;line-height:17px;cursor:pointer;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-relation:hover{border-color:color-mix(in srgb,#7656c9 55%,transparent);background:color-mix(in srgb,#7656c9 14%,transparent)}',
      '.ltm-relation:focus-visible{outline:2px solid #7656c9;outline-offset:1px}',
      '.ltm-relation-empty{color:var(--dsw-alias-label-tertiary);font-size:11px;font-style:normal}',
      /* Group card: its own surface + icon, separated from the file entries below. */
      '.ltm-file-groups{display:flex;flex-direction:column;gap:20px;padding:2px 0}',
      '.ltm-file-group{display:flex;flex-direction:column;gap:7px}',
      '.ltm-file-group-head{appearance:none;display:flex;align-items:center;gap:10px;width:100%;border:1px solid color-mix(in srgb,#21a366 30%,var(--dsw-alias-border-l2));border-radius:12px;background:linear-gradient(180deg,color-mix(in srgb,#21a366 16%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,#21a366 8%,var(--dsw-alias-bg-layer-2)));padding:10px 12px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.ltm-file-group-head:hover{border-color:color-mix(in srgb,#21a366 48%,var(--dsw-alias-border-l2));background:linear-gradient(180deg,color-mix(in srgb,#21a366 22%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,#21a366 12%,var(--dsw-alias-bg-layer-2)))}',
      '.ltm-file-group-head:focus-visible{outline:2px solid #21a366;outline-offset:1px}',
      '.ltm-group-icon{display:grid;width:28px;height:28px;flex:none;place-items:center;border-radius:9px;background:color-mix(in srgb,#21a366 24%,transparent);color:#21a366}',
      '.ltm-group-icon svg{width:15px;height:15px;display:block}',
      '.ltm-group-title{display:flex;min-width:0;flex:1;flex-direction:column;gap:1px}',
      '.ltm-group-title strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:650;line-height:1.4}',
      '.ltm-group-title small{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1.4}',
      '.ltm-group-count{flex:none;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent);padding:1px 8px;color:color-mix(in srgb,#21a366 62%,var(--dsw-alias-label-primary));font-size:10.5px;font-weight:650;line-height:16px}',
      '.ltm-chevron{flex:none;width:12px;color:color-mix(in srgb,#21a366 65%,var(--dsw-alias-label-primary));font-size:10px;font-style:normal;line-height:1;text-align:center;transition:transform .15s}',
      '.ltm-file-group-head.knowledge{border-color:color-mix(in srgb,#7656c9 32%,var(--dsw-alias-border-l2));background:linear-gradient(180deg,color-mix(in srgb,#7656c9 17%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,#7656c9 8%,var(--dsw-alias-bg-layer-2)))}',
      '.ltm-file-group-head.knowledge:hover{border-color:color-mix(in srgb,#7656c9 50%,var(--dsw-alias-border-l2));background:linear-gradient(180deg,color-mix(in srgb,#7656c9 23%,var(--dsw-alias-bg-layer-2)),color-mix(in srgb,#7656c9 12%,var(--dsw-alias-bg-layer-2)))}',
      '.ltm-file-group-head.knowledge .ltm-group-icon{background:color-mix(in srgb,#7656c9 26%,transparent);color:#7656c9}',
      '.ltm-file-group-head.knowledge .ltm-group-count{color:color-mix(in srgb,#7656c9 68%,var(--dsw-alias-label-primary))}',
      '.ltm-file-group-head.knowledge .ltm-chevron{color:color-mix(in srgb,#7656c9 70%,var(--dsw-alias-label-primary))}',
      /* File entries: raised surface cards under the group card. */
      '.ltm-group-files{display:flex;flex-direction:column;gap:6px}',
      '.ltm-group-file{appearance:none;display:flex;align-items:center;gap:9px;width:100%;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 90%,transparent);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,var(--dsw-alias-label-primary));padding:8px 10px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}',
      '.ltm-group-file:hover{border-color:color-mix(in srgb,#21a366 34%,var(--dsw-alias-border-l2));background:color-mix(in srgb,#21a366 6%,var(--dsw-alias-bg-layer-3))}',
      '.ltm-group-file.active{border-color:color-mix(in srgb,#21a366 58%,var(--dsw-alias-border-l2));background:color-mix(in srgb,#21a366 13%,var(--dsw-alias-bg-layer-3));box-shadow:inset 2px 0 0 #21a366}',
      '.ltm-group-file:focus-visible{outline:2px solid #21a366;outline-offset:1px}',
      '.ltm-group-file>i{display:grid;width:22px;height:22px;flex:none;place-items:center;border-radius:7px;background:color-mix(in srgb,#21a366 14%,transparent);color:color-mix(in srgb,#21a366 62%,var(--dsw-alias-label-primary));font-size:9px;font-style:normal;font-weight:700}',
      '.ltm-group-file>i.knowledge{background:color-mix(in srgb,#7656c9 16%,transparent);color:color-mix(in srgb,#7656c9 70%,var(--dsw-alias-label-primary))}',
      '.ltm-group-file>span{min-width:0;flex:1}',
      '.ltm-group-file strong{display:block;overflow:hidden;font-size:12.5px;font-weight:500;line-height:1.45;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-group-file small{display:block;overflow:hidden;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:1.45;text-overflow:ellipsis;white-space:nowrap}',
      '.ltm-settings-summary{display:block;cursor:pointer;list-style:none}',
      '.ltm-settings-summary::-webkit-details-marker{display:none}',
      '.ltm-settings-summary>h4{position:relative;padding-right:18px}',
      '.ltm-settings-summary>h4:after{position:absolute;top:0;right:2px;color:var(--dsw-alias-label-tertiary);font-size:10px;content:"▾"}',
      '.ltm-settings-section:not([open]) .ltm-settings-summary>h4:after{content:"▸"}',
      '.ltm-settings-section+.ltm-settings-section{margin-top:2px}',
    ].join('\n')
    function ensureLtmTheme() {
      if (typeof document === 'undefined') return
      if (document.getElementById(LTM_STYLE_ID) !== null) return
      const sheet = document.createElement('style')
      sheet.id = LTM_STYLE_ID
      sheet.textContent = LTM_CSS
      document.head.appendChild(sheet)
    }
    ensureLtmTheme()

    /** Inline styles kept only where a value must be computed at render time. */
    const S = {
      svg: { width: '100%', height: '440px', display: 'block' },
      row: { display: 'flex', alignItems: 'center', gap: '8px' },
      grow: { flex: 1, minWidth: 0 },
      mono: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace', fontSize: '11px' },
    }

    /** Call one Host route. */
    async function api(name, body) {
      const response = await fetch(`api/long-term-memory/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const payload = await response.json().catch(() => null)
      if (!payload || payload.ok !== true) {
        throw new Error(payload?.error?.message || `HTTP ${response.status}`)
      }
      return payload.value
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return TEXT.never
      return new Date(ms).toLocaleString()
    }


    /** Split YAML frontmatter from the markdown body (ReMe renders them as two sections). */
    function parseDocument(text) {
      const src = String(text ?? '')
      if (!src.startsWith('---')) return { entries: [], body: src }
      const closing = src.indexOf('\n---', 3)
      if (closing === -1) return { entries: [], body: src }
      const head = src.slice(3, closing)
      const body = src.slice(closing + 4).replace(/^\r?\n/, '')
      const entries = []
      let current = null
      for (const rawLine of head.split('\n')) {
        const line = rawLine.replace(/\s+$/, '')
        if (line.trim().length === 0) continue
        const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
        if (pair !== null) {
          current = { key: pair[1], values: pair[2].length > 0 ? [pair[2]] : [] }
          entries.push(current)
          continue
        }
        const item = /^\s*-\s*(.*)$/.exec(line)
        if (item !== null && current !== null) {
          current.values.push(item[1])
          continue
        }
        if (current !== null) current.values.push(line.trim())
      }
      return {
        entries: entries.map((entry) => ({
          key: entry.key,
          value: entry.values.map((value) => String(value).replace(/^['"]|['"]$/g, '')).join(', '),
        })),
        body,
      }
    }

    /** File name of a memory-relative path. */
    function fileNameOf(relPath) {
      const parts = String(relPath ?? '').split('/')
      return parts[parts.length - 1] || relPath || ''
    }

    /**
     * Keep one broken markdown tree from blanking the whole panel: React has no
     * implicit boundary around a slot, so a throw inside MarkdownText would unmount
     * the settings section entirely.
     */
    class MarkdownBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch() {
        /* the fallback below is the whole recovery */
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    /** Labels the primitive expects for inline code copy and footnotes. */
    function markdownLabels() {
      return {
        code: { copyLabel: ZH ? '复制' : 'Copy', copiedLabel: ZH ? '已复制' : 'Copied' },
        footnotes: ZH ? '脚注' : 'Footnotes',
      }
    }

    /** Render markdown through the host primitive, or a preformatted fallback. */
    function markdownBlock(text, key) {
      const body = String(text ?? '')
      const fallback = h('pre', { key, style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit' } }, body)
      if (MarkdownText === null) return fallback
      return h(MarkdownBoundary, { key, fallback }, h(MarkdownText, { text: body, labels: markdownLabels() }))
    }

    function Panel() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(true)
      const [tab, setTab] = useState('overview')
      const [selected, setSelected] = useState('')
      const [preview, setPreview] = useState('')
      const [query, setQuery] = useState('')
      const [searching, setSearching] = useState(false)
      const [searchResult, setSearchResult] = useState(null)
      const [notice, setNotice] = useState('')
      const [presetRows, setPresetRows] = useState([])
      const [preset, setPreset] = useState('')
      const [settingsData, setSettingsData] = useState(null)
      const [settingsFile, setSettingsFile] = useState('')
      const [saving, setSaving] = useState(false)
      const [savedNote, setSavedNote] = useState('')
      const [secretDraft, setSecretDraft] = useState({})
      const [workspaceBusy, setWorkspaceBusy] = useState('')
      const [dirty, setDirty] = useState(false)
      const [dreaming, setDreaming] = useState(false)
      const [fileFilter, setFileFilter] = useState('')
      const [collapsedGroups, setCollapsedGroups] = useState({})
      const mounted = useRef(true)

      useEffect(() => () => {
        mounted.current = false
      }, [])

      const loadWorkspaces = useCallback(async () => {
        try {
          const value = await api('presets')
          if (mounted.current) {
            setPresetRows(value.rows ?? [])
            setPreset((current) => {
              if (current.length > 0 && (value.rows ?? []).some((row) => row.id === current)) return current
              const preferred = value.rows?.find((row) => row.enabled && row.hasMemory)?.id
                ?? value.rows?.find((row) => row.hasMemory)?.id
                ?? value.current
                ?? value.rows?.[0]?.id
                ?? ''
              return preferred
            })
          }
        } catch {
          /* the overview still renders without the switch list */
        }
      }, [])

      const toggleWorkspace = useCallback(async (presetId, enabled) => {
        setWorkspaceBusy(presetId)
        try {
          await api('setPreset', { preset: presetId, enabled })
          await loadWorkspaces()
          const overview = await api('overview', { preset })
          if (mounted.current) setData(overview)
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (mounted.current) setWorkspaceBusy('')
        }
      }, [loadWorkspaces])

      const settingGroups = useMemo(() => {
        const embeddings = settingsData?.embeddings ?? {}
        const dream = settingsData?.dream ?? {}
        const rhythm = settingsData?.rhythm ?? {}
        const creds = settingsData?.credentials ?? {}
        const secretField = (group) => ({
          name: 'secret',
          label: TEXT.fieldSecret,
          type: 'secret',
          value: secretDraft[group] ?? '',
          configured: creds[group]?.configured === true,
          placeholder: creds[group]?.configured ? '***' : TEXT.fieldSecretEmpty,
        })
        return [
          {
            key: 'embeddings',
            title: TEXT.settingsEmbeddings,
            description: TEXT.settingsEmbeddingsHint,
            fields: [
              { name: 'enabled', label: TEXT.fieldEnabled, type: 'boolean', value: embeddings.enabled === true },
              { name: 'baseURL', label: TEXT.fieldBaseURL, value: embeddings.baseURL ?? '', placeholder: 'https://api.example.com/v1' },
              { name: 'model', label: TEXT.fieldModel, value: embeddings.model ?? '', placeholder: 'text-embedding-v4' },
              secretField('embeddings'),
            ],
          },
          {
            key: 'dream',
            title: TEXT.settingsDream,
            description: TEXT.settingsDreamHint,
            fields: [
              { name: 'baseURL', label: TEXT.fieldBaseURL, value: dream.baseURL ?? '', placeholder: TEXT.fieldEmptyMeansAgent },
              { name: 'model', label: TEXT.fieldModel, value: dream.model ?? '', placeholder: TEXT.fieldEmptyMeansAgent },
              { name: 'maxTokens', label: TEXT.fieldMaxTokens, value: dream.maxTokens ?? '' },
              { name: 'timeoutMs', label: TEXT.fieldTimeout, value: dream.timeoutMs ?? '', hint: TEXT.fieldTimeoutHint },
              secretField('dream'),
            ],
          },
          {
            key: 'rhythm',
            title: TEXT.settingsRhythm,
            description: TEXT.settingsRhythmHint,
            fields: [
              { name: 'dreamEnabled', label: TEXT.fieldDreamEnabled, type: 'boolean', value: rhythm.autoDream?.enabled !== false },
              { name: 'autoRun', label: TEXT.fieldAutoRun, type: 'boolean', value: rhythm.autoDream?.autoRun === true },
              { name: 'dailyAt', label: TEXT.fieldDailyAt, value: rhythm.autoDream?.dailyAt ?? '', placeholder: '23:00', hint: TEXT.fieldDailyAtHint },
              { name: 'intervalMinutes', label: TEXT.fieldInterval, value: rhythm.autoDream?.intervalMinutes ?? '', hint: TEXT.fieldIntervalHint },
            ],
          },
        ]
      }, [settingsData, secretDraft])

      const updateSetting = useCallback((group, name, value) => {
        setSavedNote('')
        setDirty(true)
        if (name === 'secret') {
          setSecretDraft((current) => ({ ...current, [group]: value }))
          return
        }
        if (group === 'rhythm') {
          setSettingsData((current) => {
            const rhythm = current?.rhythm ?? {}
            const autoDream = { ...(rhythm.autoDream ?? {}) }
            if (name === 'dreamEnabled') autoDream.enabled = value
            else if (name === 'autoRun') autoDream.autoRun = value
            else if (name === 'dailyAt') autoDream.dailyAt = value
            else if (name === 'intervalMinutes') autoDream.intervalMinutes = value
            return { ...(current ?? {}), rhythm: { autoDream } }
          })
          return
        }
        setSettingsData((current) => ({
          ...(current ?? {}),
          [group]: { ...((current ?? {})[group] ?? {}), [name]: value },
        }))
      }, [])

      const loadSettings = useCallback(async () => {
        try {
          const value = await api('settings')
          if (!mounted.current) return
          setSettingsData(value)
          setSettingsFile(value.overridesFile ?? '')
          setDirty(false)
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
        }
      }, [])

      const resetSettings = useCallback(() => {
        setSecretDraft({})
        setSavedNote('')
        loadSettings()
      }, [loadSettings])

      const saveSettings = useCallback(async () => {
        setSaving(true)
        setError('')
        try {
          for (const group of ['embeddings', 'memory', 'dream']) {
            const secret = (secretDraft[group] ?? '').trim()
            if (secret.length === 0) continue
            await api('setCredential', { group, value: secret })
          }
          const payload = {
            embeddings: settingsData?.embeddings ?? {},
            dream: settingsData?.dream ?? {},
            rhythm: {
              autoDream: {
                enabled: settingsData?.rhythm?.autoDream?.enabled !== false,
                autoRun: settingsData?.rhythm?.autoDream?.autoRun === true,
                dailyAt: settingsData?.rhythm?.autoDream?.dailyAt ?? '',
                intervalMinutes: settingsData?.rhythm?.autoDream?.intervalMinutes,
              },
            },
          }
          const value = await api('saveSettings', payload)
          if (!mounted.current) return
          setSettingsData(value)
          setSettingsFile(value.overridesFile ?? '')
          setSecretDraft({})
          setSavedNote(TEXT.saved)
          setDirty(false)
          const overview = await api('overview', { preset })
          if (mounted.current) setData(overview)
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (mounted.current) setSaving(false)
        }
      }, [settingsData, secretDraft, preset])

      const changePreset = useCallback((next) => {
        setPreset(next)
        setSelected('')
        setPreview('')
        setSearchResult(null)
        setData(null)
        setLoading(true)
        api('overview', { preset: next })
          .then((value) => { if (mounted.current) { setData(value); setLoading(false) } })
          .catch((cause) => { if (mounted.current) { setError(cause instanceof Error ? cause.message : String(cause)); setLoading(false) } })
      }, [])

      const refresh = useCallback(async () => {
        setLoading(true)
        setError('')
        try {
          const value = await api('overview', { preset })
          if (!mounted.current) return
          setData(value)
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (mounted.current) setLoading(false)
        }
      }, [preset])

      useEffect(() => {
        refresh()
        loadWorkspaces()
        loadSettings()
      }, [refresh, loadWorkspaces, loadSettings])

      const openFile = useCallback(async (relPath) => {
        setSelected(relPath)
        setPreview(TEXT.loading)
        try {
          const value = await api('file', { path: relPath, preset })
          if (mounted.current) setPreview(value.text)
        } catch (cause) {
          if (mounted.current) setPreview(`${TEXT.loadFailed}: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }, [preset])

      const runSearch = useCallback(async () => {
        const text = query.trim()
        if (text.length === 0) return
        setSearching(true)
        setSearchResult(null)
        setError('')
        try {
          const value = await api('search', { query: text, preset })
          if (mounted.current) setSearchResult(value)
        } catch (cause) {
          if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (mounted.current) setSearching(false)
        }
      }, [query, preset])

      const runDream = useCallback(async () => {
        setDreaming(true)
        setNotice(TEXT.dreaming)
        try {
          const value = await api('dream', { dryRun: true, preset })
          if (!mounted.current) return
          setNotice(`${TEXT.dreamDone}:\n${value.summary}`)
        } catch (cause) {
          if (mounted.current) setNotice(`${TEXT.loadFailed}: ${cause instanceof Error ? cause.message : String(cause)}`)
        } finally {
          if (mounted.current) setDreaming(false)
        }
      }, [preset])

      const grouped = useMemo(() => {
        const map = new Map()
        for (const item of data?.items ?? []) {
          const list = map.get(item.group) ?? []
          list.push(item)
          map.set(item.group, list)
        }
        return GROUP_ORDER.filter((group) => map.has(group)).map((group) => [group, map.get(group)])
      }, [data])

      const graphLayout = useMemo(() => {
        const nodes = data?.graph?.nodes ?? []
        const edges = data?.graph?.edges ?? []
        if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 }
        const width = 640
        const height = 440
        const cx = width / 2
        const cy = height / 2
        const radius = Math.min(width, height) / 2 - 46
        const positioned = nodes.map((node, index) => {
          const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2
          return { ...node, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
        })
        const byId = new Map(positioned.map((node) => [node.id, node]))
        const lines = edges
          .map((edge) => ({ from: byId.get(edge.from), to: byId.get(edge.to) }))
          .filter((edge) => edge.from !== undefined && edge.to !== undefined)
        return { nodes: positioned, edges: lines, width, height }
      }, [data])

      const stats = data
        ? {
            core: data.counts?.core ?? 0,
            daily: (data.counts?.['daily-index'] ?? 0) + (data.counts?.['daily-note'] ?? 0),
            digest: data.counts?.digest ?? 0,
          }
        : { core: 0, daily: 0, digest: 0 }

      const items = data?.items ?? []
      // MEMORY.md lives at the tree root, so the inventory does not carry it; the
      // overview returns its text separately. Synthesize the entry so the panel can
      // count and open it like any other document.
      const coreFile = (data?.memoryMd ?? '').length > 0
        ? { relPath: 'MEMORY.md', group: 'core', name: 'MEMORY.md', description: '' }
        : items.find((item) => item.relPath === 'MEMORY.md')
      const metrics = [
        { key: 'core', label: TEXT.core, value: coreFile ? 1 : 0 },
        { key: 'daily', label: TEXT['daily-note'], value: stats.daily },
        { key: 'digest', label: TEXT.digest, value: stats.digest },
        { key: 'chunks', label: TEXT.chunks, value: data?.chunks ?? 0 },
      ]
      const currentMode = presetRows.find((row) => row.id === preset)
      const journalFiles = items.filter((item) => item.relPath.startsWith('memory/'))
      const knowledgeFiles = items.filter((item) => item.relPath.startsWith('digest/'))
      const filterText = fileFilter.trim().toLowerCase()
      const visibleFiles = (files) => (filterText.length === 0
        ? files
        : files.filter((item) => `${item.name} ${item.relPath} ${item.description ?? ''}`.toLowerCase().includes(filterText)))
      const dreamModel = data?.models?.dream?.model && data.models.dream.model !== 'agent-default'
        ? data.models.dream.model
        : 'agent-default'
      const graphNodes = (data?.graph?.nodes ?? []).length
      const graphEdges = (data?.graph?.edges ?? []).length
      const badge = (ok, text) => h('span', { className: `ltm-badge ${ok ? 'ok' : 'bad'}` }, h('i'), text)
      const neutralBadge = (text) => h('span', { className: 'ltm-badge' }, h('i'), text)
      const flowStep = (index, label, key) => h('div', { key, className: 'ltm-flow-step' }, h('span', null, String(index)), h('strong', null, label))
      const flowCard = (className, title, steps, footnote, key) => h(
        'div',
        { key, className: `ltm-flow-card ${className}` },
        h('h3', null, title),
        h('div', { className: 'ltm-flow' }, ...steps),
        footnote ? h('p', null, footnote) : null,
      )
      const knowledgeIds = new Set(items.filter((item) => item.relPath.startsWith('digest/')).map((item) => item.relPath))
      const knowledgeLayout = (() => {
        const nodes = (data?.graph?.nodes ?? []).filter((node) => knowledgeIds.has(node.id))
        const width = 640
        const height = 260
        const radius = Math.max(60, Math.min(width, height) / 2 - 52)
        const cx = width / 2
        const cy = height / 2
        const positioned = nodes.map((node, index) => {
          const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2
          return { ...node, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius }
        })
        const byId = new Map(positioned.map((node) => [node.id, node]))
        const edges = (data?.graph?.edges ?? [])
          .filter((edge) => knowledgeIds.has(edge.from) && knowledgeIds.has(edge.to))
          .map((edge) => ({ from: byId.get(edge.from), to: byId.get(edge.to) }))
          .filter((edge) => edge.from !== undefined && edge.to !== undefined)
        return { nodes: positioned, edges, width, height }
      })()
      const nameOf = new Map((data?.graph?.nodes ?? []).map((node) => [node.id, node.name]))
      const relationsOf = (relPath) => {
        const all = data?.graph?.edges ?? []
        return {
          outbound: all.filter((edge) => edge.from === relPath).map((edge) => ({ id: edge.to, name: nameOf.get(edge.to) ?? edge.to })),
          inbound: all.filter((edge) => edge.to === relPath).map((edge) => ({ id: edge.from, name: nameOf.get(edge.from) ?? edge.from })),
        }
      }
      const relationChips = (list, keyPrefix) => (list.length === 0
        ? [h('em', { key: `${keyPrefix}-none`, className: 'ltm-relation-empty' }, TEXT.noRelations)]
        : list.map((link) =>
            h(
              'button',
              {
                key: `${keyPrefix}-${link.id}`,
                type: 'button',
                className: 'ltm-relation',
                title: link.id,
                onClick: () => openFile(link.id),
              },
              link.name,
            ),
          ))

      const CATEGORY_LABELS = {
        personal: ZH ? '个人' : 'Personal',
        procedure: ZH ? '流程' : 'Procedure',
        wiki: ZH ? '知识' : 'Wiki',
      }
      const groupKeyOf = (kind, item) => {
        const parts = item.relPath.split('/')
        if (kind === 'knowledge') return parts[1] ?? 'other'
        if (parts.length >= 3) return parts[1]
        return parts[1]?.replace(/\.md$/i, '') ?? 'other'
      }
      const groupLabelOf = (kind, key, files) => {
        if (kind === 'knowledge') return CATEGORY_LABELS[key] ?? key
        return key
      }
      const groupFiles = (kind, files) => {
        const map = new Map()
        for (const item of files) {
          const key = groupKeyOf(kind, item)
          const list = map.get(key) ?? []
          list.push(item)
          map.set(key, list)
        }
        return [...map.entries()]
          .sort((left, right) => right[0].localeCompare(left[0]))
          .map(([key, list]) => ({
            key,
            label: groupLabelOf(kind, key, list),
            files: list.sort((left, right) => left.relPath.localeCompare(right.relPath)),
          }))
      }
      const isGroupOpen = (key) => collapsedGroups[key] !== true
      const toggleGroup = (key) => setCollapsedGroups((current) => ({ ...current, [key]: current[key] !== true }))

      const folderIcon = () => h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.9,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3.2 7.6A2.4 2.4 0 0 1 5.6 5.2h3.1c.6 0 1.2.3 1.6.8l.9 1.2h7.2a2.4 2.4 0 0 1 2.4 2.4v7a2.4 2.4 0 0 1-2.4 2.4H5.6a2.4 2.4 0 0 1-2.4-2.4z' }),
      )

      const libraryPanel = (kind) => {
        const isKnowledge = kind === 'knowledge'
        const files = isKnowledge ? knowledgeFiles : journalFiles
        const shown = visibleFiles(files)
        const directory = isKnowledge ? 'digest/' : 'memory/'
        const doc = parseDocument(preview)
        return h(
          'div',
          { className: 'ltm-stack' },
          h(
            'div',
            { className: `ltm-library-hero${isKnowledge ? ' knowledge' : ''}` },
            h('span', { className: `ltm-library-mark${isKnowledge ? ' knowledge' : ''}`, 'aria-hidden': 'true' }, isKnowledge ? 'K' : 'J'),
            h(
              'div',
              null,
              h('h3', null, isKnowledge ? TEXT.knowledge : TEXT.journal),
              h('p', null, isKnowledge ? TEXT.knowledgeDescription : TEXT.journalDescription),
            ),
          ),
          isKnowledge && knowledgeLayout.nodes.length > 0
            ? h(
                'section',
                { className: 'ltm-graph-card' },
                h(
                  'div',
                  { className: 'ltm-graph-head' },
                  h('div', null, h('h3', null, TEXT.knowledgeGraph), h('p', null, TEXT.knowledgeGraphHint)),
                  h('span', { className: 'ltm-badge' }, h('i'), `${knowledgeLayout.nodes.length} / ${knowledgeLayout.edges.length}`),
                ),
                h(
                  'svg',
                  { viewBox: `0 0 ${knowledgeLayout.width} ${knowledgeLayout.height}`, className: 'ltm-graph', role: 'img' },
                  ...knowledgeLayout.edges.map((edge, index) =>
                    h('line', {
                      key: `ke-${index}`,
                      x1: edge.from.x,
                      y1: edge.from.y,
                      x2: edge.to.x,
                      y2: edge.to.y,
                      stroke: 'var(--dsw-alias-border-l2)',
                      strokeWidth: 1,
                      opacity: 0.7,
                    }),
                  ),
                  ...knowledgeLayout.nodes.map((node) =>
                    h(
                      'g',
                      { key: node.id, style: { cursor: 'pointer' }, onClick: () => openFile(node.id) },
                      h('circle', {
                        cx: node.x,
                        cy: node.y,
                        r: selected === node.id ? 11 : 8,
                        fill: '#7656c9',
                        stroke: 'var(--dsw-alias-bg-layer-2)',
                        strokeWidth: 2,
                      }),
                      h('text', {
                        x: node.x,
                        y: node.y + 22,
                        textAnchor: 'middle',
                        fontSize: 9,
                        fill: selected === node.id ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
                      }, String(node.name).slice(0, 14)),
                      h('title', null, `${node.name}\n${node.id}`),
                    ),
                  ),
                ),
              )
            : null,
          h(
            'div',
            { className: 'ltm-file-browser' },
            h(
              'aside',
              null,
              h(
                'div',
                { className: 'ltm-file-search' },
                h('input', {
                  className: 'ltm-input',
                  type: 'search',
                  value: fileFilter,
                  placeholder: TEXT.searchFiles,
                  onChange: (event) => setFileFilter(event.target.value),
                }),
                h('span', null, String(shown.length)),
              ),
              shown.length === 0
                ? h('div', { className: 'ltm-empty', style: { minHeight: '120px' } }, files.length === 0 ? TEXT.empty : TEXT.noSearchResults)
                : h(
                    'div',
                    { className: 'ltm-file-groups' },
                    ...groupFiles(kind, shown).map((group) => {
                      const key = `${kind}:${group.key}`
                      const open = isGroupOpen(key)
                      return h(
                        'section',
                        { key, className: `ltm-file-group${open ? '' : ' collapsed'}` },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: `ltm-file-group-head${isKnowledge ? ' knowledge' : ''}`,
                            'aria-expanded': String(open),
                            title: open ? TEXT.collapseGroup : TEXT.expandGroup,
                            onClick: () => toggleGroup(key),
                          },
                          h('span', { className: 'ltm-group-icon', 'aria-hidden': 'true' }, folderIcon()),
                          h(
                            'span',
                            { className: 'ltm-group-title' },
                            h('strong', null, group.label),
                            h('small', null, `${directory}${group.key}`),
                          ),
                          h('span', { className: 'ltm-group-count' }, String(group.files.length)),
                          h('i', { className: 'ltm-chevron', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
                        ),
                        open
                          ? h(
                              'div',
                              { className: 'ltm-group-files' },
                              ...group.files.slice(0, 200).map((item) =>
                                h(
                                  'button',
                                  {
                                    key: item.relPath,
                                    type: 'button',
                                    className: `ltm-group-file${item.relPath === selected ? ' active' : ''}`,
                                    title: item.relPath,
                                    onClick: () => openFile(item.relPath),
                                  },
                                  h('i', { className: isKnowledge ? 'knowledge' : '', 'aria-hidden': 'true' }, isKnowledge ? 'K' : 'J'),
                                  h(
                                    'span',
                                    null,
                                    h('strong', null, item.name),
                                    h('small', null, item.relPath.slice(directory.length)),
                                  ),
                                ),
                              ),
                            )
                          : null,
                      )
                    }),
                  ),
              shown.length > 200 ? h('div', { className: 'ltm-file-limit' }, TEXT.fileListLimited) : null,
            ),
            h(
              'article',
              { className: 'ltm-document' },
              selected
                ? h(
                    'div',
                    { className: 'ltm-document-preview' },
                    h(
                      'header',
                      null,
                      h(
                        'div',
                        null,
                        h('span', null, isKnowledge ? TEXT.knowledge : TEXT.journal),
                        h('h3', null, fileNameOf(selected)),
                        h('code', { title: selected }, selected),
                      ),
                    ),
                    doc.entries.length > 0
                      ? h(
                          'section',
                          { className: 'ltm-frontmatter' },
                          h('h4', null, TEXT.documentMetadata),
                          h(
                            'dl',
                            null,
                            ...doc.entries.map((entry, index) =>
                              h(
                                'div',
                                { key: `${entry.key}:${index}` },
                                h('dt', null, entry.key),
                                h('dd', null, entry.value.length > 0 ? entry.value : '—'),
                              ),
                            ),
                          ),
                        )
                      : null,
                    isKnowledge
                      ? h(
                          'section',
                          { className: 'ltm-relations' },
                          (() => {
                            const relations = relationsOf(selected)
                            return [
                              h('h4', null, TEXT.relations),
                              h(
                                'div',
                                { key: 'rel', className: 'ltm-relation-row' },
                                h('div', { key: 'out', className: 'ltm-relation-group' },
                                  h('span', null, TEXT.outbound),
                                  ...relationChips(relations.outbound, 'out')),
                                h('div', { key: 'in', className: 'ltm-relation-group' },
                                  h('span', null, TEXT.inbound),
                                  ...relationChips(relations.inbound, 'in')),
                              ),
                            ]
                          })(),
                        )
                      : null,
                    h(
                      'section',
                      { className: 'ltm-document-content' },
                      h('h4', null, TEXT.documentContent),
                      h('div', { className: 'ltm-markdown' }, markdownBlock(doc.body, 'md')),
                    ),
                  )
                : h('div', { className: 'ltm-empty' }, TEXT.selectFile),
            ),
          ),
        )
      }

      const componentCards = [
        {
          key: 'files',
          title: TEXT.componentFiles,
          subtitle: 'MEMORY.md · memory/ · digest/',
          ok: items.length > 0,
          rows: [
            [TEXT.files, String(items.length)],
            [TEXT.digest, String(stats.digest)],
            [TEXT['daily-note'], String(stats.daily)],
            [TEXT.core, coreFile ? '1' : '0'],
          ],
        },
        {
          key: 'keyword',
          title: TEXT.componentKeyword,
          subtitle: 'BM25 · k1=1.5 · b=0.75',
          ok: (data?.chunks ?? 0) > 0,
          rows: [
            [TEXT.chunks, String(data?.chunks ?? 0)],
            [TEXT.index, data?.chunks ? TEXT.vectorsReady : TEXT.vectorsOff],
          ],
        },
        {
          key: 'vector',
          title: TEXT.componentVector,
          subtitle: data?.embeddings?.baseURL || TEXT.vectorsOff,
          ok: data?.embeddings?.ready === true,
          rows: [
            [TEXT.fieldModel, data?.embeddings?.model || '—'],
            [TEXT.vectors, data?.embeddings?.ready ? TEXT.vectorsReady : TEXT.vectorsOff],
          ],
        },
        {
          key: 'graph',
          title: TEXT.componentGraph,
          subtitle: 'wikilink · 1-hop expansion',
          ok: graphNodes > 0,
          rows: [
            ['nodes', String(graphNodes)],
            ['edges', String(graphEdges)],
          ],
        },
      ]

      const componentsGrid = h(
        'div',
        { className: 'ltm-component-grid' },
        ...componentCards.map((card) =>
          h(
            'article',
            { key: card.key, className: 'ltm-component' },
            h(
              'header',
              null,
              h('div', null, h('strong', null, card.title), h('small', null, card.subtitle)),
              badge(card.ok, card.ok ? TEXT.healthOk : TEXT.healthBad),
            ),
            h(
              'dl',
              null,
              ...card.rows.map(([label, value], index) =>
                h('div', { key: `${card.key}:${index}` }, h('dt', null, label), h('dd', { title: String(value) }, String(value))),
              ),
            ),
          ),
        ),
      )

      const overviewPanel = h(
        'div',
        { className: 'ltm-stack' },
        h(
          'article',
          { className: 'ltm-overview-hero' },
          h(
            'div',
            { className: 'ltm-overview-brand' },
            h('div', { className: 'ltm-brand-mark' }, 'LM'),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('span', { className: 'ltm-eyebrow' }, 'LONG-TERM MEMORY'),
              h('h3', null, currentMode?.name ? `${TEXT.workspaceTitle} · ${currentMode.name}` : TEXT.workspaceTitle),
              h('p', { title: data?.root ?? '' }, data?.root ?? TEXT.loading),
            ),
          ),
          h(
            'div',
            { className: 'ltm-overview-health' },
            data
              ? badge(data.enabled === true, data.enabled === true ? TEXT.enabled : TEXT.disabled)
              : neutralBadge(TEXT.loading),
            neutralBadge(`${TEXT.chunks} ${data?.chunks ?? 0}`),
            data?.embeddings?.ready ? badge(true, TEXT.vectorsReady) : null,
          ),
          h(
            'dl',
            { className: 'ltm-overview-meta' },
            h('div', null, h('dt', null, TEXT.mode), h('dd', { title: preset }, preset || 'default')),
            h('div', null, h('dt', null, TEXT.core), h('dd', null, coreFile ? '1' : '0')),
            h('div', null, h('dt', null, TEXT.memoryFiles), h('dd', null, String(items.length))),
            h('div', null, h('dt', null, TEXT.backgroundModel), h('dd', { title: dreamModel }, dreamModel)),
          ),
        ),
        h(
          'div',
          { className: 'ltm-capability-grid' },
          ...metrics.map((metric) =>
            h(
              'article',
              { key: metric.key },
              h('div', null, h('span', null, metric.label), h('strong', null, String(metric.value))),
            ),
          ),
        ),
        h(
          'article',
          { className: 'ltm-feature-hero' },
          h(
            'div',
            null,
            h('span', { className: 'ltm-eyebrow' }, 'AUTO MEMORY'),
            h('h3', null, TEXT.captureTitle),
            h('p', null, TEXT.captureDescription),
          ),
          neutralBadge(data ? TEXT.savedState : TEXT.loading),
        ),
        flowCard(
          '',
          TEXT.captureTitle,
          [flowStep(1, TEXT.captureStep1, 'c1'), flowStep(2, TEXT.captureStep2, 'c2'), flowStep(3, TEXT.captureStep3, 'c3')],
          coreFile ? `${TEXT.coreTitle} · MEMORY.md` : null,
          'capture-flow',
        ),
        h(
          'article',
          { className: 'ltm-feature-hero consolidation' },
          h(
            'div',
            null,
            h('span', { className: 'ltm-eyebrow' }, 'CONSOLIDATION'),
            h('h3', null, TEXT.consolidationTitle),
            h('p', null, TEXT.consolidationDescription),
          ),
          neutralBadge(`${TEXT.lastDream} ${formatTime(data?.lastDreamAt ?? 0)}`),
        ),
        flowCard(
          'consolidation',
          TEXT.consolidationTitle,
          [flowStep(1, TEXT.dreamStep1, 'd1'), flowStep(2, TEXT.dreamStep2, 'd2'), flowStep(3, TEXT.dreamStep3, 'd3')],
          TEXT.consolidationFootnote,
          'dream-flow',
        ),
        h('div', { className: 'ltm-section-heading' }, h('div', null, h('h3', null, TEXT.componentsTab), h('p', null, TEXT.workspaceTitle))),
        componentsGrid,
        h(
          'details',
          { className: 'ltm-details' },
          h('summary', null, TEXT.advanced),
          h(
            'dl',
            { className: 'ltm-details-body' },
            h('div', null, h('dt', null, TEXT.lastDream), h('dd', null, formatTime(data?.lastDreamAt ?? 0))),
            h('div', null, h('dt', null, TEXT.vectors), h('dd', { title: data?.embeddings?.baseURL ?? '' }, data?.embeddings?.model || TEXT.vectorsOff)),
            h('div', null, h('dt', null, TEXT.backgroundModel), h('dd', { title: data?.models?.dream?.baseURL ?? '' }, dreamModel)),
            h('div', null, h('dt', null, TEXT.index), h('dd', null, String(data?.chunks ?? 0))),
            coreFile ? h('div', null, h('dt', null, TEXT.core), h('dd', { title: coreFile.relPath }, coreFile.relPath)) : null,
            h('div', null, h('dt', null, 'cwd'), h('dd', { title: data?.cwd ?? '' }, data?.cwd ?? '—')),
          ),
        ),
      )

      const capturePanel = h(
        'div',
        { className: 'ltm-stack' },
        h(
          'article',
          { className: 'ltm-feature-hero' },
          h(
            'div',
            null,
            h('span', { className: 'ltm-eyebrow' }, 'AUTO MEMORY'),
            h('h3', null, TEXT.captureTitle),
            h('p', null, TEXT.captureDescription),
          ),
          neutralBadge(`${journalFiles.length} ${TEXT.fileCount}`),
        ),
        flowCard(
          '',
          TEXT.captureTitle,
          [flowStep(1, TEXT.captureStep1, 'c1'), flowStep(2, TEXT.captureStep2, 'c2'), flowStep(3, TEXT.captureStep3, 'c3')],
          TEXT.captureFootnote,
          'capture-flow-2',
        ),
        h(
          'div',
          { className: 'ltm-section-heading' },
          h('div', null, h('h3', null, TEXT.journal), h('p', null, `${journalFiles.length} ${TEXT.fileCount} · ${data?.root ?? ''}/memory`)),
        ),
        journalFiles.length === 0
          ? h('div', { className: 'ltm-empty' }, TEXT.empty)
          : h(
              'div',
              { className: 'ltm-component-grid' },
              ...journalFiles.slice(0, 8).map((item) =>
                h(
                  'article',
                  { key: item.relPath, className: 'ltm-component' },
                  h(
                    'header',
                    null,
                    h('div', null, h('strong', null, item.name), h('small', null, item.relPath)),
                    neutralBadge(TEXT.journal),
                  ),
                  item.description ? h('p', { className: 'ltm-card-desc' }, item.description) : null,
                  h(
                    'footer',
                    null,
                    h('button', { type: 'button', className: 'ltm-button', onClick: () => { setTab('journal'); openFile(item.relPath) } }, TEXT.openFile),
                  ),
                ),
              ),
            ),
      )

      const dreamPanel = h(
        'div',
        { className: 'ltm-stack' },
        h(
          'article',
          { className: 'ltm-feature-hero consolidation' },
          h(
            'div',
            null,
            h('span', { className: 'ltm-eyebrow' }, 'CONSOLIDATION'),
            h('h3', null, TEXT.consolidationTitle),
            h('p', null, TEXT.consolidationDescription),
          ),
          h(
            'button',
            { type: 'button', className: 'ltm-button primary', onClick: runDream, disabled: dreaming },
            dreaming ? TEXT.dreaming : TEXT.consolidationAction,
          ),
        ),
        flowCard(
          'consolidation',
          TEXT.consolidationTitle,
          [flowStep(1, TEXT.dreamStep1, 'd1'), flowStep(2, TEXT.dreamStep2, 'd2'), flowStep(3, TEXT.dreamStep3, 'd3')],
          `${TEXT.lastDream} ${formatTime(data?.lastDreamAt ?? 0)}`,
          'dream-flow-2',
        ),
        h(
          'div',
          { className: 'ltm-capability-grid' },
          h('article', null, h('div', null, h('span', null, TEXT.lastDream), h('strong', null, formatTime(data?.lastDreamAt ?? 0)))),
          h('article', null, h('div', null, h('span', null, TEXT.fieldModel), h('strong', null, dreamModel))),
          h('article', null, h('div', null, h('span', null, TEXT.digest), h('strong', null, String(stats.digest)))),
          h('article', null, h('div', null, h('span', null, TEXT.journal), h('strong', null, String(journalFiles.length)))),
        ),
      )

      const componentsPanel = h(
        'div',
        { className: 'ltm-stack' },
        h('div', { className: 'ltm-section-heading' }, h('div', null, h('h3', null, TEXT.componentsTab), h('p', null, TEXT.workspaceTitle))),
        componentsGrid,
      )

      const searchPanel = h(
        'div',
        { className: 'ltm-stack' },
        h(
          'div',
          { className: 'ltm-search-bar' },
          h('input', {
            className: 'ltm-input',
            value: query,
            placeholder: TEXT.searchPlaceholder,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') runSearch()
            },
          }),
          h(
            'button',
            { type: 'button', className: 'ltm-button primary', onClick: runSearch, disabled: searching },
            searching ? TEXT.searching : TEXT.searchButton,
          ),
        ),
        searching
          ? h('div', { className: 'ltm-empty' }, TEXT.searching)
          : !searchResult
            ? h('div', { className: 'ltm-empty' }, TEXT.searchEmpty)
            : (searchResult.results ?? []).length === 0
              ? h('div', { className: 'ltm-empty' }, TEXT.noResults)
              : h(
                  'div',
                  { className: 'ltm-stack' },
                  ...(searchResult.results ?? []).map((item, index) =>
                    h(
                      'article',
                      { key: `${item.relPath}-${index}`, className: 'ltm-result-card' },
                      h(
                        'header',
                        null,
                        h(
                          'code',
                          { title: item.relPath, onClick: () => { setTab(item.relPath.startsWith('digest/') ? 'knowledge' : 'journal'); openFile(item.relPath) } },
                          `${item.relPath}:${item.startLine}-${item.endLine}`,
                        ),
                        neutralBadge(`${TEXT.score} ${Number(item.score).toFixed(4)}`),
                        neutralBadge(`${TEXT.keyword} ${Number(item.bm25Score).toFixed(2)}`),
                        item.vectorScore > 0 ? h('span', { className: 'ltm-badge brand' }, h('i'), `${TEXT.vector} ${Number(item.vectorScore).toFixed(3)}`) : null,
                      ),
                      (item.headingPath ?? []).length > 0
                        ? h('p', { style: { margin: '6px 0 0', color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', lineHeight: 1.5 } }, item.headingPath.join(' › '))
                        : null,
                      h('div', { className: 'ltm-markdown' }, markdownBlock(item.text, `hit-${index}`)),
                    ),
                  ),
                ),
      )

      const graphPanel = graphNodes === 0
        ? h('div', { className: 'ltm-empty' }, TEXT.graphEmpty)
        : h(
            'div',
            { className: 'ltm-stack' },
            h(
              'svg',
              { viewBox: `0 0 ${graphLayout.width} ${graphLayout.height}`, className: 'ltm-graph', role: 'img' },
              ...graphLayout.edges.map((edge, index) =>
                h('line', {
                  key: `e-${index}`,
                  x1: edge.from.x,
                  y1: edge.from.y,
                  x2: edge.to.x,
                  y2: edge.to.y,
                  stroke: 'var(--dsw-alias-border-l2)',
                  strokeWidth: 1,
                  opacity: 0.55,
                }),
              ),
              ...graphLayout.nodes.map((node) =>
                h(
                  'g',
                  { key: node.id, style: { cursor: 'pointer' }, onClick: () => { setTab(node.id.startsWith('digest/') ? 'knowledge' : 'journal'); openFile(node.id) } },
                  h('circle', {
                    cx: node.x,
                    cy: node.y,
                    r: selected === node.id ? 10 : 7,
                    fill: GROUP_COLOR[node.group] ?? GROUP_COLOR.other,
                    stroke: 'var(--dsw-alias-bg-layer-2)',
                    strokeWidth: 2,
                  }),
                  h('text', {
                    x: node.x,
                    y: node.y + 20,
                    textAnchor: 'middle',
                    fontSize: 9,
                    fill: 'var(--dsw-alias-label-tertiary)',
                  }, String(node.name).slice(0, 12)),
                  h('title', null, `${node.name}\n${node.id}`),
                ),
              ),
            ),
            h(
              'div',
              { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
              ...GROUP_ORDER.filter((group) => (data.counts?.[group] ?? 0) > 0).map((group) =>
                h('span', { key: group, className: 'ltm-badge' }, h('i', { style: { background: GROUP_COLOR[group] } }), `${TEXT[group] ?? group} ${data.counts[group]}`),
              ),
            ),
          )

      const modesSection = h(
        'section',
        { className: 'ltm-settings-section' },
        h('h4', null, TEXT.modesSection),
        h('p', null, TEXT.modesSectionHint),
        h(
          'div',
          { className: 'ltm-settings-fields' },
          ...presetRows.map((row) =>
            h(
              'label',
              { key: row.id, className: 'ltm-check' },
              h('input', {
                type: 'checkbox',
                checked: row.enabled === true,
                disabled: workspaceBusy === row.id,
                onChange: () => toggleWorkspace(row.id, !row.enabled),
              }),
              h('span', null, row.name),
              h('small', { className: 'ltm-mono', style: { marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary)' } }, row.hasMemory ? TEXT.hasMemory : TEXT.noMemory),
            ),
          ),
        ),
      )

      const settingsPanel = h(
        'div',
        { className: 'ltm-stack' },
        h(
          'div',
          { className: 'ltm-settings-toolbar' },
          h(
            'div',
            { className: 'ltm-settings-status' },
            h('i', { className: `ltm-dot ${dirty ? '' : 'ok'}` }),
            h('span', null, dirty ? TEXT.pending : TEXT.savedState),
            dirty ? h('span', { className: 'ltm-pending' }, TEXT.pending) : null,
            settingsFile ? h('code', { title: settingsFile }, settingsFile) : null,
          ),
        ),
        ...settingGroups.map((group) =>
          h(
            'details',
            { key: group.key, className: 'ltm-settings-section', open: true },
            h(
              'summary',
              { className: 'ltm-settings-summary' },
              h('h4', null, group.title),
              group.description ? h('p', null, group.description) : null,
            ),
            h(
              'div',
              { className: 'ltm-settings-fields' },
              ...group.fields.map((field) =>
                field.type === 'boolean'
                  ? h(
                      'label',
                      { key: field.name, className: 'ltm-check' },
                      h('input', {
                        type: 'checkbox',
                        checked: Boolean(field.value),
                        onChange: () => updateSetting(group.key, field.name, !field.value),
                      }),
                      h('span', null, field.label),
                    )
                  : h(
                      'div',
                      { key: field.name, className: 'ltm-field' },
                      h('label', null, field.label),
                      h('input', {
                        className: 'ltm-input',
                        type: field.type === 'secret' ? 'password' : 'text',
                        autoComplete: field.type === 'secret' ? 'new-password' : undefined,
                        value: field.value ?? '',
                        placeholder: field.placeholder ?? '',
                        onChange: (event) => updateSetting(group.key, field.name, event.target.value),
                      }),
                      field.type === 'secret'
                        ? h('small', null, field.configured ? TEXT.secretConfigured : TEXT.secretMissing)
                        : null,
                      field.hint ? h('small', null, field.hint) : null,
                    ),
              ),
            ),
          ),
        ),
        modesSection,
        h(
          'div',
          { className: 'ltm-actions' },
          savedNote ? h('span', { className: 'ltm-saved' }, savedNote) : null,
          h('button', { type: 'button', className: 'ltm-reset', onClick: resetSettings, disabled: saving }, TEXT.reset),
          h(
            'button',
            { type: 'button', className: 'ltm-button primary', onClick: saveSettings, disabled: saving },
            saving ? TEXT.saving : TEXT.save,
          ),
        ),
      )

      const TABS = [
        ['overview', TEXT.overview],
        ['capture', TEXT.autoMemoryTab],
        ['dream', TEXT.dreamTab],
        ['components', TEXT.componentsTab],
        ['journal', TEXT.journal],
        ['knowledge', TEXT.knowledge],
        ['search', TEXT.search],
        ['settings', TEXT.settings],
      ]
      const PANELS = {
        overview: overviewPanel,
        capture: capturePanel,
        dream: dreamPanel,
        components: componentsPanel,
        journal: libraryPanel('journal'),
        knowledge: libraryPanel('knowledge'),
        search: searchPanel,
        settings: settingsPanel,
      }

      return h(
        'div',
        { className: 'ltm-page' },
        h(
          'header',
          { className: 'ltm-page-header' },
          h(
            'div',
            null,
            h('h2', null, TEXT.title, h('span', { className: 'ltm-version', title: 'client bundle' }, `v${PANEL_VERSION}`)),
            h('p', null, TEXT.subtitle),
          ),
          h(
            'div',
            { className: 'ltm-header-actions' },
            h(
              'select',
              {
                className: 'ltm-select',
                value: preset,
                onChange: (event) => changePreset(event.target.value),
                title: TEXT.modeSelectHint,
                'aria-label': TEXT.modeSelectHint,
              },
              ...presetRows.map((row) =>
                h('option', { key: row.id, value: row.id }, `${row.name}${row.enabled ? '' : ` · ${TEXT.disabled}`}`),
              ),
            ),
            coreFile
              ? h('button', { type: 'button', className: 'ltm-button', onClick: () => { setTab('journal'); openFile('MEMORY.md') } }, TEXT.openCore)
              : null,
            h('button', { type: 'button', className: 'ltm-button', onClick: refresh, disabled: loading }, TEXT.refresh),
          ),
        ),
        h(
          'nav',
          { className: 'ltm-tabs', role: 'tablist' },
          ...TABS.map(([key, label]) =>
            h(
              'button',
              {
                key,
                type: 'button',
                role: 'tab',
                'aria-selected': String(tab === key),
                className: tab === key ? 'active' : '',
                onClick: () => {
                  setTab(key)
                  if (key === 'journal' || key === 'knowledge') setFileFilter('')
                },
              },
              label,
            ),
          ),
        ),
        h(
          'section',
          { className: 'ltm-tab-panel' },
          error ? h('div', { className: 'ltm-notice error' }, `${TEXT.loadFailed}: ${error}`) : null,
          notice ? h('div', { className: 'ltm-notice success' }, notice) : null,
          loading && !data ? h('div', { className: 'ltm-empty' }, TEXT.loading) : null,
          PANELS[tab] ?? overviewPanel,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'long-term-memory',
              order: 30,
              label: () => TEXT.navTitle,
            },
            Panel,
          ),
        )
      },
    }
  },
})
