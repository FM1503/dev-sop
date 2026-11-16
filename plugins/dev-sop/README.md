# dev-sop：开发 SOP 门禁

让 AI 像专业工程师一样先问清需求、查证方案、线框确认、量化验收，再动代码。

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
| `<slug>.review-report.json` | docs/specs/ | `review: required` 任务的交付（Stop 钩子校验 verdict=pass） |

配合三道软机制：

- **每轮上下文注入**（`hooks/inject.js`）：检测到开发意图的提示词时，自动注入七阶段流程提醒。
- **执行代理**（`agents/code-worker.md`）：主会话只决策，编码一律委派给禁用思考、只执行不决策的 code-worker 子代理。
- **对抗性审查**（`agents/reviewer.md`）：实现与量化验收完成后，委派独立上下文、只读的 reviewer 子代理对照任务书做四维审查，产出 `review-report.json`（fail/pass-with-issues 时修复重审，最多 2 轮，见 SKILL 阶段 4.5）。

## 七阶段工作流程

```
┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────┐   ┌──────────┐   ┌────────────────┐
│ 1 需求澄清 │ → │ 2 联网调研 │ → │ 3 规格文档    │ → │ 3.2 UI数据表+  │ → │ 3.5 任务书 │ → │ 4 TDD 实现 │ → │ 5 量化验收      │
│   访谈    │   │          │   │ 全文呈现      │   │    线框        │   │          │   │          │   │  + 对抗自审     │
│  (≥2批)   │   │ 附来源链接 │   │ + 选项批准    │   │ (preview 选择) │   │          │   │          │   │                │
└──────────┘   └──────────┘   └──────────────┘   └────────────────┘   └──────────┘   └──────────┘   └────────────────┘
```

## 组件清单

| 组件 | 作用 |
| --- | --- |
| `hooks/gate.js` | PreToolUse 门禁：无 approved spec 拦截文件写入，无 wireframe 批准拦截 UI 文件，未引用 spec/任务书路径拦截 Agent 委派 |
| `hooks/inject.js` | UserPromptSubmit 注入：检测到开发意图时把七阶段流程提醒注入上下文 |
| `hooks/accept-check.js` | Stop 门禁：UI 任务必须产出 ui-report.json 且全部 error=0；代码任务必须产出 test-report.json 且全部 pass；`review: required` 任务必须产出 review-report.json 且 verdict=pass 才能结束交付 |
| `hooks/ui-collect.js` | 浏览器内 eval 采集页面几何数据（多视口）为 JSON |
| `hooks/ui-analyzer.mjs` | 量化分析几何 JSON：越界/重叠/44px 点击区/对比度等，生成 ui-report.json |
| `hooks/lvgl-check.mjs` | LVGL C 源码静态量化校验，生成同一格式的 ui-report.json |
| `hooks/test-guard.js` | PreToolUse on Bash 门禁：测试命令单条 ≤2 分钟、禁止后台/监听模式长跑（`references/testing-rules.md` 的强制执行器） |
| `references/testing-rules.md` | 内置测试纪律：测试金字塔分层、耗时硬预算、fail-fast、受影响测试选择、反冗余 |
| `references/design-rules.md` | 内置设计规范：硬校验量化规则与软指导（Flex/Grid 优先等） |
| `agents/code-worker.md` | 执行代理定义：禁用思考、只执行不决策，是唯一写代码的角色 |
| `agents/reviewer.md` | 审查代理定义：独立上下文、只读（唯一可写 review-report.json），对照任务书做符合度/缺陷/安全性能/测试四维审查，第五把钥匙的执行者 |
| `commands/spec.md` | `/spec` 命令：手动进入规格驱动流程的入口 |
| `skills/dev-sop/SKILL.md` | 七阶段完整流程说明书（技能入口） |

## 逃生阀与边界

- **`.dev-sop-skip`**：项目根创建该文件即临时跳过全部门禁；仅当用户明确要求时使用，事后删除恢复门禁。旧版标记文件 `.spec-gate-skip` / `.spec-gate-approve-longtest` 仍被钩子回退兼容（优先识别新名）。
- **白名单路径**：`docs/specs/`、`docs/tasks/`、路径含 `test/tests/__tests__` 的文件、`*.test.*`、`*.spec.*`、`package.json`、`.gitignore`、`README.md` 无需 spec 即可写。
- **fail-open**：钩子自身出错（如 stdin 解析失败）时放行并记日志，保证不因插件故障卡死开发。

## 可观测性

每次钩子调用向 `~/.zcode/hooks/dev-sop.log` 追加一行（ISO 时间、事件、工具、目标、决策、原因）。门禁误拦或未触发时，先看该日志。

## 安装与使用

- **使用 `/spec` 命令**，或直接提出开发需求（如"帮我做一个 todo 应用"）——inject 钩子会自动注入流程提醒，按七阶段推进即可。
- **自定义 worker 模型**：将 `agents/code-worker.md` 复制到 `~/.zcode/agents/code-worker.md`，在 frontmatter 中添加 `model: <providerId/modelId>` 行；用户级同名定义优先于插件内置定义。
- **放行 reviewer 代理**：若用户级工作流规则限制了可委派的子代理类型，需自行放行插件内置的只读审查代理 `dev-sop:reviewer`，否则阶段 4.5 独立审查无法委派。
