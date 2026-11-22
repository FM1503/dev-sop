# dev-sop 阶段细则（stages-detail）

本文件承载 `skills/dev-sop/SKILL.md` 七阶段流程的全部实施细则（SKILL 正文仅保留流程骨架，逐阶段指向本文件对应节）。位于 dev-sop 插件安装目录 `references/` 下。

**目录**

1. 阶段 0：触发判断与分级路由（含阶段 0S 快速通道 / 阶段 0M 精简四步）
2. 阶段 1：需求澄清访谈
3. 阶段 2：联网调研
4. 阶段 3：产出规格文档
5. 阶段 3.2：UI 规格（任务涉及界面时必做）
6. 阶段 3.5：任务书（spec 批准之后、委派 code-worker 之前）
6.5. 阶段 3.6：执行书（任务书之后、委派编码之前，v1.5.0）
7. 阶段 4：TDD 实现 + 自审
8. 阶段 4.5：分级审查（lint 机器门禁 + 按风险分级 + 用户验收标记，v1.10.0）
9. 决策层 / 执行层分离与执行代理
10. 呈现与批准规范
11. 测试计划表模板（五列）
12. 附录：核心原则细则、被门禁拦截时、执行日志

---

## 第 1 节：阶段 0 触发判断与分级路由

- 用户提出**新功能 / 新项目开发需求**时，进入本流程。
- 如果用户明确要求"直接改"、"别走流程"，或者只是**小修小改**（改文案、修一个明显的 typo、调整一个常量），可以跳过本流程，并告知用户：可在项目根创建 `.dev-sop-skip` 文件临时解锁门禁。
- 判定不清时，优先按本流程处理，并向用户说明原因。

### 1.1 阶段 0 分级路由（v1.4.0：流程重量与风险成正比）

收到开发需求后，主会话先按下表判据定级，再进入对应通道；**分级由主会话声明 + reviewer 校验双重把关**：

| 级别 | 判据 | 通道 |
| --- | --- | --- |
| **S** | ≤2 文件、净变更<30 行、无新建文件、无接口/依赖/配置变更、不含 .html/.css/.vue/.jsx/.tsx/ui/*.js/lvgl 相关 .c | 阶段 0S 快速通道（见 1.2） |
| **M** | 单项目内功能调整（不满足 S 且非新功能/新项目/UI 新界面） | 阶段 0M 精简四步（见 1.3） |
| **L** | 新功能/新项目/任何 UI 或 LVGL 界面变更/跨模块——现行全量 SOP 不变 | 阶段 1 起全量流程（本文件第 2 节起） |

- **判据不含 UI 文件**：涉 UI（含任何界面/LVGL/布局绘制）一律 ≥M 线框（M 仅限非 UI 前提下的功能调整）或 L 全量。
- S/M **不替代 L 级 spec**：变更单只解锁对应级别；随时可升级为 L 走全量。
- **防滥用**：reviewer 审查输入含变更单时校验 tier 合规（超判据记 P1"要求升级流程"，见第 8 节与 `agents/reviewer.md`）；Stop 钩子检测 mtime 最近 5 个变更单全为 tier S 时，在放行日志与（若有 block 时）reason 中附提醒"连续 5 个 S 级，考虑合并为 M/L 评估"。

### 1.2 阶段 0S 快速通道（S 级，八步）

前置：已按 1.1 判据自评为 S。**豁免**：调研 / 线框 / 量化验收 / 任务书 / test-report（测试结果记入审查报告 summary.checked）/ ui-report。

1. **判据自评**（主会话）：对照 1.1 路由表逐条核对（≤2 文件、净变更<30 行、无新建文件、无接口/依赖/配置变更、无 UI/LVGL 文件）。
2. **AskUserQuestion 单问**：改动方案一句话 + 影响面 + 选项（批准 / 拒绝 / 改走全流程）。
3. **拟变更单**：按 `references/spec-templates/change-lite.md` 骨架拟出变更单全文（目标路径 `docs/changes/<slug>.md`，该路径在白名单内），frontmatter 含 slug / `status: approved`（事前单问已批）/ date / `tier: S` / `changed-files: <逗号清单>`；正文结构（v1.5.1 统一）：**改动清单表（文本级精确 old→new，同 exec-plan 模板）** + 影响面/回滚各一行（四行骨架：改什么/为什么/影响面/回滚方式，其中改动清单表为必含项）——变更单内容随第 4 步委派 prompt 逐字带出，不再单独委派落盘。
4. **委派 code-worker（单轮三步，v1.8.0 编译直改）**：prompt 引用变更单路径并逐字附变更单全文（满足 Agent 委派门禁与执行书门禁——变更单正文须含**变更表**（change-lite 表格驱动：序号/文件/行号/锚点/旧行数/新内容 + `<NEWFILE>`/`<NL>` 约定 + expect_after + 验证字段，见第 6.5 节；勘探可先委派 prospector 并行取锚点表，主会话基于表填变更表并裁决），S 级不再另建独立执行书），worker 同一轮完成 ①落盘变更单 ②`node scripts/compile-change.mjs docs/changes/<slug>.md | python -`（执行书=编译产物 docs/tasks/<slug>-exec.md，一条管道机械应用、锚点零转录）③运行验证命令并回报输出（见第 5 节单轮三步；禁止拆分为"写单"与"执行"两轮，停报纪律不变），**免任务书**；**编译失败 fallback `patch-mode: edit`**（定位行号+最短唯一锚点+定向 Read 禁全文件读入）。
5. **修完跑受影响测试**（若有）：只跑受影响测试，测试纪律（单命令≤2 分钟等）沿用。
6. **reviewer diff 快审**：输入含变更单；**新增校验维度：tier 合规——超 S 判据即 P1"要求升级流程"**（四维审查照常）。S 级快审不复跑测试：采信执行回报的测试输出摘要，审查限于静态 diff、清单符合度、tier 合规、断言强度抽查（读测试代码不复跑）；M/L 不变。**冒烟∥快审（v1.6.0）**：快审与主会话只读冒烟同时间片并行发起，结果合并呈报。**v1.10.0 起 S 级默认由 lint 结案**（8.1：主会话先跑 review-lint --out 且 violations=0 即结案，reason=lite-reviewed-by-lint，免委派 reviewer；仅主会话显式要求快审时才按下条执行）。
7. **报告**：`docs/changes/<slug>.review-report.json`（结构同第 8 节；测试结果记入 summary.checked；不复用 docs/specs/ 路径）。verdict 判定规则与修复循环（fail 修复重审最多 2 轮）同第 8 节。
8. **呈报定稿**：verdict 为 pass 或 pass-with-issues 时，AskUserQuestion 向用户呈报定稿（同第 8 节第 6 步）。

门禁联动：变更单 `status: approved` 后，`hooks/gate.js` 即放行业务文件写入（reason: approved change note found）；交付时 `hooks/accept-check.js` 校验 `docs/changes/<slug>.review-report.json` 存在且 verdict∈{pass, pass-with-issues}（S 级免 test-report）。

### 1.3 阶段 0M 精简四步（M 级）

前置：按 1.1 判据不满足 S 且非新功能/新项目/UI 新界面（非 UI 前提）。**豁免**：调研 / 线框（非 UI 前提）/ 量化闭环 / 任务书独立文档。

1. **1 批澄清（≤3 问）**：AskUserQuestion 一次批次覆盖目标行为、影响面、验收要点。
2. **变更单加长版 + 单问批准**：复制 `change-lite.md` 骨架到 `docs/changes/<slug>.md`，可加长至 15 行（改动清单表行数不计入），须含**验收标准 3-5 条清单**（`- [ ]` 形式）；frontmatter `tier: M` / `status: approved`（单问批准后写入）。
3. **实现 + 受影响测试（单轮三步，v1.8.0 编译直改）**：委派 code-worker（prompt 引用变更单路径并逐字附变更表全文——变更表用 change-lite 模板（序号/文件/行号/锚点/旧行数/新内容 + `<NEWFILE>`/`<NL>` 约定 + expect_after + 验证字段，见第 6.5 节；勘探可先委派 prospector 并行取锚点表），worker 同一轮完成 ①落盘变更单 ②`node scripts/compile-change.mjs docs/changes/<slug>.md | python -`（执行书=编译产物 docs/tasks/<slug>-exec.md）③运行验证命令并回报输出（见第 5 节单轮三步；禁止拆分为"写单"与"执行"两轮，停报纪律不变）；**编译失败 fallback `patch-mode: edit`**（定位行号+最短唯一锚点+定向 Read 禁全文件读入）；M 级实现委派同样满足执行书门禁——变更单含变更表即可，或另附编译产物执行书 `docs/tasks/<slug>-exec.md`）；修完跑受影响测试并产出**单条 test-report**：`docs/changes/<slug>.test-report.json`（结构同第 7 节：records≥1、每条 result=pass、summary.failed=0）。
4. **reviewer 快审 + 呈报**：同 0S 第 6-8 步（tier 合规校验按 M 判据：单项目内功能调整；**冒烟∥快审（v1.6.0）**：快审与主会话只读冒烟同时间片并行发起，结果合并呈报）；报告 `docs/changes/<slug>.review-report.json`。

门禁联动：M 级交付时 `hooks/accept-check.js` 同时校验 review-report（verdict 合规）与 test-report（单条全 pass）。S/M 修复循环与并行约束沿用 L 级（第 8 节）。

### 1.4 阶段 0.7 缺陷定位（v1.9.0 混合栈跨层缺陷 SOP）

**触发**：缺陷修复类需求涉及 C# 服务层 / WPF 表现层 / LVGL 固件层混合栈（spec 模板 `references/spec-templates/mixed-stack.md`）；输入为现象描述，定位完成后按 1.1 进入分级路由。四步：

1. **读架构**：先读项目根 `docs/architecture.md`（层清单与每层定位工具指引，spec/缺陷排查必读约定；**无则先请用户确认生成一次**再继续）。
2. **按现象定层**：视觉错乱 → WPF 层跑 `scripts/wpf-check.mjs`（.xaml）/ LVGL 层跑 `hooks/lvgl-check.mjs`（.c）；数据错 → C# 层跑 `dotnet test`；显示与数据不一致 → 查 spec 的"跨层数据流"表定位断点层。
3. **层内定位后按 tier 路由修复**：进入对应级别（S / M / L）的修复流程（按 1.1 路由表判据定级）。
4. **跨层回归**：修复后改任一层必须跑相邻层的验收命令（C# ↔ WPF ↔ LVGL），防止"修一层坏一层"。

## 第 2 节：阶段 1 需求澄清访谈

**不许臆测任何未确认的需求。** 凡是用户没有明确说过的，都必须问。

- 必须使用 `AskUserQuestion` 分批提问，**每批不超过 4 个问题**，按下面的维度覆盖（可多轮）：
  1. **目标用户与使用场景**：谁用、在什么场景下用、要解决什么问题。
  2. **核心功能清单**：必须有 / 最好有的功能，分别是什么。
  3. **界面外观与交互预期**：样式风格（如极简 / 拟物 / 深色）、布局结构、配色偏好、可参考的产品或截图。
  4. **非功能要求**：性能、运行平台（Web / 桌面 / 移动 / CLI）、语言、存储、依赖限制。
  5. **边界情况**：异常输入、空数据、大并发、离线、权限等如何处理。
  6. **验收标准**：什么算"做完了"，如何验证。
- **外观与功能未被描述清楚之前，不得进入阶段 2。**
- **调研∥访谈（v1.3.0 并行提效）**：第一批 AskUserQuestion 答复回来后，**同一轮**先发 1-2 个 WebSearch 查询（针对已答复内容中可调研的关键点），再发第二批提问——用调研请求覆盖用户思考第二批问题的时间，重叠两段等待；后续批次同理可穿插。该并行不改变阶段顺序约束：正式的调研结论与来源整理仍在阶段 2 完成。
- 访谈结束后，把全部问答整理成结构化**需求列表**，再交给用户做最终确认（可用 AskUserQuestion 或直接请用户回复确认）。

## 第 3 节：阶段 2 联网调研

在写规格前，用 `WebSearch` / `WebFetch` 查证：

- 该类软件的**成熟案例与交互惯例**（主流产品怎么做、有哪些约定俗成的交互）。
- **技术选型的当前最佳实践**（推荐什么框架 / 库 / 架构，及其取舍原因，注意时效性）。
- 相关**官方文档**（API、配置、版本兼容性）。

要求：**所有关键结论必须附来源链接**；区分"文档明确说明"与"社区观点"；对不确定的信息标注为待验证，不要编造链接。

## 第 4 节：阶段 3 产出规格文档

写入 `docs/specs/<slug>.md`（slug 为需求英文短名，如 `todo-app.md`）。该路径在白名单内，可直接写。

frontmatter 必须是（**必须位于文件第 1 行**，`---` 之前不得有标题或空行，否则门禁无法识别 status）：

```yaml
---
status: draft
slug: <slug>
date: <YYYY-MM-DD>
review: required
---
```

其中 `review: required` 为新项目默认值：交付前必须经独立代码审查（第 8 节，阶段 4.5）；纯文档/微小任务可改为 `review: exempt`，存量 spec 不写该字段则完全不受影响。

必填 frontmatter 字段（批准前必填；与 UI 任务的 `ui-files` 并列）：

- `code-files: <逗号分隔的项目相对路径>`：声明本次任务的目标代码文件（如 `code-files: src/app.js, src/utils.js`）。**批准前必填**：`status` 改为 `approved` 后，若既未声明 `code-files` 也未声明 `ui-files`，Stop 钩子（`hooks/accept-check.js`）会拦截交付并要求补声明。纯文档/调研任务显式写 `code-files: none`（值不区分大小写，视为已声明但无代码产出，跳过 test-report 要求）。声明代码文件后，若这些文件已实现，Stop 钩子会强制校验 `docs/specs/<slug>.test-report.json`（验收测试报告，见第 7 节）。

**模板选用（v1.3.0 起强制）**：写规格前，按任务类型从 dev-sop 插件安装目录 `references/spec-templates/` **复制对应骨架模板**到 `docs/specs/<slug>.md` 再填充——CLI / 脚本类用 `cli-tool.md`，Web 界面类用 `web-ui.md`，LVGL 嵌入式界面类用 `lvgl.md`，C#/WPF/LVGL 混合栈类用 `mixed-stack.md`。模板已内置 frontmatter 字段、章节骨架、五列测试计划表头（web-ui 另含 UI 数据表与 ASCII 线框占位，lvgl 含屏幕规格与布局策略占位），**禁止现编 spec 结构**；模板未覆盖的内容在对应章节内追加，不另立章节结构。

正文必须包含：

1. **需求规格**：阶段 1 中用户确认过的内容（原文照录要点，不擅自扩展）。
2. **调研结论与来源**：阶段 2 的结论 + 链接列表。
3. **技术方案**：技术选型、目录结构、模块划分、关键接口 / 数据结构。
4. **测试计划（TDD）**：先写哪些测试、每个测试验证什么行为、如何运行。
5. **验收标准 checklist**：`- [ ]` 形式的可勾选条目。

写完请**用户审阅**（呈现与批准方式见第 10 节）。用户明确批准后，把 `status: draft` 改为 `status: approved`（**这一步会解锁代码门禁**）；未批准前不要改动其他文件。

## 第 5 节：阶段 3.2 UI 规格（任务涉及界面时必做）

**触发条件**：任务涉及任何界面——网页（HTML/CSS/Vue/React 等）、桌面 GUI、LVGL 嵌入式界面或布局绘制。

**必须先读设计规范**：`references/design-rules.md`（位于 dev-sop 插件安装目录下，含硬校验量化规则与软指导）。

spec 中（在第 4 节的规格文档基础上）必须额外包含 **UI 数据表** 与 **ASCII 线框图**：

1. **屏幕/画布规格**：目标尺寸、分辨率、色彩深度（嵌入式尤其要写明屏幕像素规格）。
2. **布局策略**：Flex/Grid 优先（LVGL 用 `lv_obj_set_flex_*`）；每个使用绝对坐标的组件必须说明理由（如弹窗/悬浮层）。
3. **组件清单表**：每个 UI 组件一行，含 id、布局规则或坐标、尺寸、层级（zIndex/创建顺序）、状态（默认/悬停/禁用等）。
4. **ASCII 线框图**：用字符画表达整体布局与组件位置关系。

**线框审批（必须单独询问批准）**：必须用 `AskUserQuestion` 的 **preview 功能**给出**至少 2 个**线框方案供用户选择，
获得用户对线框的**明确批准**后，才把 spec frontmatter 加上 `wireframe: approved`（此标记是 UI 文件门禁的解锁钥匙，
与 `status` 独立——没有它，`hooks/gate.js` 会拦截所有 .html/.css/.vue/.jsx/.tsx 等界面文件及 LVGL 相关 .c 的写入）。
**不得把线框批准与 spec 整体确认合并为一次提问**——线框批准是一次独立、专门的 AskUserQuestion。
线框的呈现与批准方式同样遵循第 10 节，且选项必须用 **preview 展示 ASCII 图**，让用户直观对比方案。

**ui-files 声明**：UI 任务必须在 spec frontmatter 额外写明 `ui-files: <逗号分隔的项目相对路径>`
（LVGL 任务列出 .c 文件），例如：

```yaml
---
status: approved
wireframe: approved
ui-files: src/ui/main.html, src/ui/style.css
---
```

**UI 量化验收自动闭环（第 7 节的附加项，v1.3.0 起改为单次委派自动闭环）**：

量化验收不再由主会话逐轮驱动，而是通过**单次 code-worker 委派合同**自动闭环。委派 prompt 必须包含以下全部七要素（缺一即合同不完整）：

1. **任务书与规格路径**：委派 prompt 必须引用任务书与规格的 .md 路径（`docs/tasks/<slug>.md` 与 `docs/specs/<slug>.md`，满足 Agent 委派门禁）；本委派虽提及 .js/.mjs 等代码文件，但属**验收类委派**（输出 `docs/specs/<slug>.ui-report.json`）——gate 自动豁免执行书要求（v1.5.1），无需附执行书或豁免标记。
2. **插件脚本路径**：委派前主会话必须解析插件实际安装目录并把可直接执行的**绝对路径**写入 prompt（如 `<安装目录>/hooks/ui-collect.js` 与 `<安装目录>/hooks/ui-analyzer.mjs`；安装目录可在设置→插件详情或 `~/.zcode/cli/plugins` 下确认）——Web 任务用 `<安装目录>/hooks/ui-collect.js`（浏览器内 eval 采集几何 JSON）与 `<安装目录>/hooks/ui-analyzer.mjs`（量化分析）；LVGL 任务用 `<安装目录>/hooks/lvgl-check.mjs`（C 源码静态校验）；WPF 任务用 `<安装目录>/scripts/wpf-check.mjs`（静态 XAML 审查，支持 --out 生成 ui-report 通用格式）。
3. **双视口要求**：Web 任务至少采集两个视口——默认宽度 + 一个非默认宽度（如 375px 与 1280px，或项目约定组合）。
4. **循环指令**："采集 → 分析 → 修复 → 复测，直至全部 error=0"——code-worker 在同一委派内自行迭代，主会话不逐轮参与。
5. **预算硬限**：最多 5 轮修复、总时长 ≤10 分钟；超限立即停止并如实回报当前违规清单，禁止谎报清零。
6. **报告落盘**：每次分析都带 `--out docs/specs/<slug>.ui-report.json`（多次/多视口结果汇总进同一报告文件）。
7. **本地服务自起自停**：需要本地 dev server 时由 code-worker 在闭环内自行启动、结束时关闭，不留后台进程。

**主会话职责（闭环前后各一次，中间不参与）**：

- 委派前：确认 spec frontmatter 已有 `wireframe: approved`（UI 写入门禁已解锁）且 `ui-files` 已声明。
- 闭环后：code-worker 回报闭环结果时，主会话**只复核 `docs/specs/<slug>.ui-report.json`（error 合计=0）**，不再逐轮参与；warning 逐条说明取舍。
- **强制交付物不变**：必须产出 `docs/specs/<slug>.ui-report.json`（双视口/多文件全量 error=0）。Stop 钩子（`hooks/accept-check.js`）会校验该文件存在且全部 error=0，否则无法结束交付。截图仅作为人工复核的可选附件，不作为判定依据。

注意：上述 `hooks/ui-collect.js`、`hooks/ui-analyzer.mjs`、`hooks/lvgl-check.mjs`、`references/design-rules.md` 均位于
dev-sop 插件安装目录（即 SKILL.md 所在插件的 hooks/、references/ 子目录），使用时按插件实际安装路径引用。

### 单轮三步（v1.6.0）

实现类委派一律单轮完成——①落盘执行书/变更单（委派 prompt 已含内容，逐字写入目标路径）②执行执行命令（默认补丁直改：勘探后生成补丁脚本嵌入执行书，worker 仅执行执行命令；patch-mode: edit 备选时改为 Edit 机械应用，定位行号+定向 Read）③运行验证命令并回报输出；禁止拆分为"写单"与"执行"两轮；停报纪律不变（old 不匹配/预期不符即停，已落盘执行书保留审计）。执行书文件与代码改动同轮产出，不再分委派；gate 门禁交互不变（委派 prompt 写明将写入的执行书路径即满足引用判定）。

## 第 6 节：阶段 3.5 任务书（spec 批准之后、委派 code-worker 之前）

spec 获批后，不要直接向 code-worker 委派编码。**必须先产出任务书** `docs/tasks/<slug>.md`（与 spec 同 slug，可用序号后缀区分多个任务，如 `<slug>-01.md`），至少包含：

1. **目标文件清单**：本次要新建 / 修改的每个文件的绝对或项目内相对路径。
2. **期望行为**：每个文件/模块应实现的行为描述（逐条、可验证）。
3. **验收标准**：如何验证改对了（具体命令、期望输出、检查点）。
4. **测试要求**：需要先写的测试、覆盖的场景、测试运行命令。
5. **验收测试计划表**（必须）：逐条对应 spec 的验收标准，**固定为五列 markdown 表格**，模板与示例见第 11 节。
   并在任务书中显式声明：**本表之外的测试禁止执行**。
6. **参考**：关联的 spec 路径与章节（如 `docs/specs/<slug>.md#阶段3`）。

委派要求：

- 委派 `Agent`（code-worker）的 prompt 中必须**显式写出任务书与 spec 的相对路径**，例如 `docs/tasks/<slug>.md`、`docs/specs/<slug>.md`。
- prompt 中不得包含技术决策类问题，决策由主会话完成；code-worker 只执行。
- 未引用 `docs/specs/`、`docs/tasks/` 或 `docs/changes/`（v1.4.0 变更单）路径的委派会被 PreToolUse hook 直接拦截（exit 2）。
- 编码类委派（prompt 提及代码文件）还须引用执行书 `docs/tasks/<slug>-exec.md` 或变更单路径，或标 `exec-plan: exempt`（v1.5.0 执行书门禁；执行书产出见第 6.5 节），否则同样被拦截。

## 第 6.5 节：阶段 3.6 执行书（任务书之后、委派编码之前，v1.5.0）

**worker 零思考纯执行**：勘探与方案设计全部上移主会话，code-worker 只逐条机械应用。主会话勘探后将执行书内容写入委派 prompt（与任务书同 slug，S 级并入变更单的"改动清单"表，不再独立成文件；执行书落盘动作归步骤 3 单轮三步）：

1. **主会话亲自勘探（或 prospector 并行代勘）**：用 Read / Grep 亲自查看目标文件现状（不凭记忆），复制准确的现有文本片段作为 old 锚点；可先委派 prospector（类型名含 prospector，委派 prompt 首行 `PROSPECTOR-READONLY`，gate 双条件放行）并行取锚点表（见 `agents/prospector.md`），主会话基于表填变更表并裁决——裁决与 old 转录始终在主会话。
2. **产出变更表（v1.8.0 表格驱动，手写执行书退役）**：按 `references/spec-templates/change-lite.md` 的"变更表"填表——列：序号 / 文件 / 行号（旧块首行，1 基）/ 锚点（该行应含短子串）/ 旧行数 / 新内容（多行 `<NL>` 转义，新文件 `<NEWFILE>` 前缀全文），另含 `## expect_after`（文件 / 包含子串）与 `## 验证` 字段；执行书不再手写——`docs/tasks/<slug>-exec.md` 为 `node scripts/compile-change.mjs <变更单>` 的编译产物（补丁脚本 / 执行命令 / 自动回滚快照生成，锚点零转录）。
3. **并入委派（单轮三步，v1.8.0 编译直改）**：变更表全文写入委派 prompt 并写明变更单落盘路径（`docs/changes/<slug>.md` 引用同时满足 Agent 委派门禁与执行书门禁），code-worker 同一轮完成 ①落盘变更单（逐字写入）②`node scripts/compile-change.mjs docs/changes/<slug>.md | python -`（执行书=编译产物 docs/tasks/<slug>-exec.md，一条管道机械应用）③运行验证命令并回报输出（见第 5 节单轮三步；禁止拆分为"写单"与"执行"两轮）；**编译失败（exit 非零）fallback `patch-mode: edit`**（定位行号+最短唯一锚点+定向 Read 禁全文件读入）；S 级同样把变更表直接写入变更单并随 prompt 附变更单路径。

**UI 判据说明（v1.9.0）**：`.xaml` 属 UI 文件判据——`hooks/gate.js` 的 `UI_FILE_EXT_RE` 含 xaml，与 .html/.css/.vue/.jsx/.tsx 同类；执行书/变更单涉及 .xaml 写入时，仍受 Write/Edit 层 UI 门禁约束（spec frontmatter 须有 `wireframe: approved`）。

**文本级精确约束（硬性）**：

- old 片段必须与文件当前内容**逐字符一致**（主会话勘探时复制，禁止手打或凭记忆改写）；锚点片段须在文件内唯一。
- new 文本为完整替换内容（非"意图描述"）；新文件给全文。
- 每步验证命令含**显式 timeout**，预期输出精确到可逐字符比对。

code-worker 侧行为（见 `agents/code-worker.md` 执行书模式）：逐条按序应用 + 每步验证比对；禁止读取清单外文件、禁止自行搜索/近似定位/重试不匹配项、禁止任何方案决策；old 不匹配 / 锚点缺失 / 预期输出不符 → 立即停报（前提不符），不尝试修复；执行书错误导致停报属预期，由主会话修书重发。非编码任务（纯文档/调研）或用户明确豁免时，委派 prompt 标 `exec-plan: exempt`；豁免标记滥用由 reviewer 执行书符合度维度兜底（第 8 节）。

### 大改动批量化（v1.7.1）

- PATCHES 列表天然批量：大改动 = 一份执行书一个脚本逐条集合（可含跨文件、重复出现 count、new_file 全文写），20 文件与 2 文件 worker 耗时几乎相同——**禁止把大改动拆成多次委派**（每次委派 ~10s 启动开销）
- 多段串联验证：改动有依赖时执行命令写 `python - <<'PYEOF'(补丁段1) && <验证1> && python - <<'PYEOF'(补丁段2) && <验证2>`，失败停在出错段即天然检查点
- 勘探并行化：主会话勘探多文件时在同一消息并行发起多个 Read/Grep（大改动的主要耗时在勘探）；v1.8.0 起可先委派 prospector（类型名含 prospector，prompt 首行 `PROSPECTOR-READONLY`）并行取锚点表，主会话基于表填变更表并裁决

## 第 7 节：阶段 4 TDD 实现 + 自审

1. **先写测试（TDD）**：在写任何业务代码前，创建测试文件（路径含 `test` 的文件在白名单内，可正常写入），覆盖任务书与 spec 中的验收标准；先确认测试因功能缺失而失败，再写实现。
2. **再实现**：写业务代码，直到测试全部通过；严格按任务书的期望行为实现，不多做、不少做。
3. **跑测试**：执行测试命令，确保全绿；有失败就修到绿为止。失败不得通过注释、跳过测试或空实现来"通过"。测试执行必须遵循 `references/testing-rules.md`（dev-sop 插件安装目录）的测试纪律：金字塔分层（静态→单元→集成→浏览器，后者仅 UI 验收项且最后最少跑）、单命令 ≤2 分钟显式设 timeout、整场 ≤10 分钟、fail-fast 首败即停从失败处续跑、迭代修复只跑受影响测试、禁止后台/监听模式长跑（`hooks/test-guard.js` 强制拦截）。
4. **对抗性自审**：完成后对全部改动逐项检查，假设自己是审查者，主动攻击自己的实现——
   - 逻辑 bug（边界、空值、错误分支、状态竞态）
   - 性能问题（无谓循环、重复 IO、阻塞调用、内存增长）
   - 安全问题（注入、路径穿越、敏感信息泄露、权限缺失）
   - 与规格不符项（漏实现、多做、行为偏差）

   发现的问题先修复再汇报。
5. **汇报**：说明改了哪些文件、执行了什么命令、结果如何，并**逐条勾选验收标准**（`- [x]` / `- [ ]` 并说明未完成原因）。
6. **产出验收测试报告**：交付前按任务书验收测试计划表逐条执行并记录，产出 `docs/specs/<slug>.test-report.json`，结构为：

   ```json
   {
     "records": [
       { "item": "<验收标准描述>", "command": "<实际执行的命令>", "durationMs": 1234, "result": "pass" }
     ],
     "summary": { "passed": 3, "failed": 0 }
   }
   ```

   要求：JSON 合法、records 非空、每条 `result` 为 `"pass"`、`summary.failed` 为 0。spec frontmatter 声明了 `code-files` 且代码文件已实现时，Stop 钩子（`hooks/accept-check.js`）会强制校验该报告，未通过无法结束交付。测试执行纪律见 `references/testing-rules.md`。

## 第 8 节：阶段 4.5 分级审查（lint 机器门禁 + 按风险分级 + 用户验收标记）

**v1.10.0 总述**：审查由三段构成——①机器门禁（review-lint，硬前置）；②按级别路由的语义审查（S 免 AI / M 快审 / L 全审）；③结案（lint 结案 / review-report / 用户验收 accept 标记）。三者统一由 Stop 钩子 `hooks/accept-check.js` 的分级链（`assessReviewRequirement` 纯函数）校验，日志 reason 记录四态之一：`lite-reviewed-by-lint` / `fast-review` / `full-review` / `user-accepted`。

### 8.0 机器门禁（所有级别的硬前置）

主会话在实现完成后、委派 reviewer 之前先跑：

```bash
node scripts/review-lint.mjs docs/changes/<slug>.md --out docs/changes/<slug>.lint-report.json   # S/M 变更单
node scripts/review-lint.mjs docs/specs/<slug>.md --out docs/specs/<slug>.lint-report.json       # L spec（有变更单时以变更单为输入）
```

- 输出结构（v1.10.2 覆盖语义，v1.10.3 增来源戳）`{producedBy:"review-lint", target, slug, generatedAt, violations:[], warnings:[]}`：每次 `--out` **整体替换**写盘，只反映本次运行结果（不再聚合追加，历史违规不会残留）。产物名约定 `<slug>.lint-report.json`（specs 或 changes 目录）。旧聚合结构 `{reports, summary}`、缺 `generatedAt`、或 `producedBy` 缺失/不为 `"review-lint"` 均视为"报告格式过期或不可信"，accept-check 直接 block 提示重跑。
- 规则按目标分域（v1.10.2）：
  - **变更单**（frontmatter 含 `changed-files`）：fileset / linecap / placeholder / verify（v1.8.0）+ 三条项目规则。
  - **spec**（只有 `code-files` / `ui-files`）：只跑 `exec-missing` / `test-cmd-empty` / `lint-stale`；fileset / linecap / verify / placeholder 不对 spec 生效（exec 文档章节名为"执行顺序与验证"，不适用 verify 规则）。
- 项目级规则：`exec-missing`（review: required 或 tier S/M 的条目无任何执行证据——`docs/tasks/<slug>-exec.md`、`docs/changes/<slug>.md`、`<slug>.test-report.json` 三者均不存在）/ `test-cmd-empty`（test-report 的 records[].command 为空串或缺失）/ `lint-stale`（v1.10.3：lint-report 的生成时刻——优先报告内 `generatedAt`，无该字段回退文件 mtime——早于条目任一 code-files/ui-files/changed-files 文件 mtime → **warning**，本次重跑写入新报告即清零；因规则判在写盘之前，若升格 violation 会导致重跑自身 exit 1 的自参照，故不阻断——报告"新于代码"的可信度由 accept-check 的结构/来源戳校验负责）。三规则均按目标 slug 作用域，`lint-stale` 额外判定目标自身；`docs/specs`/`docs/changes` 不存在时记 warning `scan-degraded`（不再静默），规则扫描异常同样降级为 warning。
- **violations 必须为 0** 才能进入语义审查——lint 为硬门禁，任何级别、任何用户签字都不能豁免（用户签了带机器违规的产物也会被 Stop 钩子挡回）。修复后重跑 review-lint `--out` **覆盖写**报告即可（无需手工删除旧报告；lint-stale 仅提示，重跑后即消失）。
- **block 文案与真实状态一致（v1.10.3）**：`accept-check` 的 block 文案分两段装配——lint 未清零时先给 lint 违规计数与"重跑 review-lint"，再列仍需满足的 review-report / accept 标记路径；lint 已干净时**只**列路径项，不再出现任何 lint 指引。

### 8.1 分级路由

| 级别 | lint 干净后 | 结案条件 | 日志 reason |
| --- | --- | --- | --- |
| **S 级变更单** | 免 AI 审（主会话可显式要求快审，仅信息补充） | lint 干净即结案 | `lite-reviewed-by-lint` |
| **M 级变更单** | reviewer **快审模式**（diff-only）或用户验收标记 | `docs/changes/<slug>.test-report.json` 合规（records≥1 全 pass、failed=0，accept 不豁免）**且**（review-report verdict ∈ {pass, pass-with-issues} **或** 有效 accept 标记） | `fast-review` / `user-accepted` |
| **L 级 spec**（review: required） | reviewer **全审模式**或用户验收标记 | 同上 | `full-review` / `user-accepted` |

- 快审模式（`agents/reviewer.md`"审查分级模式"）：材料仅变更单/任务书 + lint 输出 + diff；**禁止复跑测试**（采信 test-report 与执行回报，仅做断言强度抽查）；工具调用预算 **≤10** 次并在报告 summary 记录 `toolCalls` 实测数；报告四段（verdict / 问题计数 / P0-P1 明细 / P2 一行列表）。
- **复审（第 2+ 轮）效率**：优先消费执行书的验证清单（逐条核对已列明验证项及其记录输出是否覆盖本次改动），缺项或记录与磁盘状态存疑才现场重跑，现场重跑 ≤3 项、不重复 worker 已跑通命令；summary 记 `toolCalls` / `reusedFromExecBook` / `reRanCount`，目标 ≤20 次调用。
- 全审模式：维持六维现流程（四维 + tier 合规 + 执行书符合度），允许按测试计划表复跑关键测试。
- **升档触发**：主会话在委派 prompt 显式写"全审模式"覆盖 M 默认快审；lint 报 `exec-missing` 或 `test-cmd-empty` 时**必须全审**；快审中发现安全相关/跨模块改动也应升档。

### 8.2 用户验收标记（accept，v1.10.0 新结案路径）

- 触发：主会话在 AskUserQuestion 中收到用户"验收通过 / 定稿"类明确确认。
- 产物：`docs/specs/<slug>-accept.md`（或变更单同 slug 在 `docs/changes/<slug>-accept.md`，任一即可），模板 `references/spec-templates/accept.md`：

  ```markdown
  ---
  accepted: true
  slug: <slug>
  date: <YYYY-MM-DD>
  quoted: "确认定稿 v1.9.0"
  ---
  ```

- 校验：`accepted: true`（严格）+ `slug` 与条目一致 + `quoted` 非空；任一不符视为无效标记（不构成结案）。
- 与 review-report 并存时以先满足者为准，不互斥；**accept 不豁免 lint 机器项**（lint 干净是唯一前置）。
- 写入方式：委派一次秒级写标记（docs 白名单路径），无需 reviewer；随后即可结案。

### 8.3 审查执行细节（沿用 v1.3.0–v1.9.0）

实现完成后进入审查阶段；**全审路径**下审查与量化验收闭环可并行执行（见下方并行指引）。审查者必须是**全新委派的 reviewer 子代理**（插件内置 `agents/reviewer.md`，代理名 `dev-sop:reviewer`：独立上下文 fresh-eyes、只读、开思考、`injectAgentsMd: false` 保持中立），**不得**由主会话自任，更不得由实现该代码的 code-worker 自审代替。

**审查∥量化闭环（v1.3.0 并行提效）**：并行发起前，主会话先**本地 WIP commit 冻结基线**，再在**同一条消息**里并发两个 Agent 调用——`dev-sop:reviewer`（审查实现**初版** diff，输入=冻结基线对应的**改动清单**）+ `code-worker`（执行第 5 节的量化验收自动闭环），重叠审查与量化验收两段时间。**硬约束**：并行窗口期间（双 Agent 运行中）禁止任何 git commit / stash 操作（主会话与执行层均不得执行），待审查与闭环均完成且增量快检结束后再统一提交。

**冻结与增量 diff 语义**：reviewer 委派的 diff 获取方式=`git diff HEAD~1..HEAD`（或主会话指明 range，指向冻结基线提交）；首次提交（无上一提交）时改用 `git diff --no-index /dev/null <改动文件>`（Windows 下用 `NUL` 替代 `/dev/null`）或直接附改动文件清单与内容；量化闭环回报后，增量快检用 `git diff HEAD`（查看相对冻结基线的全部工作区改动）；P0/P1 级才追加**一轮增量快审**（diff 优先，仅审增量改动），**P2** 级问题直接记 backlog，不追加审查轮次。

流程（六步，并行版）：

1. **实现完成**：code-worker 完成实现并自审通过（第 7 节全部完成，验收测试报告 test-report 合规）；量化验收（ui-report）不作为本步前置——它与审查并行，由第 3 步的量化闭环产出，闭环回报后由主会话复核；
2. **冻结基线**：主会话本地 WIP commit 冻结基线（并行发起的前置动作，见上方冻结与增量 diff 语义）；
3. **同消息并发委派 reviewer + 量化闭环**：主会话在**同一条消息**里并发两个 Agent 调用——`dev-sop:reviewer` + `code-worker`（第 5 节量化验收自动闭环）。reviewer 委派 prompt 必须提供：任务书路径（`docs/tasks/<slug>.md`）、规格路径（`docs/specs/<slug>.md`）、**改动文件清单**（区分新增/修改）、**获取 diff 的方式**（`git diff HEAD~1..HEAD`，或主会话指明 range）、报告输出路径（`docs/specs/<slug>.review-report.json`）——reviewer 按 diff 优先策略审查（见 `agents/reviewer.md` 输入约定）；**v1.8.0 机器预检前置**：审查先跑 `node scripts/review-lint.mjs <变更单> [--diff-cmd "git diff"]`（文件集⊆changed-files / 净变更行数 tier 上限 / TODO-FIXME-XXX 占位 / 验证命令断言与 timeout 四类机器项），机器项清零后仅做语义四维（符合度/缺陷/安全性能/测试）；lint 违规清单原样并入审查输入，不得带机器违规出 verdict；该委派属**验收类委派**（输出 review-report），gate 自动豁免执行书要求（v1.5.1），改动文件清单含代码文件也不会被拦；收到执行回报后，快审与主会话只读冒烟同时间片并行发起，结果合并呈报（冒烟∥快审，v1.6.0）；
4. **增量快检**：量化闭环回报后，主会话用 `git diff HEAD`（查看相对冻结基线的全部工作区改动）快检闭环修复产生的增量 diff；仅当 reviewer 报告 **P0/P1** 级问题时，才追加**一轮增量快审**（diff 优先，仅审增量改动）；**P2** 级问题直接记 backlog，不追加审查轮次；
5. **verdict 处置（fail→修复循环 / pass-with-issues→用户确认）**：reviewer 按四维度（对照任务书符合度 / 缺陷与边界 / 安全与性能 / 测试质量）审查并写入报告后，主会话回读该报告——verdict 为 `fail` 时，主会话将问题清单 + reviewer 建议整理成修复指令，委派 code-worker 修复；修复后重新委派 reviewer 审查（新报告覆盖旧报告），最多 2 轮修复重审，仍为 `fail` 则如实向用户呈报遗留问题清单请用户仲裁，**禁止把"跳过审查"作为推荐选项**；verdict 为 `pass-with-issues` 时，用 AskUserQuestion 向用户呈报问题清单（含 reviewer 建议与遗留风险），由用户决定**带问题定稿**或**继续修复**——不强制进入修复循环；
6. **定稿**：verdict 为 `pass` 时，用 AskUserQuestion 向用户呈报 verdict + 问题清单摘要，用户确认后方可定稿（继续修 / 定稿）；`pass-with-issues` 经用户确认（带问题定稿 / 继续修复）后方可定稿。
   定稿发布时必须同步：①更新仓库根 CHANGELOG.md（版本/日期/变更摘要/已知问题）②git 提交信息引用版本号 ③打 tag v<版本> 并随 main 推送。

审查报告结构（`docs/specs/<slug>.review-report.json`）：

```json
{
  "verdict": "pass|pass-with-issues|fail",
  "issues": [
    { "severity": "P0|P1|P2", "file": "", "line": 0, "dim": "符合度|缺陷|安全性能|测试", "desc": "", "suggestion": "" }
  ],
  "summary": { "p0": 0, "p1": 0, "p2": 0, "checked": ["逐条验收标准勾选"] }
}
```

verdict 判定规则（reviewer 与 Stop 钩子同规则）：任何 P0 → `fail`；P1 ≥ 3 → `fail`；仅 P2 或 P1 ≤ 2 → `pass-with-issues`；全清 → `pass`。

**spec frontmatter `review` 字段说明：**

- `review: required`：声明该 spec 交付必须经审查链。当其 code-files/ui-files 任一文件已实现且 test-report/ui-report 已合规时，Stop 钩子（`hooks/accept-check.js`）按 v1.10.0 分级链校验：① `docs/specs/<slug>.lint-report.json` 存在且 `violations=[]`（v1.10.2 覆盖语义结构；旧聚合结构判"格式过期"需重跑 lint；否则 block 先修机器项）；② spec 视为 L 级——`docs/specs/<slug>.review-report.json` verdict 为 pass 或 pass-with-issues，**或** `docs/specs/<slug>-accept.md` 为有效验收标记，二者其一即可；都缺 → block（reason 同时说明两条路径）。新项目 spec 默认加 `review: required`（第 4 节模板已内置该行）。
- `review: exempt`：纯文档/微小任务可显式声明豁免，视为无审查要求。
- 存量 spec 不写 `review` 字段则完全不受影响（第三段链只对 `review: required` 的 spec 生效）。
- **历史兼容提示**：新链对"已实现且 review: required"的历史 spec 同样生效——这些 spec 若没有 `<slug>.lint-report.json` 会被 Stop 钩子 block（按 8.0 重跑一次 lint 即可清除，不做自动豁免）。

## 第 9 节：决策层 / 执行层分离与执行代理

- **主会话是决策层**：只做需求分析、任务拆解、指令下达与结果验收。
- **一切文件编辑**（含代码、文档、配置、脚本、数据文件）都通过 `Agent` 工具委派给 code-worker 执行代理，主会话不直接编辑文件。
- **给 code-worker 的指令必须具体**：写明目标文件、期望行为、验收标准，不让其自行做技术决策。
- **正确处理阻塞汇报**：code-worker 因困难或错误中止回报时，主会话必须先亲自分析原因（查看日志、代码、复现命令输出），再下达明确的下一步指令；不得只回复"继续重试"。

**执行代理说明**：

- 本插件内置 `code-worker` 执行代理（`agents/code-worker.md`）：禁用思考的纯执行代理，默认继承会话模型。
- 如需为其指定专属模型：将 `agents/code-worker.md` 复制到 `~/.zcode/agents/code-worker.md`，并在 frontmatter 中添加 `model: <providerId/modelId>` 行；用户级同名定义优先于插件级。
- 若用户环境已有同名代理，则自动沿用其定义。

**委派门禁与文件门禁的分工**：委派创建规格/任务书等文档时，prompt 中引用目标文档路径（如 `docs/specs/<slug>.md`）即可通过委派门禁（不要求文件已存在）；编码实现的强制检查发生在 code-worker 实际写文件时（Write/Edit 层）。

**白名单路径**（无需规格即可写）：

- `docs/specs/` 下任意层级（规格文档本身）
- `docs/changes/` 下任意层级（v1.4.0：S/M 变更单本身，同 specs 待遇）
- 路径段包含 `test` / `tests` / `__tests__` 的文件（TDD 先写测试）
- `*.test.*`、`*.spec.*`、`package.json`、`.gitignore`、`README.md`

## 第 10 节：呈现与批准规范

适用于阶段 3 规格文档与阶段 3.2 线框 spec 的一切批准环节：

- 文档在请求批准前，必须把**全文完整呈现在回复中**（长文档可分节完整展示，并附文件路径供用户在编辑器/面板打开核对）。
- 批准必须通过 `AskUserQuestion` 的**选项**完成（如 批准 / 需修改 / 放弃），**禁止让用户手动输入确认消息**。
- 线框（阶段 3.2）选项必须用 **preview 展示 ASCII 图**，让用户直观对比方案；线框批准是独立、专门的 AskUserQuestion，不得与 spec 整体确认合并为一次提问。

## 第 11 节：测试计划表模板（五列）

任务书（第 6 节）的验收测试计划表**固定为五列 markdown 表格**：验收标准 / 测试层级(静态/单元/集成/浏览器) / 命令 / 预期输出 / 预计耗时，逐条对应 spec 的验收标准。示例：

| 验收标准 | 测试层级(静态/单元/集成/浏览器) | 命令 | 预期输出 | 预计耗时 |
| --- | --- | --- | --- | --- |
| 数字/浮点/true/false/空串正确推断类型 | 单元 | python -m pytest tests/test_csv2json.py -q | 9 passed in 1.5s | 10s |
| 文件不存在时报错且退出码为 1 | 集成 | python csv2json.py no-such-file.csv | stderr 含"文件不存在"，退出码 1 | 5s |

并在任务书中显式声明：**本表之外的测试禁止执行**。

## 第 12 节：附录

### 12.1 核心原则细则

- 本流程是强制的顺序门禁：阶段 1 的需求澄清、阶段 2 的联网调研、阶段 3 的规格审批、阶段 3.5 的任务书、阶段 3.6 的执行书，任何一步没完成，都不允许进入阶段 4 写业务代码。项目里的 `PreToolUse` hook（`hooks/gate.js`）会硬性拦截对 `docs/specs/` 以外业务文件的 Edit / Write / ApplyPatch，直到出现一份 `status: approved` 的规格文档，或（v1.4.0 分级路由）一份 `status: approved` 的变更单（`docs/changes/*.md`，解锁 S/M 快速通道写入）；同时会拦截未在 prompt 中引用 `docs/specs/*.md`、`docs/tasks/*.md` 或 `docs/changes/*.md` 路径的 `Agent` / `Task` 委派；v1.5.0 起，编码类委派（prompt 提及代码文件扩展名或 lvgl+.c）还必须引用执行书 `docs/tasks/<slug>-exec.md`、变更单路径，或显式标记 `exec-plan: exempt`（仅限非编码任务或用户明确豁免），否则拦截；验收类委派（review/ui/test-report 输出）自动豁免执行书要求（v1.5.1）（hook 位于 `hooks/gate.js`，配套 `hooks/inject.js` 在检测到开发意图时自动注入本流程提醒——v1.2.0 起同会话首轮注入全文，次轮起以一行提醒替代）。
- **测试预算三条（硬性，由 `hooks/test-guard.js` 强制）**：单条测试命令 ≤2 分钟（必须显式设置 ≤120000ms 的 timeout）；整场验收 ≤10 分钟；测试命令禁止后台（run_in_background）与监听模式（--watch/nodemon）。超预算须先用 AskUserQuestion 获得用户批准并在项目根创建 `.dev-sop-approve-longtest`。

### 12.2 被门禁拦截时

如果收到 "当前项目没有已批准的规格文档" 的拒绝：

- 正常情况下：回到阶段 1，按本流程推进。
- 用户明确要求跳过时：提示其在项目根创建 `.dev-sop-skip` 文件；访谈与审批完成后删除该文件以恢复门禁。

如果收到 "委派任务前请先走 /spec 流程…" 的拒绝：

- 说明本次 `Agent` / `Task` 委派的 prompt 没有引用 `docs/specs/*.md`、`docs/tasks/*.md` 或 `docs/changes/*.md` 路径。
- 处理：完成阶段 3.5 产出任务书（或 S/M 通道的变更单），并在委派 prompt 中写明 `docs/tasks/<slug>.md` 与 `docs/specs/<slug>.md`（或 `docs/changes/<slug>.md`）的相对路径后重新委派；不要绕过门禁。

如果收到 "编码委派必须附执行书…" 的拒绝（v1.5.0）：

- 说明本次委派被判为编码类（prompt 提及代码文件扩展名或 lvgl+.c），但既未引用执行书/变更单，也未声明豁免。验收类委派（review/ui/test-report 输出）自动豁免执行书要求（v1.5.1），不会收到此拒绝；另注意豁免标记 `exec-plan: exempt` 须在 prompt 中独立成行方可生效（行首锚定整行精确匹配，句中引用/行尾带多余文字不算声明）。
- 处理：主会话亲自 Read/Grep 勘探目标文件后按第 6.5 节产出执行书 `docs/tasks/<slug>-exec.md`（或在变更单中补"改动清单"表），委派 prompt 引用其路径后重新委派；仅当任务确属非编码（纯文档/调研）或用户明确豁免时，才在 prompt 中标 `exec-plan: exempt`——勘探工作不得转嫁给 code-worker。

### 12.3 执行日志

每次 hook 调用都会向 `~/.zcode/hooks/dev-sop.log` 追加一行：

```
ISO时间 | 事件=PreToolUse | tool=工具名 | target=目标文件或(agent) | decision=allow|deny|error | reason=简要原因
```

v1.10.0 起 Stop 放行行的 reason 含审查结案路径（`<四态>@<slug>@review-chain`，多 slug 以逗号拼接；四态 = lite-reviewed-by-lint / fast-review / full-review / user-accepted），据此可审计每次交付走的是哪条路径。

UserPromptSubmit 事件使用 `decision=inject-full|inject-reminder|inject|pass`（v1.2.0：首轮全文 inject-full、次轮一行提醒 inject-reminder、无 session 回退 inject）。排查门禁误拦或未触发时，先看该日志。
