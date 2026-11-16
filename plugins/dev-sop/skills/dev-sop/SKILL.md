---
name: dev-sop
description: Spec-driven development gate for ANY new feature or project build request, to be followed BEFORE writing any code or editing any business-logic file. Use whenever the user asks to build, create, implement, add, or develop a new feature, app, tool, script, or service — this skill drives the full spec-driven workflow: requirements clarification interview (AskUserQuestion), web research with sources, an approved spec document under docs/specs/, and TDD implementation with adversarial self-review. This is the mandatory planning gate enforced by the dev-sop PreToolUse hook; it also resolves blocking hooks caused by "no approved spec" and is the right entry point for spec-driven development, requirements clarification, and planning-gate requests.
---

# dev-sop：规格驱动的开发门禁

新功能 / 新项目开发的强制顺序门禁：需求澄清 → 联网调研 → 规格审批 → 任务书 → TDD 实现 → 量化验收 → 独立审查。本文只保留流程骨架与硬规则，**全部实施细则在 `references/stages-detail.md`**（下称"细则"，按节引用）；UI 设计规范见 `references/design-rules.md`，测试纪律见 `references/testing-rules.md`（均位于 dev-sop 插件安装目录）。

## 核心原则

**不做完前置阶段，绝不开始写业务代码。** 门禁由钩子强制：无 approved spec（或 v1.4.0 approved 变更单）时 `hooks/gate.js` 拦截业务文件写入，并拦截未引用 spec/任务书/变更单路径的 Agent 委派。

五把硬钥匙（任一步没完成，对应文件写不了、任务结束不了）：

| 钥匙 | 位置 | 解锁 |
| --- | --- | --- |
| `status: approved` | spec frontmatter | 业务代码文件的写入（Write/Edit/ApplyPatch） |
| `wireframe: approved` | spec frontmatter | UI 文件（.html/.css/.vue/.jsx/.tsx 及 LVGL .c 等）的写入 |
| `<slug>.ui-report.json` | docs/specs/ | UI 任务的交付（Stop 钩子校验全部 error=0） |
| `<slug>.test-report.json` | docs/specs/ | 代码任务的交付（Stop 钩子校验 records 全 pass、failed=0） |
| `<slug>.review-report.json` | docs/specs/ | `review: required` 任务的交付（Stop 钩子校验 verdict 为 pass 或 pass-with-issues） |

## 七阶段流程

### 阶段 0：触发判断与分级路由（v1.4.0）

收到开发需求先分级路由：**S 快速通道**（≤2 文件、净变更<30 行、无新建文件、无接口/依赖/配置变更、不涉 UI/LVGL——单问批准+变更单 `docs/changes/<slug>.md` 免任务书快审）／**M 精简四步**（单项目内功能调整，变更单加长版+单条 test-report）／**L 全量流程**（新功能/新项目/任何 UI 或 LVGL 界面变更/跨模块）；判据不含 UI 文件，涉 UI 一律 ≥M 线框或 L。路由表与 0S/0M 流程：stages-detail.md 第 1 节。用户明确要求"直接改"或仅小修小改（改文案 / typo / 常量）可跳过，项目根 `.dev-sop-skip` 临时解锁门禁；判定不清时优先按本流程处理。

### 阶段 1：需求澄清访谈（调研与访谈并行）

用 AskUserQuestion 分至少 2 批（每批≤4问）覆盖六大维度（场景 / 功能清单 / 界面外观与交互 / 非功能 / 边界 / 验收标准），**不许臆测任何未确认的需求**；第一批答复后同轮先发 WebSearch 再发第二批（调研与访谈并行）；访谈后整理结构化需求列表交用户最终确认。关键约束：外观与功能未被描述清楚前不得进入阶段 2。细则：stages-detail.md 第 2 节。

### 阶段 2：联网调研

用 WebSearch/WebFetch 查证成熟案例与交互惯例、技术选型当前最佳实践、官方文档；所有关键结论必须附来源链接，区分文档结论与社区观点，不确定信息标注待验证。细则：stages-detail.md 第 3 节。

### 阶段 3：产出规格文档（用 spec-templates 骨架）

写 `docs/specs/<slug>.md`（frontmatter 必须第 1 行起：status/slug/date/review；批准前必填 `code-files`（纯 UI 任务用 `ui-files`，二者至少其一），纯文档任务写 `code-files: none`）：先按任务类型复制 `references/spec-templates/` 对应模板（cli-tool / web-ui / lvgl）再填充，禁止现编结构；正文五要素：需求规格 / 调研结论与来源 / 技术方案 / 测试计划(TDD) / 验收 checklist；用户批准后 `status: draft` → `status: approved` 解锁代码门禁。细则：stages-detail.md 第 4 节；呈现与批准方式见第 10 节。

### 阶段 3.2：UI 规格（任务涉及界面时必做）

先读 `references/design-rules.md`；spec 补 UI 数据表（屏幕规格/布局策略/组件清单表）+ ASCII 线框图，frontmatter 声明 `ui-files`；线框必须用独立 AskUserQuestion（preview 展示至少 2 个方案）获用户批准后加 `wireframe: approved`，才能解锁 UI 文件门禁（与 status 独立）。细则：stages-detail.md 第 5 节。

### 阶段 3.5：任务书（spec 批准后、委派 code-worker 前必做）

产出 `docs/tasks/<slug>.md`：目标文件清单、期望行为、验收标准、测试要求、**五列验收测试计划表**（验收标准/测试层级/命令/预期输出/预计耗时，表外测试禁止执行）、参考；委派 prompt 必须显式写明任务书与 spec 的相对路径，且不含技术决策类问题。细则：stages-detail.md 第 6 节；表格模板见第 11 节。

### 阶段 4：TDD 实现 + 自审（量化验收自动闭环，≤5轮/10min）

先写测试（test 路径在白名单内）确认因功能缺失而失败，再实现到全绿；完成后对抗性自审（逻辑 bug / 性能 / 安全 / 规格符合度），发现问题先修再报；交付前按测试计划表逐条执行并产出 `docs/specs/<slug>.test-report.json`（records 全 pass、failed=0）；UI/LVGL 量化验收按单次委派合同**自动闭环**（≤5轮/10min 硬限、--out 落盘、主会话只复核 JSON，合同见第 5 节）。细则：stages-detail.md 第 7 节。

### 阶段 4.5：独立代码审查（reviewer，审查与量化闭环并行，增量主会话快检）

实现完成后**同一条消息**并发两个 Agent 调用——全新 reviewer 子代理（`agents/reviewer.md`：独立上下文、只读、四维审查、同判定规则，审查输入=委派时冻结的初版改动清单）+ 量化闭环，**不得**主会话自任或 code-worker 自审代替。闭环回报后主会话快检增量 diff：仅 P0/P1 追加一轮增量快审（仅增量），P2 记 backlog。委派 prompt 必须提供：任务书路径、规格路径、**改动文件清单、diff 获取方式**（`git diff HEAD~1..HEAD`，或主会话指明 range；首次提交（无上一提交）用 `git diff --no-index` 或直接附改动清单与内容）、报告输出路径 `docs/specs/<slug>.review-report.json`。verdict 判定：任一 P0 或 P1≥3 → fail（整理问题清单委派 code-worker 修复后重审，最多 2 轮，仍 fail 如实呈报用户仲裁，禁止推荐跳过）；仅 P2 或 P1≤2 → pass-with-issues（AskUserQuestion 呈报问题清单，用户确认后定稿）；全清 → pass。`review: required` 的 spec 由 Stop 钩子强制校验报告存在且 verdict 合规。细则：stages-detail.md 第 8 节。

## 决策层 / 执行层分离

主会话是决策层，只做需求分析、任务拆解、指令下达与结果验收；**一切文件编辑**（代码、文档、配置）通过 Agent 工具委派 code-worker 执行，指令必须写明目标文件、期望行为、验收标准，不让其自行技术决策；code-worker 阻塞汇报时主会话须先亲自分析原因再下明确指令，不得只说"继续重试"。白名单路径（`docs/specs/`、test 路径、`*.test.*`、`package.json` 等）与委派门禁/文件门禁分工：细则见 stages-detail.md 第 9 节。

## 执行代理

内置 `dev-sop:code-worker`（`agents/code-worker.md`）：禁用思考、只执行不决策、默认继承会话模型；如需专属模型，复制到 `~/.zcode/agents/code-worker.md` 并在 frontmatter 加 `model: <providerId/modelId>` 行，用户级同名定义优先。详见 stages-detail.md 第 9 节。

## 硬规则

- **呈现与批准**：规格与线框在请求批准前必须把全文完整呈现在回复中（可分节展示并附路径）；批准必须用 AskUserQuestion 选项完成（批准/需修改/放弃），禁止手动输入确认；线框选项必须用 preview 展示 ASCII 图。细则见第 10 节。
- **测试纪律**：单命令≤2 分钟（显式设 ≤120000ms timeout）、整场≤10 分钟、fail-fast 不重跑已绿、迭代只跑受影响测试、禁止后台/监听模式；任务书测试计划表之外的测试禁止执行（`hooks/test-guard.js` 强制）。细则见第 7 节与 `references/testing-rules.md`。
- **独立审查**：`review: required` 任务必须产出 `review-report.json` 且 verdict 为 pass 或 pass-with-issues（后者经用户确认）方可交付，Stop 钩子强制校验。细则见第 8 节。
- **冲突处理**：门禁拦截与流程要求冲突（如死锁）时，如实报告冲突详情并等待指示，禁止把"跳过流程"作为推荐选项；`.dev-sop-skip` 仅在用户明确要求时创建。

## 被门禁拦截时

- 收到"没有已批准的规格文档"→ 回到阶段 1 推进；用户明确要求跳过时提示创建 `.dev-sop-skip`（完成后删除恢复门禁）。
- 收到"委派任务前请先走 /spec 流程"→ prompt 补引 `docs/specs/*.md`、`docs/tasks/*.md` 或 `docs/changes/*.md` 路径后重新委派。
- 排查门禁误拦/未触发：看执行日志 `~/.zcode/hooks/dev-sop.log`（UserPromptSubmit 注入 v1.2.0 起 decision=inject-full/inject-reminder/inject/pass）。细则：stages-detail.md 第 12 节。
