# 更新日志

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
