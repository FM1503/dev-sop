# dev-sop：开发 SOP 门禁（v1.12.0）

让 AI 像专业工程师一样先问清需求、查证方案、线框确认、量化验收，再动代码。v1.4.0 起引入**变更分级路由**：流程重量与风险成正比——S 快速通道（单问批准+变更单）／M 精简四步／L 全量流程，判据与流程见 `references/stages-detail.md` 第 1 节。v1.5.0 起引入**执行书硬门禁**：编码类 Agent 委派必须附主会话亲自勘探（Read/Grep）产出的执行书 `docs/tasks/<slug>-exec.md`（文本级精确 old→new + 每步验证命令与预期输出；S 级并入变更单改动清单），code-worker 零思考纯执行、不匹配即停报；非编码任务或用户明确豁免标 `exec-plan: exempt`。v1.6.0 起实现委派**单轮三步**（worker 同一轮完成落盘执行书+机械应用+验证，不再拆"写单/执行"两轮），S 级**快审瘦身**（采信执行回报、不复跑测试），冒烟与快审同时间片**并行**。v1.7.0 起**补丁直改**：主会话勘探后生成确定性补丁脚本（前置/后置断言，失败即 exit 1 打印 ±3 行上下文）嵌入执行书，code-worker 一条 Bash 原样执行"执行命令"——把"改文件"从 LLM 手里拿走（worker 段 <40s）；`patch-mode: edit` 备选走定向 Read+最短唯一锚点；`gate.js` 同步新增 Bash 写模式检测（`echo >`/`sed -i`/`tee`/`git apply` 写代码文件同样过门禁）。v1.10.0 起**审查提速**：review-lint 升格为机器硬门禁（`--out` 产出 `<slug>.lint-report.json`，violations=0 才能进审查链，accept 标记不可豁免；新增 exec-missing / test-cmd-empty / lint-stale 三条规则），AI 审按风险分级（**S 级 lint 结案免审 / M 级快审 diff-only、工具预算 ≤10、不复跑测试 / L 级全审**），用户验收标记 `<slug>-accept.md` 成为一等结案路径。v1.11.0 起**跨会话上下文账本**：项目 docs/context/ 五卡账本（INDEX/ACTIVE/DECISIONS/CODEMAP/GOTCHAS），新会话首轮只注入索引（≤1.5KB、独立账本闩锁、非开发意图也注入），卡片按需读取；docs/context/ 入 gate 白名单主会话直写，代码写入触点 + Stop 软门禁催落盘一次；无账本项目行为与 v1.10.3 逐字节一致（回归测试锁定）。

## 解决什么问题

- **盲目臆测需求**：用户一句话需求，AI 直接开写，做出来的不是用户想要的。
- **跳过设计直接写码**：没有规格文档，改动无据可查，验收各说各话。
- **UI 坐标布局错乱**：绝对坐标硬编码，换视口即错位、重叠、不可点击。
- **无验收凭感觉**：没有量化验收标准，"看起来没问题"就交付。

## 核心机制：五把硬钥匙

门禁由 PreToolUse / Stop 钩子强制执行，任何一步没完成，对应文件根本写不了、任务结束不了：

| 钥匙 | 位置 | 解锁 |
| --- | --- | --- |
| `status: approved` | spec frontmatter | 业务代码文件的写入（Write/Edit/ApplyPatch） |
| `wireframe: approved` | spec frontmatter | UI 文件（.html/.css/.vue/.jsx/.tsx 及 LVGL .c 等）的写入 |
| `<slug>.ui-report.json` | docs/specs/ | UI 任务的交付（Stop 钩子校验全部 error=0） |
| `<slug>.test-report.json` | docs/specs/ | 代码任务的交付（Stop 钩子校验 records 全 pass、failed=0） |
| `<slug>.review-report.json` | docs/specs/ | `review: required` 任务的交付（Stop 钩子校验 verdict 为 pass 或 pass-with-issues，后者须经用户呈报确认定稿；fail/缺失/非法 JSON 阻断） |

配合三道软机制：

- **每轮上下文注入**（`hooks/inject.js`）：检测到开发意图的提示词时，自动注入七阶段流程提醒；v1.2.0 起带会话级注入闩锁——同一会话首轮注入全文，次轮起仅注入一行提醒（闩锁文件 `~/.zcode/hooks/dev-sop-inject-<sessionId>.latch`，48h 自动清理），显著节流。
- **执行代理**（`agents/code-worker.md`）：主会话只决策，编码一律委派给禁用思考、只执行不决策的 code-worker 子代理。
- **独立审查**（`agents/reviewer.md`）：实现完成后进入审查（审查与量化验收闭环可并行执行，见 SKILL 阶段 4.5），委派独立上下文、只读的 reviewer 子代理**只审本次 diff**，产出 `review-report.json`（fail 时修复重审最多 2 轮；pass-with-issues 经向用户呈报确认后定稿）。

## 七阶段工作流程

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────┐   ┌──────────┐   ┌────────────────┐
│ 1 需求澄清 │ → │ 2 联网调研 │ → │ 3 规格文档    │ → │ 3.2 UI数据表+  │ → │ 3.5 任务书 │ → │ 4 TDD 实现 │ → │ 5 量化验收      │
│   访谈    │   │          │   │ 全文呈现      │   │    线框        │   │          │   │          │   │  + 对抗自审     │
│  (≥2批)   │   │ 附来源链接 │   │ + 选项批准    │   │ (preview 选择) │   │          │   │          │   │                │
└──────────┘   └──────────┘   └──────────────┘   └────────────────┘   └──────────┘   └──────────┘   └────────────────┘
```

> v1.3.0 提效：阶段 1 内**调研与访谈并行**（首批答复后同轮先发 WebSearch）；阶段 5 量化验收改为**单次委派自动闭环**（采集→分析→修复→复测，≤5 轮 / 10 分钟硬限，主会话只复核报告 JSON）；阶段 5 与独立审查**同消息并发**，闭环增量由主会话快检（仅 P0/P1 追加增量快审，P2 记 backlog）。
>
> v1.10.0 审查提速：实现完成 → 主会话先跑 `node scripts/review-lint.mjs <变更单/spec> --out docs/specs/<slug>.lint-report.json` **机器项清零** → 按级别结案：**S 级 lint 即结案**（免 AI 审）／**M 级与 L 级统一 diff 审查**；M 与 L 也可由用户验收标记 `<slug>-accept.md` 直接结案（accept 不豁免机器项）。
>
> v1.12.0 reviewer 整改：reviewer 只审本次 diff（不跑测试、不起服务、不开浏览器，预算 ≤12 次工具调用，`thoughtLevel: high`，工具仅 Read/Write/Bash），只报写得出触发条件与错误后果的 P0/P1；主会话委派 prompt 固定五项（取 diff 的方式、改动文件清单、变更单/任务书路径、报告输出路径、≤3 条关注点），正文 >1500 字或条目 >10 由 gate 拒绝。背景：118 次运行实测，委派清单 >3000 字时平均 41 次工具调用 / 13.7 分钟，<1500 字时 17 次 / 6 分钟。

## 组件清单

| 组件 | 作用 |
| --- | --- |
| `hooks/gate.js` | PreToolUse 门禁：无 approved spec（或 v1.4.0 approved 变更单 `docs/changes/*.md`）拦截文件写入，无 wireframe 批准拦截 UI 文件，未引用 spec/任务书/变更单路径拦截 Agent 委派；v1.5.0 起编码类委派还须引用执行书 `docs/tasks/<slug>-exec.md`（或变更单路径）或标 `exec-plan: exempt`（独立成行），否则拦截；验收类委派（review/ui/test-report 输出）自动豁免执行书（v1.5.1）；v1.7.0 起新增 Bash 写模式检测（`echo >`/`sed -i`/`tee`/`patch`/`git apply` 写代码文件同样过门禁，疑似写入（含无法解析目标）一律按完整文件门禁校验（fail-closed），放行仅当门禁通过） |
| `hooks/inject.js` | UserPromptSubmit 注入：检测到开发意图时把流程纪律（v1.4.0 起十一条，含第 11 条分级路由；v1.5.0 第 5 条含勘探义务+执行书+豁免标记）注入上下文；同会话闩锁去重（首轮全文、次轮一行提醒，详见上文注入闩锁机制） |
| `hooks/accept-check.js` | Stop 门禁：UI 任务必须产出 ui-report.json 且全部 error=0；代码任务必须产出 test-report.json 且全部 pass；v1.10.0 分级审查链——`review: required` 任务与 tier S/M 变更单先过 lint 硬前置（`<slug>.lint-report.json` violations=0，accept 不可豁免），再按级别结案：S 级 lint 干净即结案（lite-reviewed-by-lint）/ M 级快审报告或 accept 标记 / L 级全审报告或 accept 标记（fast-review / full-review / user-accepted，四态记入日志）；连续 5 个 S 级附合并评估提醒 |
| `scripts/review-lint.mjs` | 机器预检（v1.8.0，v1.10.0 升格硬门禁）：fileset / linecap / placeholder / verify + exec-missing（无任何执行证据：exec 文档/变更单/test-report 三者皆无）/ test-cmd-empty（test-report 命令为空）/ lint-stale（v1.10.3：报告 `generatedAt` 早于代码文件修改 → warning，重跑即清零）；`--out` **覆盖写** `<slug>.lint-report.json`（`{producedBy,slug,generatedAt,violations,warnings}`，每次整体替换；v1.10.3 写入来源戳 `producedBy:"review-lint"` 并由 accept-check 校验，缺失视为可疑需重跑；v1.10.2 规则分域：spec 只跑 exec-missing/test-cmd-empty/lint-stale，变更单另跑 fileset/linecap/verify/placeholder） |
| `hooks/ui-collect.js` | 浏览器内 eval 采集页面几何数据（多视口）为 JSON |
| `hooks/ui-analyzer.mjs` | 量化分析几何 JSON：越界/重叠/44px 点击区/对比度等，生成 ui-report.json |
| `hooks/lvgl-check.mjs` | LVGL C 源码静态量化校验，生成同一格式的 ui-report.json |
| `scripts/wpf-check.mjs` | WPF XAML 静态量化审查（v1.9.0）：Canvas 重叠/越界/资源引用缺失/低对比度/硬编码尺寸占比等 error+warning 规则，支持 `--out` 生成 ui-report 通用格式 |
| `hooks/test-guard.js` | PreToolUse on Bash 门禁：测试命令单条 ≤2 分钟、禁止后台/监听模式长跑（`references/testing-rules.md` 的强制执行器） |
| `references/testing-rules.md` | 内置测试纪律：测试金字塔分层、耗时硬预算、fail-fast、受影响测试选择、反冗余 |
| `references/stages-detail.md` | 七阶段完整实施细则（v1.2.0）：SKILL 正文只留流程骨架，各阶段细则逐节下沉于此，按需查阅 |
| `references/design-rules.md` | 内置设计规范：硬校验量化规则与软指导（Flex/Grid 优先等） |
| `references/spec-templates/` | 五类骨架模板（cli-tool / web-ui / lvgl / mixed-stack + v1.10.0 accept 验收标记，v1.3.0/v1.9.0/v1.10.0）：阶段 3 按任务类型复制到 `docs/specs/<slug>.md` 再填充，禁止现编结构；`accept.md` 为用户验收标记 `<slug>-accept.md` 模板（accepted: true / slug / date / quoted） |
| `references/spec-templates/change-lite.md` | S/M 变更单骨架（v1.4.0）：阶段 0S/0M 复制到 `docs/changes/<slug>.md`，frontmatter slug/status: approved/date/tier: S/changed-files + 正文四行（改什么/为什么/影响面/回滚方式），M 可加长含验收 checklist |
| `references/spec-templates/exec-plan.md` | 执行书骨架（v1.5.0）：阶段 3.6 主会话亲自勘探（Read/Grep）后复制到 `docs/tasks/<slug>-exec.md`，含"改动清单"表（文本级精确 old→new）与"执行顺序与验证"表（每步命令+精确预期输出）；S 级并入变更单改动清单表；v1.7.0 起新增"补丁脚本+执行命令"两节（补丁直改默认，worker 一条 Bash 原样执行）与"定位行号"列（patch-mode: edit 备选） |
| `agents/code-worker.md` | 执行代理定义：禁用思考、只执行不决策，是唯一写代码的角色；v1.5.0 新增执行书模式（逐条按序应用+每步验证比对、三禁止、不匹配即停报、无书拒执行）；v1.7.0 新增补丁直改模式（一条 Bash 原样执行执行命令，禁止改写/拆分/手工复刻；5 行回报） |
| `agents/reviewer.md` | 审查代理定义（v1.12.0）：独立上下文、只读（唯一可写 review-report.json），只审本次 diff——不跑测试、不起服务、不开浏览器，工具调用预算 ≤12，只报写得出触发条件与错误后果的 P0/P1（风格类不报，P2 ≤3 条）；`thoughtLevel: high`、工具仅 Read/Write/Bash（如需改档位或模型：复制到 ~/.zcode/agents/reviewer.md 改 frontmatter，用户级同名定义优先）；S 级默认免 AI 审 |
| `commands/spec.md` | `/spec` 命令：手动进入规格驱动流程的入口 |
| `skills/dev-sop/SKILL.md` | 七阶段流程骨架说明书（技能入口；细则在 `references/stages-detail.md`） |

## 逃生阀与边界

- **`.dev-sop-skip`**：项目根创建该文件即临时跳过全部门禁；仅当用户明确要求时使用，事后删除恢复门禁。旧版标记文件 `.spec-gate-skip` / `.spec-gate-approve-longtest` 仍被钩子回退兼容（优先识别新名）。
- **白名单路径**：`docs/specs/`、`docs/tasks/`、路径含 `test/tests/__tests__` 的文件、`*.test.*`、`*.spec.*`、`package.json`、`.gitignore`、`README.md` 无需 spec 即可写。
- **fail-open**：钩子自身出错（如 stdin 解析失败）时放行并记日志，保证不因插件故障卡死开发。
- **wpf-check 颜色边界**：十六进制色支持 3/4/6/8 位形态（`#RGB`/`#ARGB`/`#RRGGBB`/`#AARRGGBB`）；短色每位复制一位展开为全位后再计算亮度对比度。

## 可观测性

每次钩子调用向 `~/.zcode/hooks/dev-sop.log` 追加一行（ISO 时间、事件、工具、目标、决策、原因）。门禁误拦或未触发时，先看该日志。

## 安装与使用

- **使用 `/spec` 命令**，或直接提出开发需求（如"帮我做一个 todo 应用"）——inject 钩子会自动注入流程提醒，按七阶段推进即可。
- **自定义 worker 模型**：将 `agents/code-worker.md` 复制到 `~/.zcode/agents/code-worker.md`，在 frontmatter 中添加 `model: <providerId/modelId>` 行；用户级同名定义优先于插件内置定义。
- **放行 reviewer 代理**：若用户级工作流规则限制了可委派的子代理类型，需自行放行插件内置的只读审查代理 `dev-sop:reviewer`，否则阶段 4.5 独立审查无法委派。

## 更新日志

每次发版的完整变更见仓库根 [CHANGELOG.md](../../CHANGELOG.md)

License: GPL-3.0
