<p align="center"><img src="assets/logo/gemini-agy.svg" width="440" alt="AGY-CREW"></p>

<p align="center"><a href="README.md">English</a> | <a href="README.zh-CN.md">简体中文</a></p>

<p align="center"><a href="https://antigravity.google/product/antigravity-cli"><img src="assets/badges/powered-by-antigravity.svg" height="20" alt="powered by: Antigravity"></a> <img src="assets/badges/model-gemini-3-8-flash.svg" height="20" alt="model: Gemini 3.8 Flash"></p>

<p align="center"><a href="https://claude.com/claude-code"><img src="assets/badges/claude-code-plugin.svg" height="20" alt="Claude Code plugin"></a> <a href="https://developers.openai.com/codex/"><img src="assets/badges/codex-plugin.svg" height="20" alt="Codex plugin"></a> <a href="LICENSE"><img src="assets/badges/license-mit.svg" height="20" alt="license: MIT"></a></p>

# agy-crew

把 Google 的 Antigravity CLI（`agy`）雇来当 **Claude Code**、**OpenAI Codex**、**Pi**、**OpenCode** 等环境的「agy 员工」。agy-crew 是 Keli Wen 的 [agy-staff](https://github.com/keli-wen/agy-staff)（MIT）的 fork，详见[与 agy-staff 的关系](#与-agy-staff-的关系)。

![设计图](assets/design.png)

**[安装](#安装) · [使用示例](#使用) · [账号池](#账号池) · [核心设计](#核心设计) · [为其他 CLI 做一个](#为其他-cli-做一个) · [升级与卸载](#升级与卸载) · [与 agy-staff 的关系](#与-agy-staff-的关系)**

## 它适合做什么

agy-crew 提供五种角色（persona）。`staffer` 适合通用任务；`researcher` 负责调研；`reviewer` 审查代码、方案和决策；`implementer` 处理编码任务；`ask` 用于不需要工具的简短问答。前四种角色都使用相同的后台任务机制，由 `jobs` 技能负责等待、查看进度和收取结果。执行 `agy-crew install` 之后，所有 harness 都以 `/agy-crew-<persona>` 调用这些角色；通过 harness 的插件方式安装时，Claude Code 使用 `/agy-crew:<persona>`，Codex 使用 `$agy-crew:<persona>`。

为什么需要它：GPT-5.6-Sol 开着 fast mode 也慢；Claude Code 快一些，但 Fable 额度有限，更适合用来编排 subagent，而不是亲自做每一次调研和审查。这些任务可以交给 agy：它几秒钟就能给出第二意见，调研和审查以 Flash 的速度完成，范围明确的实现任务放到后台执行，你继续做手头的事。另外，即使不追求速度，让另一个模型家族审同一份代码，也能发现主力 agent 自己发现不了的问题。

![主 agent 将部分工作交给后台运行的 agy](assets/why.png)

### 为什么要 fork

agy-crew 保留了 agy-staff 的角色、后台任务，以及“bash 加 skills”的可移植设计，并增加了：

1. 终端命令 `agy-crew` 和 `install` 命令：从同一份共享 bundle 把技能装进检测到的每个 harness，取代各 harness 自己的插件缓存；
2. 与上游 agy-staff 严格互斥（安装器发现它时拒绝运行）；
3. **账号池**：让并发任务跑在不同的 agy 账号上，并按账号、按模型家族感知配额（见[账号池](#账号池)）。

`-crew` 后缀与作者的 `codex-staff` 对应：`-staff` 是单账号委派，`-crew` 是账号池。

## 安装

先安装 Antigravity CLI。下面的命令来自[官方安装文档](https://antigravity.google/docs/cli/install)，安装后用 `agy --version` 确认命令可用。运行插件还需要 Node.js 20 或更高版本。

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

接着安装 agy-crew。**agy-crew 与 agy-staff 不能安装在同一台机器上**（见[与 agy-staff 的关系](#与-agy-staff-的关系)），安装器发现 agy-staff 时会拒绝运行。

先选一条路线。

| 路线 | 需要 | 得到什么 | 适合 |
|---|---|---|---|
| A：npm（推荐） | Node.js 20+、npm | PATH 上的 `agy-crew` 命令 | 想要一条命令装好 |
| A′：git clone + node | Node.js 20+、git（不需要 npm） | 只有技能；命令写作 `node <clone>/companion/agy-companion.mjs …` | 没有 npm 或不想用 npm |
| B：插件管理器 | harness 自带的 CLI | harness 内的技能，没有终端命令 | 希望由 harness 管理插件 |

### 路线 A（推荐）：npm，一条命令

```bash
npm install -g agy-crew
agy-crew install
```

想试用 `master` 上尚未发布的改动，可以改用 `npm install -g github:pStrikeZ/agy-crew`（需要 git）。开发时可以从检出目录安装：`git clone https://github.com/pStrikeZ/agy-crew && cd agy-crew && npm link`，再运行 `agy-crew install`。此时技能直接从检出目录运行，`git pull` 后立即生效；拉取之后请重新运行 `agy-crew install` 以刷新 bundle。

### 路线 A′：不用 npm，git clone + node

```bash
git clone https://github.com/pStrikeZ/agy-crew
node agy-crew/companion/agy-companion.mjs install
```

技能的行为完全一样：bundle 中记录的是 clone 内 companion 的绝对路径。PATH 上没有 `agy-crew` 命令，因此本文中所有以 `agy-crew` 开头的命令，都要改写成 `node <clone>/companion/agy-companion.mjs <命令>`，例如 `node <clone>/companion/agy-companion.mjs accounts login work1`。clone 必须留在原处（移动或删除会让技能失效），每次 `git pull` 之后都要重新运行安装命令。嫌麻烦的话可以设一个 shell 别名，例如 `alias agy-crew='node ~/agy-crew/companion/agy-companion.mjs'`。

### `install` 做了什么（路线 A 和 A′）

`agy-crew install` 会根据配置目录自动检测已有的 harness。参数：`--hosts claude,codex,omp,opencode,dsh`（显式列表）、`--all`、`--dry-run`（只打印计划，不写入）、`--status`（显示各 host 的链接状态和 bundle）、`--json`。`agy-crew uninstall [--hosts …|--all]` 只移除安装器自己创建的链接。

| Host | 技能目录 |
|---|---|
| Claude Code（`claude`） | `~/.claude/skills` |
| Codex（`codex`） | `~/.agents/skills` |
| Oh My Pi（`omp`） | `~/.omp/agent/skills` |
| OpenCode（`opencode`） | `~/.config/opencode/skills` |
| DeepSeek Harness（`dsh`） | `~/.dsh/skills` |

技能只渲染一次，写入 `~/.agy-crew/bundles/<version>-<digest>/`，其中 companion 路径为绝对路径；每个 harness 得到指向该 bundle 的目录链接（`agy-crew-<persona>`，Windows 上是 junction，不需要提权）。技能目录中任何不是安装器创建的内容都视为用户内容，绝不覆盖；出现任何冲突时，整次运行会在写入之前中止，并打印相关路径和处理办法。`install` 不覆盖 Pi，请使用下面的 Pi 软件包方式。

安装后重启 harness 或开启新会话，然后按[首次使用](#首次使用)继续。

### 路线 B：harness 的插件管理器

插件管理器不需要终端命令，但账号池命令在这条路线下比较别扭：companion 位于插件缓存目录里，只能用缓存路径去调用（可以改在 agent 里用 `/agy-crew-accounts`，想用账号池也可以直接选路线 A 或 A′）。

<details>
<summary>Claude Code</summary>

```bash
claude plugin marketplace add pStrikeZ/agy-crew
claude plugin install agy-crew@agy-crew
```

重启 Claude Code 后运行 `/agy-crew:ask reply with OK`。

</details>

<details>
<summary>Codex</summary>

```bash
codex plugin marketplace add https://github.com/pStrikeZ/agy-crew
codex plugin add agy-crew@agy-crew
```

重启 Codex 后运行 `$agy-crew:ask reply with OK`。Codex 的命令沙箱无法运行 agy，companion 命令必须在沙箱之外运行（见 [INSTALL_FOR_AGENTS.md](docs/INSTALL_FOR_AGENTS.md)）。

</details>

<details>
<summary>Pi</summary>

运行 `pi install git:github.com/pStrikeZ/agy-crew` 安装插件。Pi 中的技能使用 `agy-crew-` 前缀，例如 `/skill:agy-crew-ask reply with OK`；任务管理技能是 `/skill:agy-crew-jobs`。

更新时运行 `pi update --extension git:github.com/pStrikeZ/agy-crew`，然后在 Pi 中执行 `/reload`。

</details>

<details>
<summary>OpenCode</summary>

使用 OpenCode V1（≥1.18.34 <2）的原生插件管理命令安装：

```bash
opencode plugin 'agy-crew@git+https://github.com/pStrikeZ/agy-crew.git' --global
```

重启 OpenCode 后运行 `/agy-crew-ask reply with OK`。插件会自动注册八个 `agy-crew-*` 技能及其原生斜杠命令，包括 `/agy-crew-lead`、`/agy-crew-jobs` 和 `/agy-crew-accounts`，无需单独配置技能路径或命令包装。仍需安装 Node.js，并完成 `agy` 登录。

OpenCode 按完整包规格缓存；仅重启不会刷新相同的 Git 规格。升级时选择新的 Git 标签或提交，运行 `opencode plugin 'agy-crew@git+https://github.com/pStrikeZ/agy-crew.git#<tag-or-commit>' --global --force`，然后重启。配置与本地开发方式见[参考手册](docs/REFERENCE.zh-CN.md#opencode)。此适配器不覆盖 OpenCode V2。

</details>

### 首次使用

装好之后，按下面的顺序走一遍即可。

1. **冒烟测试。** 重启 harness（或开启新会话），运行 `/agy-crew-ask reply with OK`（Codex 中是 `$agy-crew-ask reply with OK`；插件路线请用路线 B 中的写法）。应该会返回一句简短的回答。`ask` 不调用工具，也不需要额外的权限配置。如果失败，先运行 `agy --version`，并手动启动一次 `agy` 完成登录。
2. **可选：账号池。** 不添加账号时，一切都跑在你自己的 agy 登录上；一个账号够用就可以跳过这一步。要添加账号，请在你自己的终端里运行（会打开浏览器登录，agent 无法代劳）：

   ```bash
   agy-crew accounts login work1     # 在浏览器里登录；名字随意
   agy-crew accounts login work2     # 每多一个账号重复一次（每次用不同的 Google 账号）
   agy-crew accounts list            # 每个账号都应显示 ready
   agy-crew accounts quota --refresh # 查看各账号当前配额
   ```

   路线 A′ 请把 `agy-crew` 换成 `node <clone>/companion/agy-companion.mjs`。详见[账号池](#账号池)。
3. **日常使用。** 直接调用角色：`/agy-crew-researcher`、`/agy-crew-reviewer`、`/agy-crew-implementer`、`/agy-crew-staffer`、`/agy-crew-lead`（Codex 中是 `$agy-crew-…`）。后台任务的结果由 agent 通过 jobs 技能替你收取，不需要自己运行 `wait`。`/agy-crew-accounts` 用来查看账号池（账号、配额、冷却状态）。示例见[使用](#使用)。

> [!IMPORTANT]
> `staffer`、`researcher`、`reviewer` 和 `implementer` 默认使用 `unrestricted` 权限配置，可以读取仓库、运行命令和修改文件。插件会通过提示词说明任务边界和已有改动的归属；任务明确要求提交、推送或创建 PR 时，agy 才应执行相应操作，否则留下工作区改动供你审查。这些提示约定不能替代权限隔离。
>
> 日常使用不需要先运行 `setup`。如果希望保留 agy 自身的权限检查，可以选择 `--restricted`，并通过 `setup` 配置允许执行的命令。`setup` 默认只展示计划，经你确认后才写入配置（它会修改全局的 `~/.gemini/antigravity-cli/settings.json`）。按仓库保存的策略文件是 `.agy-crew/config.json`。使用前请阅读[权限说明](docs/REFERENCE.zh-CN.md#可选加固-setup)，了解全局命令允许列表的作用范围，以及审查不可信内容时的限制。

### 让 agent 帮你安装

也可以把下面这段话交给你的 coding agent，让它按照仓库里的说明完成安装和验证：

```
Read the raw text of https://raw.githubusercontent.com/pStrikeZ/agy-crew/master/docs/INSTALL_FOR_AGENTS.md
(curl it — do not work from a summary), or the same file in your local checkout of agy-crew, and follow it to
install and verify the agy-crew plugin for the harness you are running in. Respond in the user's language.
```

## 使用

在 harness 中输入 `/agy-crew-`（Codex 中为 `$agy-crew-`），就能选择要使用的角色；通过 Claude Code 的插件方式安装时，写法是 `/agy-crew:staffer`。

下面的示例使用用户级写法 `/agy-crew-…`（Codex 中显示为 `$agy-crew-…`）。通过插件方式安装时，Claude Code 使用 `/agy-crew:…`，Codex 使用 `$agy-crew:…`；Pi 使用 `/skill:agy-crew-…`。

| 想做的事 | 示例 |
| --- | --- |
| 编排持续推进的任务 | `/agy-crew-lead 调研可选方案，起草提案，再根据我的反馈修订` |
| 问一个简短的问题 | `/agy-crew-ask 你的后端模型是什么` |
| 交办一个通用任务 | `/agy-crew-staffer 汇总这个仓库里所有未完成的 TODO` |
| 生成图片 | `/agy-crew-staffer 生成一个像素风机器人吉祥物，存为 assets/mascot.png` |
| 审查当前改动 | `/agy-crew-reviewer 检查当前工作区的改动` |
| 审查某个 PR | `/agy-crew-reviewer 审查 PR #730` |
| 审查方案 | `/agy-crew-reviewer 检查 docs/plan.md 中的迁移方案，指出可能遗漏的问题` |
| 调研代码 | `/agy-crew-researcher 这个仓库的鉴权是怎么做的` |
| 实现修复 | `/agy-crew-implementer 修复那个不稳定的重试测试` |
| 查看或继续任务 | 直接说“agy 的任务进展如何”或“继续刚才的任务，再检查一下错误路径” |

使用 `reviewer` 时，直接说明审查对象即可。agy 会自行调用 `gh pr view`、`git diff` 等命令收集材料，也可以读取指定文件。代码审查会按严重程度列出问题；方案和决策审查则会检查假设、取舍和可能遗漏的情况。

`staffer` 没有预设的专业分工，因此也适合调用其他角色没有专门介绍的 agy 原生工具，例如 `generate_image`。项目曾在 agy v1.1.15 上验证图像生成：一次调用约 30 秒生成了 1024×1024 的 PNG。这个记录可以作为使用示例，实际耗时取决于任务和运行环境。

## 账号池

一个 agy 登录只有一份配额：并发任务只能排队，常用模型也容易被用完。账号池让后台任务同时跑在多个 agy 账号上，并按账号、按模型家族记录配额。

快速开始：

```bash
agy-crew install                    # 如上
agy-crew accounts login work1       # 会打开浏览器登录；请在你自己的终端里运行
agy-crew accounts list              # work1 显示为 ready
```

之后每次运行都会自动选择账号（默认就是 `--account auto`）：优先选空闲账号，其次选已知剩余配额最多的。想要更多账号，换个名字再执行一次 `login` 即可。你自己的 agy 登录（**live**）永远不属于账号池：`auto` 不会用它，它也不会借出凭据。只有显式传入 `--account live`，或账号池里没有任何启用的账号时才会用到它，所以账号池为空时一切照旧。

账号触及配额上限时，companion 会为该账号和模型家族记录冷却，直到 agy 报告的重置时间，没有报告则为 60 分钟。尚未开始会话的任务会转到另一个账号；已经在会话中的任务仍绑定原账号，因为会话历史保存在那里。如果该账号正在冷却，就由一个空闲账号在本次运行中出借凭据，结束后令牌文件会还原，崩溃后也会恢复。所有账号都无法继续时，任务以 `quota_exhausted` 结束并给出 `retry_at`，由你决定何时 `continue`。上游 503（`No capacity available for model ...`）会让该账号冷却 3 分钟，下一次运行改用其他账号；没有改动过工作区的任务会用原始提示词开新会话重跑，而不是继续旧会话。如果任务仍以 `upstream_unavailable` 结束且 agy 还什么都没做，请重新开始任务，不要用 `continue`。`agy-crew accounts quota --refresh` 会向 Google 的 Cloud Code 服务查询当前配额，这是唯一会联网的命令。

已经有账号了？`agy-crew accounts import work2 --home <dir>` 会从现有的 HOME 形态目录复制令牌，例如 agy-cli-manager 的账号目录（`~/.agy-cli-manager/accounts/<name>`）。agy-crew 并不依赖 agy-cli-manager，导入只是复制文件，再做与登录相同的邮箱和重复检查。其他子命令：`enable`、`disable`、`cooldown clear|record`、`hold acquire|release`、`remove --yes`。想手动使用某个池账号时，`agy-crew start work1` 会在当前目录以该账号身份打开交互式 agy，退出前后台任务不会使用它（`--` 之后的参数传给 agy）。完整说明见[参考手册](docs/REFERENCE.zh-CN.md#账号池)。

现在，并行任务的数量大致以就绪账号数为宜。账号池为空时，所有任务都跑在你的 live 登录上。

## 核心设计

`lead` 为当前主 agent 增加任务编排指导。在 lead 工作流中，主 agent 了解至足以明确任务后，默认用 `staffer` 承担实质性工作，等待结果返回后再验收、整合或追加任务；专门指导有帮助时再选择 specialist，`ask` 仅用于测试。主 agent 负责跨任务决策、验收、整合和交付，复用现有 jobs 工作流。使用 `/agy-crew-lead`（Claude Code 插件方式为 `/agy-crew:lead`，Codex 插件方式为 `$agy-crew:lead`，Pi 为 `/skill:agy-crew-lead`）。

`ask` 会在同一次调用中返回答案。其他角色启动后会先返回任务 ID，并给出收取结果的命令，例如 `wait <id> --timeout 10m`。主 agent 根据所在环境的能力等待任务；如果支持后台命令，就为每个任务保留一个独立的等待命令。

主 agent 默认等待最终结果，不为例行汇报主动查询。你明确询问中间进展时，它才用 `observe` 查看当前快照，其中包含最近的工具活动和回答片段。任务完成后，`wait` 或 `result` 负责返回完整结果。

下图按时间顺序展示一次后台任务：主 agent 默认等待最终结果（或推进已明确的独立工作），仅在用户询问时查看进度，最后收取报告。

[![后台任务从委派到完成的过程：主 agent 等待或查看进度时，worker 持续保存 AGY 的输出，最终交付完整报告](assets/integration.png)](assets/integration.svg)

等待到期不会停止后台任务。任务本身有独立的执行时限，默认 60 分钟，可以在启动时用 `--timeout` 调整，最长 120 分钟。需要停止时使用 `cancel`；需要继续或重新开始时，由主 agent 根据你的要求调用 `continue` 或 `restart`。模型何时收到后台结果，仍由你使用的 agent 环境决定。

关于参数、权限、进度快照和恢复方式，可以查阅[完整参考手册](docs/REFERENCE.zh-CN.md)。各版本的改动记录在[发布说明](docs/releases/)中。

## 为其他 CLI 做一个

agy-crew 从 agy-staff 继承的设计是可移植（portable）的：只用 bash 和 skills，不强依赖特定的宿主、worker CLI 或运行时库。[docs/DESIGN.md](docs/DESIGN.md)（英文）把这套设计整理成了最佳实践。如果想为其他 agent CLI 做同类工具，可以把下面这段话交给你的 coding agent：

```
Read the raw text of https://raw.githubusercontent.com/pStrikeZ/agy-crew/master/docs/DESIGN.md
(curl it — do not work from a summary). Then design an integration that lets this host agent delegate
work to <CLI> the same way. First read `<CLI> --help`, map what the CLI supports to the section
"What depends on the worker CLI", and list the principles it cannot support before writing any code.
Ask me before any call that spends model quota. Respond in the user's language.
```

agent 动手写代码之前，会先列出你的 CLI 支持不了哪些原则，让你提前知道工具会在哪些地方降级。

## 升级与卸载

路线 A（npm）：

```bash
# 已安装的版本（以及 agy 的版本）
agy-crew version
# 升级
npm install -g agy-crew@latest && agy-crew install   # 之后重启 harness
# 卸载
agy-crew uninstall --all && npm uninstall -g agy-crew
```

如果是 `npm link` 的检出目录，运行 `git pull`，再运行 `agy-crew install` 刷新 bundle。

路线 A′（git clone）：

```bash
# 升级
git -C <clone> pull && node <clone>/companion/agy-companion.mjs install   # 之后重启 harness
# 卸载，然后删除 clone 目录
node <clone>/companion/agy-companion.mjs uninstall --all
```

`~/.agy-crew` 里保存着账号池的账号和 bundle，两种卸载都不会删除它；只有想彻底清掉账号时才手动删除。

路线 B：Claude Code 和 Codex 使用的是安装时复制到缓存中的插件。仓库发布新版本后，需要主动更新，并重启应用才能加载新的技能。

Claude Code 的更新命令是：

```bash
claude plugin marketplace update agy-crew && claude plugin update agy-crew@agy-crew
```

Codex 的更新命令是：

```bash
codex plugin marketplace upgrade && codex plugin add agy-crew@agy-crew
```

这两个环境都按版本号管理插件缓存。如果更新后仍然看到旧行为，请先确认是否已重启应用，再参考[升级说明](docs/REFERENCE.zh-CN.md#升级)检查版本和实际安装的提交。Pi 和 OpenCode 的更新方式见上方安装说明。卸载路线 B 的安装，请使用 harness 自带的插件管理器（Claude Code：`claude plugin uninstall agy-crew@agy-crew`）。

## 与 agy-staff 的关系

agy-crew 是 Keli Wen 的 [agy-staff](https://github.com/keli-wen/agy-staff) v0.7.4 的 fork，采用相同的 MIT 许可证。版本号延续 agy-staff 的历史（本 fork 从 0.8.0 开始）。

改动内容：全面重命名（插件 id `agy-crew@agy-crew`，仓库内状态目录 `.agy-crew/`，运行信息前缀 `[agy-crew]`，错误前缀 `agy-crew error:`）；新增终端命令和跨 harness 的 `install`（0.8.0），以及账号池（0.9.0）。上游的改动在适用时会继续合并进来。

agy-crew 与 agy-staff 不能共存：两者的技能都会出现在 agent 面前，并写入同一份仓库状态，因此发现 agy-staff 时，`agy-crew install` 会拒绝运行并说明如何移除。没有原地升级：先卸载 agy-staff，再安装 agy-crew；`.agy-staff/` 中的状态不会迁移。想换回上游，请先运行 `agy-crew uninstall --all`。详见 [LICENSE](LICENSE)、[NOTICE](NOTICE) 、[0.8.0](docs/releases/v0.8.0.md) 和 [0.9.0](docs/releases/v0.9.0.md) 发布说明。

## 参与贡献

欢迎通过 issue 或 PR 提出问题、分享使用经验或改进代码。新增模式或参数会影响对外接口，建议先开 issue 讨论预期行为。

提交代码前请运行 `npm test`。标准测试使用临时仓库、临时 HOME 和假的 agy，不会调用真实模型或改动你的个人配置。新增回归测试也应保持这一点。需要验证真实 AGY 时，请使用[测试说明](tests/README.md)中单独启用的集成测试。

运行逻辑位于 `companion/`：入口负责模式和任务命令，独立模块负责流式执行、进度快照、状态锁、产品标识（`identity.mjs`）、跨 harness 安装器（`install.mjs`）和账号池（`accounts.mjs`、`pool/`）。角色技能位于 `skills/`，共享的提示词模板位于 `templates/`。修改技能时请以 `skills/` 为准，再运行 `npm run generate:skills` 生成 `pi-skills/` 与 `opencode-skills/`，用 `npm run check:skills` 检查一致性。不要直接编辑生成文件；原有 `generate:pi` 和 `check:pi` 命令仍然可用。打包时使用 `npm run pack:checked`，先检查一致性再生成归档；发布前也会自动检查。

README 和参考手册都有中英文版本。修改使用方法或行为说明时，请同步更新对应版本，让两种语言的读者得到一致的信息。

### 发版

版本由 [Release 工作流](.github/workflows/release.yml) 通过 npm 的 Trusted Publishing 发布：由 GitHub 的 OIDC 身份证明构建来源，任何地方都不保存 npm token，每个版本都带来源证明（provenance）。

1. 修改 `package.json`、`.claude-plugin/plugin.json` 和 `.codex-plugin/plugin.json` 里的版本号，并新增 `docs/releases/vX.Y.Z.md`。
2. 提交后打 tag 并推送：`git tag vX.Y.Z && git push origin master vX.Y.Z`。
3. 工作流会检查 tag 与各处版本号一致、发布说明存在，运行 `check:skills` 和测试，然后发布到 npm（带 `-` 后缀的预发布版本进入 `next` 标签），再用发布说明创建 GitHub Release。已在 npm 上的版本会跳过发布，因此重跑是安全的；也可以用 `workflow_dispatch` 对已有 tag 重跑。

fork 或新维护者的一次性准备：在仓库里启用 Actions；手动发布第一个版本（`npm publish`，npm 只允许给已存在的包配置受信任发布者；npm 可能先把这次上传暂存起来，只显示一个 `0.0.0-stage` 占位版本，需要在 npmjs.com 上批准后才正式发布）；然后在 npmjs.com 的包设置里添加 GitHub Actions 类型的受信任发布者，填写本仓库和工作流文件 `release.yml`，并在发布权限里选择要求双重验证、禁止使用 token。

## 许可证

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。原始版权归 Keli (pkuwkl)，fork 的改动由 pStrikeZ 完成。
