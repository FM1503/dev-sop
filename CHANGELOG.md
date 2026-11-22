# 更新日志

## [1.10.3] - 2026-11-23

### 修复

- **accept-check block 文案分流方向**（审查轮2 P1-A）：`composeBlockMessage` 两段式装配——lint 未清零（缺失/过期/违规）时先给 lint 违规计数与"重跑 review-lint --out"，再列仍需满足的 review-report / accept 标记路径；lint 已干净时**只**列路径项，不再出现"先按上面 lint 提示清零"这类误导性 lint 指引。移除按字符串匹配分类的旧 `lintCleanBlock` 逻辑，spec 与变更单循环统一走新装配
- **changelog-init 验证节**（审查轮2 P1-B）：`docs/changes/changelog-init.md` 的两条 grep 断言改为方括号转义写法（`grep -c '^## \[1\.0\.0\]'` / `'^## \[1\.6\.0\]'`），实测 `&&` 链 exit 0；原节保留，末尾加 2026-11-23 更正说明（原"已实跑 exit 0"不成立）

### 变更

- **lint-stale 改用报告内 `generatedAt`**：与条目声明文件 mtime 比较，仅无该字段时回退文件 mtime，消除"代码改动后首次重跑仍报 stale、需第二次才清零"的自参照；因规则判在写盘之前，升格 violation 会使重跑自身 exit 1，故降为 **warning**（重跑一次即清零），报告"新于代码"的可信度交由 accept-check 的结构/来源戳校验
- **docs 目录缺失告警**：`docs/specs` / `docs/changes` 不存在时追加 warning `scan-degraded`（提示核对 cwd 或 `--repo`），不再静默 fail-open；lint-stale 连带扫描的重复告警去重
- **accept-check `findChangeNotes` 过滤 `-accept.md`**：验收标记不再作为 tier 为空的伪变更单进入扫描（与 review-lint 同规则）；顺带删除 `assessSpecReview` 中重复的 `lintStale` 键
- **lint 报告来源戳**：`--out` 写入 `producedBy: "review-lint"`；`checkLintReport` 校验该字段存在且值正确，缺失/错误与旧聚合结构同等判为"格式过期或不可信"需重跑，提高手写伪造成本
- **语义注释漂移修正**：`scripts/review-lint.mjs` 头注释（lint-stale 由 violation 改为 warning、payload 增 producedBy）与 README 组件行同步

### 说明

- 测试：review-lint 39 用例、accept-check 38 用例（新增 lint-stale 三态 / producedBy 校验 / P1-A 文案分流纯函数与 e2e 共 14 条），全量 354/354 通过
- 已知上限（backlog）：lint 报告覆盖写使历史违规不留痕（追溯依赖 Stop 日志与 generatedAt 单点）、报告防伪仅到来源戳级别，本轮不做

### 改进

- 复审效率规则：复用执行书验证清单、现场重跑≤3、summary 记 toolCalls/reusedFromExecBook/reRanCount，目标 ≤20 次调用

## [1.10.2] - 2026-11-23

### 修复

- **M 级 test-report 硬校验回归**：`hooks/accept-check.js` 变更单分支恢复校验 `docs/changes/<slug>.test-report.json`（records≥1 全 pass、summary.failed=0），缺失或不合规 → block（accept 标记不豁免）；S 级仍免。`checkChangeNote` 不再是死代码（导出保留，主链以 `assessChangeReview` 的 `testReportFailure` 承接同一逻辑），block 文案与实现一致
- **lint 报告覆盖语义**：`review-lint --out` 由聚合追加改为**整体覆盖写** `{target, slug, generatedAt, violations, warnings}`（历史违规不再残留，修复后重跑即清零）；`accept-check.checkLintReport` 改读新结构（violations 数组长度判定），旧聚合结构 `{reports, summary}` 判为"报告格式过期，需重跑 lint"并 block；stages-detail 8.0 与 SKILL 对齐"重跑覆盖"
- **lint 规则分域（消除 L 级自锁）**：目标 frontmatter 有 `changed-files`（变更单）→ fileset/linecap/verify/placeholder + 三条项目规则；只有 `code-files`/`ui-files`（spec）→ 仅 exec-missing/test-cmd-empty/lint-stale（spec 文档不再因缺"## 验证"、无 changed-files 被误报）
- **历史 stale 报告清理与重生成**：删除旧 `<slug>.lint-report.json`（逐文件 unlink）并以修正版 lint 对全部 12 个 slug 重新生成
- **accept 标记 date 校验**：date 缺失或非法（非合法 YYYY-MM-DD）时标记仍有效但输出 warning（不 block）
- **projectRules 扫描异常不再静默**：规则抛错降级为 warning `scan-degraded`（含扫描目录与原因），不升级为 violation
- SKILL.md 阶段 4.5 "rev" 笔误修正；执行书补注 1.10.0→1.10.1 版本漂移说明
- 测试：review-lint 33 用例、accept-check 31 用例（新增覆盖写/分域/M test-report 负例/旧结构/date 共 14 条），全量 341/341 通过

## [1.10.1] - 2026-11-23

### 修复

- review-lint：`exec-missing` / `test-cmd-empty` / `lint-stale` 三条规则改为按目标 slug 作用域（查单个变更单时不再被项目内其他条目误伤）；`exec-missing` 证据等价——`<slug>.test-report.json` 视为等价执行证据（存在即无 exec-missing）
- review-lint：新增 `--repo`（显式仓库根，缺省从目标文件目录向上探测 `.git`）与 `--project-scan`（跨 slug 汇总，写独立 `<root>/docs/specs/_project-scan.lint-report.json`）；diff / git status 在仓库根执行

## [1.10.0] - 2026-11-23

### 新增

- **review-lint 升格机器硬门禁**：`--out <path>` 聚合产物 `{reports:[本次结果...], summary:{violations:合计}}`（已存在则追加并重算，stdout 照常只输出本次结果），约定 `<slug>.lint-report.json`；新增三条机器规则——`exec-missing`（review: required 的 spec / tier S·M 变更单既无 `docs/tasks/<slug>-exec.md` 也无 `docs/changes/<slug>.md`）、`test-cmd-empty`（test-report records[].command 为空串或缺失）、`lint-stale`（lint-report mtime 早于条目任一 code-files/ui-files/changed-files 文件 mtime，报告过期需重跑）
- **accept-check 分级审查链**（纯函数 `assessReviewRequirement` + e2e）：lint 为硬前置（报告缺失或 violations>0 → block，accept 标记不可豁免）；**S 级**变更单 lint 干净即结案（lite-reviewed-by-lint，免 AI 审）；**M 级**变更单与 **spec（L）**lint 干净后经 review-report（verdict 为 pass / pass-with-issues，fast-review / full-review）或用户验收标记（user-accepted）任一结案，双缺 block 并说明两条路径
- **用户验收标记 `docs/specs/<slug>-accept.md`**（变更单可放 docs/changes/）：frontmatter `accepted: true` + `slug` + `date` + `quoted`（用户原话摘录，非空），模板新增 `references/spec-templates/accept.md`
- reviewer 审查分级模式：快审（M 默认，材料仅变更单 + lint 输出 + diff、**禁止复跑测试**、工具调用预算 ≤10 并在 summary 记 `toolCalls`、四段报告）/ 全审（L、新功能、安全相关，或主会话显式"全审模式"、lint 报 exec-missing/test-cmd-empty 时升档，维持六维流程）；S 级不再默认 AI 审
- SKILL 阶段 4.5、stages-detail 第 8 节（8.0 机器门禁 / 8.1 分级路由 / 8.2 accept 标记）与 inject 第 6 条同步路由；Stop 放行日志记录四态结案路径
- 测试：review-lint 新增 9 用例（--out 首建/追加、exec-missing 正反、test-cmd-empty 正反、lint-stale 正反、--out 写失败），accept-check 新增 24 用例（纯函数分级链 12 + e2e 8 + 解析/校验 4）

### 兼容性

- 既有四把钥匙逻辑不变，分级审查链在其后追加；`review: exempt` 与未声明 `review` 的 spec 不受影响
- **历史 `review: required` 且已实现的 spec**：缺 `<slug>.lint-report.json` 时会被 Stop 钩子 block（不自动豁免），按阶段 4.5 重跑一次 review-lint --out 即可清除

## [1.9.0] - 2026-11-21

### 新增

- `scripts/wpf-check.mjs` 静态 XAML 审查：重叠/越界/资源引用缺失（error）、低对比度/硬编码尺寸占比等（warning）规则，纯 Node 零依赖，输出与 lvgl-check 同构 JSON
- dotnet test 预算门禁（`hooks/test-guard.js`）：dotnet test/vstest/mstest 测试特征识别；dotnet test 含构建，预算阈值单独放宽至 5 分钟（300000ms）专项，后台/监听仍禁
- mixed-stack 模板（`references/spec-templates/mixed-stack.md`）与 `docs/architecture.md` 项目约定：C# 服务层/WPF 表现层/LVGL 固件层三层清单、跨层数据流表、各层验收清单与五列测试计划表
- 阶段 0.7 跨层缺陷定位 SOP（stages-detail 第 1.4 节）：读 architecture.md→按现象定层（wpf-check/lvgl-check/dotnet test）→按 tier 路由修复→改任一层必跑相邻层验收命令
- `gate.js` UI 判据补 `.xaml`：写 .xaml 需 spec `wireframe: approved`

## [1.8.0] - 2026-11-20

### 新增

- 变更单编译器 `scripts/compile-change.mjs`：表格驱动变更单（行号/锚点/旧行数/新内容 + `<NEWFILE>`/`<NL>`/expect_after/验证字段）→ 一键管道生成并执行确定性补丁；**锚点零转录**（old 不再逐字符抄写，行号+锚点子串断言防漂移）；**自动回滚**（执行前快照 `docs/changes/<slug>.rollback.json`，`--rollback` 一键还原）；执行书 `docs/tasks/<slug>-exec.md` 改为编译产物，编译失败 fallback `patch-mode: edit`
- 机器预检 `scripts/review-lint.mjs`：文件集⊆changed-files / 净变更行数 tier 上限（S:30，M:120，L 不查）/ TODO-FIXME-XXX 占位 / 验证命令断言与 timeout 四类检查，JSON 违规清单 + exit code；reviewer 阶段先跑 lint，机器项清零后仅语义四维
- 断点续作 `scripts/flow-status.mjs`：扫描 specs/changes/reports，输出每个活跃 slug 的阶段/已有产物/缺失产物/下一步一行表
- 动态状态注入（`hooks/inject.js`）：`computePhaseHint` 轻量扫项目 docs，按优先级在首轮全文与一行提醒末尾追加一行【当前状态】（待批准/待实现/缺 test-report/缺 review-report/全部合规，含 slug），无 docs 不加
- prospector 只读勘探代理（`agents/prospector.md` + `hooks/gate.js`）：并行读目标文件仅返回锚点表（文件/行号区间/关键行摘录/建议 old 定位点），不做方案不评价；gate 双条件放行（类型名含 prospector 且 prompt 首行 `PROSPECTOR-READONLY`，防伪装）

## [1.7.1] - 2026-11-20

### 新增

- 大改动批量化指引（PATCHES 批量/多段串联验证/勘探并行；禁止拆分多委派）

## [1.7.0] - 2026-11-20

### 新增

- 补丁直改：确定性补丁脚本（PATCHES 四元组+前置/后置断言，失败 exit 1 打印 ±3 行上下文）替代 LLM Edit，worker 一条 Bash 原样执行执行命令，worker 段 <40s；`patch-mode: edit` 备选（定位行号+定向 Read 禁全文件读入+最短唯一锚点）
- gate 新增 Bash 写模式检测：`echo >`/`sed -i`/`tee`/`patch`/`git apply` 写代码文件同样过门禁，堵 Bash 绕过洞；fail-closed：疑似写入即走门禁链，heredoc/`$(...)` 等无法解析目标按疑似写入一律过完整文件门禁校验、放行仅当门禁通过（与 test-guard 同组双挂不互扰）

## [1.6.0] - 2026-11-17

### 新增

- 委派单轮三步：执行书落盘+机械应用+验证一轮完成（S/M/L 通用）
- S 级快审瘦身：不复跑测试，静态 diff+清单符合度+tier 合规+断言强度抽查
- 冒烟与快审并行；文档类委派 docs/ 路径误拦修复（边界安全正则）

## [1.5.1] - 2026-11-16

### 新增

- 执行书模式：主会话勘探并产出文本级 old→new 执行计划，code-worker 零思考机械执行（三禁止/不匹配即停报）；编码委派硬门禁；验收类委派自动豁免；reviewer 新增执行书符合度维度

## [1.5.0] - 2026-11-16

- 首次引入执行书门禁（1.5.1 完善豁免与加固）

## [1.4.0] - 2026-11-16

### 新增

- 变更分级路由：S 快速通道（单问确认+变更单+快审）/ M 精简四步 / L 全量 SOP；5 连 S 提醒；门禁加固（tier 校验/白名单收紧/正则锚定）

## [1.3.0] - 2026-11-16

### 新增

- 量化验收自动闭环（5 轮/10 分钟预算）；调研∥访谈、审查∥量化闭环；三类 spec 模板（cli/web-ui/lvgl）

## [1.2.0] - 2026-11-16

### 新增

- 注入闩锁（每轮注入省 ~90%）；Reviewer diff 优先；SKILL 分层瘦身（251→77 行）

## [1.1.1] - 2026-11-16 / [1.1.0] - 2026-11-16

### 新增

- 独立 Reviewer 代码审查机制与第五把钥匙（review-report.json）；1.1.1 放宽为 pass-with-issues 经用户确认放行

## [1.0.0] - 2026-11-13

### 首个正式版

- 五把硬钥匙雏形（status/wireframe/ui-report/test-report）、三重门禁钩子、七阶段 SOP、测试预算纪律、量化验收器（Web/LVGL）、内置执行代理、GitHub/Gitee 双平台分发
