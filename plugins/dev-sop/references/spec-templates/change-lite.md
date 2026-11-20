---
slug: <slug>
status: approved
date: <YYYY-MM-DD>
tier: S
changed-files: <目标代码文件，逗号分隔的项目相对路径>
---

# <变更标题>

- 改什么：<一句话：目标文件与改动点>
- 为什么：<一句话：动机 / 触发原因>
- 影响面：<一句话：受影响行为与范围>
- 回滚方式：编译自动快照 `docs/changes/<slug>.rollback.json`；一键还原 `node scripts/compile-change.mjs docs/changes/<slug>.md --rollback | python -`

## 变更表

> v1.8.0 表格驱动（与 `scripts/compile-change.mjs` 解析格式严格对齐）。编译器据此生成
> 补丁脚本与执行书 `docs/tasks/<slug>-exec.md`（编译产物，不再手写）：行号+锚点断言、
> 旧行数校验、EOL 字节保真、新文件全文写入、expect_after 后置断言、执行前自动快照回滚，
> 失败 exit 1 打印 ±3 行上下文。**old 零转录**——只需给行号与锚点子串，不必抄原文。

| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |
| --- | --- | --- | --- | --- | --- |
| 1 | <项目相对路径> | <旧块首行行号，1 基，如 12> | <该行应含的短子串（唯一判别）> | <被替换的行数> | <替换文本；多行用 <NL> 转义> |
| 2 | <新文件路径> | - | - | - | <NEWFILE><新文件全文；多行同样用 <NL> 转义> |

列约定（硬性）：

- **行号**：编辑行=被替换旧块首行的 1 基行号（主会话或 prospector 勘探得到）；新文件置 `-`。
- **锚点**：该行应包含的短子串——补丁执行前断言该行含此子串，不符即失败停报（防行号漂移误改）；新文件置 `-`。
- **旧行数**：被替换的旧块行数（1 行改动写 1，删除 n 行写 n 且新内容留空按编译器空语义、跨行替换写实际行数）；新文件置 `-`。
- **新内容**：完整替换文本，换行一律转义为 `<NL>`（表格单元格不得含真实换行）；新文件以 `<NEWFILE>` 前缀开头，其后为全文（同样 `<NL>` 转义）。
- 单元格内的 `|` 字符须转义为 `\|`。

## expect_after

<可选节：应用后断言（多用于新文件与关键替换）。列：文件 / 包含子串；无后置断言可整节省略。>

| 文件 | 包含子串 |
| --- | --- |
| <项目相对路径> | <写后/改后文件必须包含的子串> |

## 验证

<必填：编译后由 worker 与补丁管道串联执行的验证命令（绝对/项目相对路径、`&&` 串联、
显式 timeout）。编译器校验本节存在并原样透传执行提示；缺本节编译报错。>

```bash
node scripts/compile-change.mjs docs/changes/<slug>.md | python - && <验证命令，含显式 timeout>
```

编译失败（缺表/缺验证/解析报错，exit 非零）→ fallback `patch-mode: edit`：改动清单表
（v1.5.1 文本级精确 old→new + 定位行号）+ 定向 Read（禁止全文件读入）+ 最短唯一锚点 Edit。

<!-- 变更单结构（v1.8.0 统一，表格驱动）：frontmatter（slug/status/date/tier/changed-files）
     + 四行骨架（改什么/为什么/影响面/回滚方式）+ "## 变更表"（必含，列定义与
     compile-change.mjs 对齐；行号+锚点断言取代逐字符 old 转录）+ "## expect_after"
     （可选）+ "## 验证"（必含，缺则编译失败）。单问批准后写入，status 保持 approved。
     M 级共用本模板：tier 改为 M，说明部分可加长至 15 行（变更表行数不计入），
     并在"## 验证"之外追加"验收标准"3-5 条 `- [ ]` checklist。
     reviewer 侧机器预检：node scripts/review-lint.mjs docs/changes/<slug>.md [--diff-cmd
     "git diff"]——文件集/行数上限/占位符/验证字段四类清零后再做语义四维。 -->
