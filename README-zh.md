# 天机阁 · 算法天书

> [English](README.md) · [中文](README-zh.md) · [Español](README-es.md) · [Português](README-pt.md) · [हिन्दी](README-hi.md)

插件只是**接口**；天书本体在上一级 `algo-hub` 仓库里（`data/algorithms.json` +
`data/taxonomy.json`）。独立安装时包内自带一份起始库快照（`seed/`），首次运行自动播种到
`~/.dsh/tianjige`，所以没有仓库也能直接用。

## Features

- **检索** —— `tianji_search` 用自然语言或关键词找术法，支持按卷、法门、成熟度、
  “有没有现成实现”过滤；先严格匹配，不够再放宽为部分匹配，结果直接给可点的仓库/包链接。
- **档案** —— `tianji_get` 取单条完整档案：原理、取舍、复杂度、论文、实现、同法门的其它方案、注意事项。
- **问天书** —— `tianji_ask` 让模型先翻库内回答选型问题，可用 `findNew: true` 再联网找库外新算法。
- **采风** —— `tianji_sweep` 联网找新算法，整理成候选草稿写进 `data/pending/`，支持每日自动采风
  （`action=status|start|config`）。
- **维护** —— `tianji_stage` / `tianji_update` / `tianji_review` / `tianji_review_mark` /
  `tianji_stats` / `tianji_usage` 覆盖新增、修改、复核、体检与 token 记账。
- **页面** —— 左侧栏一行「天机阁」打开整页视图（天书 / 斗法台 / 采风 / 问天书 四个页签），
  同一页面也可作为右侧栏页签打开。

## Install

插件包本体就是 `tianjige-plugin/` 目录。给 profile 装上并启用：

```powershell
# 从 GitHub Release 安装（不需要 npm 账号）
dsh plugin --profile desktop add https://github.com/MengXingXiaoMing/dsh-tianjige/releases/download/v1.3.0/dsh-tianjige-1.3.0.tgz

# 从 npm 安装（发布之后）
dsh plugin --profile desktop add dsh-tianjige

# 从本地仓库安装（开发用）：直接加目录
dsh plugin --profile desktop add C:\path\to\algo-hub\tianjige-plugin
```

（profile 名不是 `desktop` 就换成你自己的。）装完**重启 DSH**：宿主侧入口模块只在启动时 import
一次，刷新页面不会重新装载。重启前可以先用 `node --check host.js` / `node --check lib/*.mjs` 做静态自检。
## Configuration

插件在 `cordis.patch.yml` 里插一行 `id: tianjige`，两个配置键都可选：

| 键 | 默认 | 说明 |
|---|---|---|
| `dataDir` | 本包目录的上一级（= 仓库根） | 天书根目录，含 `data/` 与 `server/ai.mjs` |
| `defaultLimit` | `8` | `tianji_search` 默认返回条数 |

```yaml
- insert:
    - id: tianjige
      name: dsh-tianjige
      config:
        dataDir: D:\wherever\algo-hub   # 可选，默认自动推导
        defaultLimit: 8
```

## Data layout

```
algo-hub/
  data/
    algorithms.json   # 合并后的天书库（219 条）
    taxonomy.json     # 13 个卷的清单
    review.json       # 复核台账
    coverage.json     # 采风覆盖矩阵（采风跑过才有）
    staging/          # 按 agent 分片的待合并素材
    pending/          # AI 草稿，等人工复核
    runs/             # 每轮采风台账
    logs/             # 页面错误上报（client-YYYY-MM-DD.log）
  server/ai.mjs       # 旧网页版的 AI 逻辑（插件用的是 lib/ai.mjs）
  tools/algohub.py    # CLI：validate / merge / export / stats / coverage / record-run / snapshot …
```

从 npm 安装时，包旁边没有仓库，所以首次运行会把包内自带的起始库（`seed/algorithms.json`、`seed/taxonomy.json`）复制到 `~/.dsh/tianjige`，之后所有读写都在那里。配置 `dataDir` 或环境变量 `DSH_TIANJIGE_DATA_DIR` 可以覆盖；link / 开发安装仍直接使用仓库根目录。

## Compatibility

- **DSH** `>=0.2.1-rc.2`（`dsh.engines.dsh`），**Node** `^22.19.0 || >=24.0.0`
- 完全不依赖 `@deepseek-ai/*`：宿主入口零 import，数据层与 AI 层都按需动态 import，
  所以 profile 内的副本永远不会遮蔽运行时版本。
- AI 工具（问天书 / 采风 / 复核辅助）需要 `DEEPSEEK_API_KEY`：环境变量，或
  `~/.dsh/.credentials.yaml` 里的 `DEEPSEEK_API_KEY:` 行；没有 key 时其余工具照常工作，
  AI 工具返回 `AI_NO_KEY`。
- 唯一的 peer 依赖是 `react`（客户端半边，由宿主提供）。

## Tools

| 工具 | 作用 |
|---|---|
| `tianji_search` | 检索术法（`query`，可选 `domain` / `functionKey` / `maturity` / `hasImpl` / `limit`） |
| `tianji_get` | 按 `id` 取完整档案 |
| `tianji_ask` | 自然语言问选型（`task`，可选 `findNew` 联网） |
| `tianji_sweep` | 采风：`action=status` / `start` / `config`（每日自动采风开关与间隔） |
| `tianji_stage` | 新增候选术法（写 `data/staging/`，待人工合并） |
| `tianji_update` | 原地修改已收录条目（自动备份） |
| `tianji_review` / `tianji_review_mark` | 复核队列：列出待复核项 / 记账 |
| `tianji_stats` | 天书体检：条目数、卷分布、实现覆盖率、复核进度 |
| `tianji_usage` | AI 用量账本（读 / 删 / 清 / 保留天数） |

## UI surfaces

插件注册三类座位：

- `sidebar.panellist` —— 左侧栏一行「天机阁」（`order: 120`）
- `main` —— 从该行打开的整页视图（天书 / 斗法台 / 采风 / 问天书）
- `sidebar.right.pane.tab` —— 同一页面的右侧栏页签

页面数据走宿主路由 `/api/tianjige/{library,meta,sweep,ask,review,usage,write,log}`，
只接受本机回环请求；没有 `webServer` 服务时插件降级为「只有工具、没有页面」。

## Troubleshooting

- **装完没反应** —— 先重启 DSH；再看 `plugin_manager` 返回的 `application` 字段。
- **页面提示「采风状态读不到」** —— 通常是有依赖模块加载失败（例如 `lib/ai.mjs` 缺失），
  路由会把错误写进 `/api/tianjige/meta` 的 500 回包；用 `node --check lib/sweep.mjs` 自检。
- **问天书报 `AI_NO_KEY`** —— 按上面 Compatibility 配置 key。
- **数据校验** —— `python tools/algohub.py validate`（期望 0 错误 0 警告），`doctor` 查引用。

## Development

- 宿主：`host.js`（入口，工具 + 路由）、`lib/sweep.mjs`（采风 / 复核 / 问天书）、
  `lib/ai.mjs`（AI 调用与提示词）、`lib/usage.mjs`（token 账本）、`lib/entries.mjs`（条目读写）。
- 客户端：`lib/client.js`（React，单文件 bundle，注册到 slot）。
- 测试：`npm test` 跑 `node --test test/smoke.test.mjs` —— 离线、零依赖、用 `test/fixtures/` 的
  真条目快照，不碰真数据、也不需要装进 profile。
- 静态检查：`dsh-plugin-dev check --strict`（来自 `dsh-plugin-guide` 技能包）以及对每个入口
  `node --check`。

## Publishing

分发有两条路，都是可选的；GitHub 始终是唯一事实来源。

**发版（维护者）。** 改 `version`，跑 `npm test` 和 `dsh-plugin-dev check --strict`，然后打包并挂到
GitHub Release 上：

```powershell
npm pack
gh release create v<version> dsh-tianjige-<version>.tgz --title "v<version>" --notes "..."
```

**npm（可选）。** `npm login` 之后执行 `npm publish --access public`，用户就能用
`dsh plugin --profile desktop add dsh-tianjige` 安装。上架市场并不要求先发 npm。

**DSH 插件市场。** 注册文件放在 [`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
一个插件一个文件，路径 `data/plugins/<owner>__<repo>.yml`，字段为 `url`、`name`、`category`、可选的
`tarball`，以及 `description.en`（能写就再加 `description.zh`）。条件：仓库公开、`package.json` 里声明
`dsh.bundle.patch` 且仓库根有 `cordis.patch.yml`、带 `dsh-plugin` topic、描述与代码一致、仓库创建满
一天——最后这条由 CI 自动检查，用来挡「PR 前几分钟才建仓库」的刷榜号。从你的 fork 提 PR，合并后市场
展示的就是这条注册记录。

**推荐列表（可选）。** `DshMarketPlace/awesome-dsh-plugin` 维护 `data/curated.yml`；在那里提 PR 只是
推荐位、不是注册，所以等 registry 收录之后再提。
## License

MIT —— 见 [LICENSE](LICENSE)。
