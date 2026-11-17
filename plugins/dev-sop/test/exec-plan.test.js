'use strict';
// exec-plan.test.js — v1.5.0 执行书硬门禁新判定纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/exec-plan.md 2.3 Agent 委派硬门禁
//   isCodingDelegation：prompt 提及代码扩展名文件或 lvgl+.c（.c 已在扩展名表内），
//     大小写不敏感；纯文档（.md）与报告类 .json 不算编码。
//   hasExecPlanReference：prompt 引用 docs/tasks/<slug>-exec.md（执行书）或
//     docs/changes/<slug>.md（变更单，其改动清单表同样文本级精确，视为执行书载体）
//     或显式标记 exec-plan: exempt（v1.5.1 第二轮 P2-1 根治：行首锚定整行精确
//     匹配 /^exec-plan:\s*exempt$/m，标记须独立成行；句中引用/行尾多余文字不触发）。
//   isAcceptanceDelegation（v1.5.1 审查修复 P1-1/P1-2）：prompt 引用验收报告输出
//     路径 docs/(specs|changes)/<...>.(review|ui|test)-report.json → 验收类委派，
//     豁免执行书要求。
//   放行条件链（gate.js Agent/Task 分支，docs 引用前提下）：无 docs 引用 → deny
//     （AGENT_DENY_REASON，回归）；有 docs 引用且有执行书引用/豁免标记 → 放行；
//     验收类委派（v1.5.1，置于编码判定之前）→ 放行；否则编码类 → deny（编码委派
//     必须附执行书…），非编码类 → 维持现状放行。
//   v1.5.1 P2-4：另含 3 个 main() 端到端用例（spawn 真实 hook 喂 stdin JSON，
//     断言 exit code 与 permissionDecisionReason，锁定判定顺序与拒绝原因接线）。

const test = require('node:test');
const assert = require('node:assert');

const {
  isCodingDelegation,
  hasExecPlanReference,
  isAcceptanceDelegation,
  referencesDocsPath,
  EXEC_PLAN_DENY_REASON,
} = require('../hooks/gate.js');

// ---- isCodingDelegation：正例（≥3）----

test('isCodingDelegation：提及 src/app.js → 编码类', () => {
  assert.strictEqual(isCodingDelegation('按任务书修改 src/app.js 实现登录'), true);
});

test('isCodingDelegation：lvgl + .c 文件（ui/main.c 与 main.h）→ 编码类', () => {
  assert.strictEqual(
    isCodingDelegation('实现 LVGL 界面：新建 ui/main.c 与 ui/main.h'),
    true
  );
});

test('isCodingDelegation：大小写不敏感（SRC/APP.JS、Src/Util.TS）→ 编码类', () => {
  assert.strictEqual(isCodingDelegation('更新 SRC/APP.JS 与 Src/Util.TS'), true);
});

test('isCodingDelegation：UI/样式/配置类（style.css、build.py、config.yaml）→ 编码类', () => {
  assert.strictEqual(
    isCodingDelegation('改 ui/style.css 和 scripts/build.py，调整 config.yaml'),
    true
  );
});

test('isCodingDelegation：.tsx/.vue/.rs/.go 等扩展名 → 编码类', () => {
  assert.strictEqual(isCodingDelegation('改 App.tsx'), true);
  assert.strictEqual(isCodingDelegation('改 view.vue'), true);
  assert.strictEqual(isCodingDelegation('改 main.rs'), true);
  assert.strictEqual(isCodingDelegation('改 main.go'), true);
});

// ---- isCodingDelegation：负例（≥3）----

test('isCodingDelegation：纯文档委派（仅 .md）→ 非编码类', () => {
  assert.strictEqual(
    isCodingDelegation('阅读 docs/tasks/todo.md 与 docs/specs/todo.md，总结到 SUMMARY.md'),
    false
  );
});

test('isCodingDelegation：空串 / 无任何文件提及 → 非编码类', () => {
  assert.strictEqual(isCodingDelegation(''), false);
  assert.strictEqual(isCodingDelegation(null), false);
  assert.strictEqual(isCodingDelegation('调研一下竞品怎么做，直接回答'), false);
});

test('isCodingDelegation：报告类 .json（review-report）不算代码 → 非编码类', () => {
  assert.strictEqual(
    isCodingDelegation('读取 docs/specs/todo.review-report.json 并汇报 verdict'),
    false
  );
});

test('isCodingDelegation：正则边界——扩展名后跟字母不误判（app.jsx 已覆盖、todo.mdx 不是代码扩展名表内文件）', () => {
  // .jsx 属扩展名表 → 编码；.mdx 不在表内 → 非编码
  assert.strictEqual(isCodingDelegation('改 widget.jsx'), true);
  assert.strictEqual(isCodingDelegation('改 docs/tasks/todo.mdx'), false);
});

// ---- hasExecPlanReference：执行书/变更单/豁免标记 ----

test('hasExecPlanReference：引用 docs/tasks/todo-exec.md → true', () => {
  assert.strictEqual(hasExecPlanReference('执行书见 docs/tasks/todo-exec.md，逐条应用'), true);
});

test('hasExecPlanReference：反斜杠与子目录 docs\\tasks\\sub\\todo-exec.md → true', () => {
  assert.strictEqual(hasExecPlanReference('执行书 docs\\tasks\\sub\\todo-exec.md'), true);
});

test('hasExecPlanReference：引用变更单 docs/changes/fix-typo.md → true（S 级执行书并入变更单）', () => {
  assert.strictEqual(hasExecPlanReference('按 docs/changes/fix-typo.md 变更单执行'), true);
});

test('hasExecPlanReference：反斜杠变更单 docs\\changes\\fix.md → true', () => {
  assert.strictEqual(hasExecPlanReference('按 docs\\changes\\fix.md 执行'), true);
});

test('hasExecPlanReference：显式标记 exec-plan: exempt 独立成行 → true', () => {
  assert.strictEqual(
    hasExecPlanReference('非编码任务。\nexec-plan: exempt\n请直接执行'),
    true
  );
});

test('hasExecPlanReference：整行内空格宽容（exec-plan:exempt / 多空格）→ true；大写变体不匹配（正则按规格无 i 标志）', () => {
  assert.strictEqual(hasExecPlanReference('exec-plan:exempt'), true); // 单行 prompt 串首串尾
  assert.strictEqual(hasExecPlanReference('exec-plan:   exempt'), true); // 冒号后多空格仍整行
  assert.strictEqual(hasExecPlanReference('EXEC-PLAN: EXEMPT'), false);
});

// ---- hasExecPlanReference：负例（正则边界）----

test('hasExecPlanReference：任务书 docs/tasks/exec-plan.md ≠ 执行书 → false', () => {
  // 本任务书自身命名即 exec-plan.md：必须与 *-exec.md 执行书区分
  assert.strictEqual(hasExecPlanReference('任务书 docs/tasks/exec-plan.md'), false);
});

test('hasExecPlanReference：todo-exec.mdx / todo-exec-plan.md → false（扩展名与后缀边界）', () => {
  assert.strictEqual(hasExecPlanReference('见 docs/tasks/todo-exec.mdx'), false);
  assert.strictEqual(hasExecPlanReference('见 docs/tasks/todo-exec-plan.md'), false);
});

test('hasExecPlanReference：docs/specs/todo-exec.md（不在 tasks/changes 下）→ false', () => {
  assert.strictEqual(hasExecPlanReference('见 docs/specs/todo-exec.md'), false);
});

test('hasExecPlanReference：docs/changes/fix.json（非 .md）→ false', () => {
  assert.strictEqual(hasExecPlanReference('读 docs/changes/fix.json'), false);
});

test('hasExecPlanReference：exec-plan: exemption（后缀多余字母）→ false', () => {
  assert.strictEqual(hasExecPlanReference('已办理 exec-plan: exemption 手续'), false);
});

test('hasExecPlanReference：空串 / null → false', () => {
  assert.strictEqual(hasExecPlanReference(''), false);
  assert.strictEqual(hasExecPlanReference(null), false);
});

// ---- 放行条件链（纯函数组合语义，矩阵见规格 2.3）----

test('放行链：编码委派+任务书引用+无执行书 → 判定为需拦截（coding 且无 exec 引用）', () => {
  const prompt = '按 docs/tasks/todo.md 任务书修改 src/app.js';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), true); // → gate 应 deny（编码缺执行书）
});

test('放行链：编码委派+执行书引用 → 三条件齐备（gate 应放行）', () => {
  const prompt = '按 docs/tasks/todo.md 与执行书 docs/tasks/todo-exec.md 修改 src/app.js';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), true);
});

test('放行链：纯文档委派（只提 .md）无执行书 → 非编码不受影响（gate 应放行）', () => {
  const prompt = '阅读 docs/tasks/todo.md，校对 README.md 文案';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), false);
});

test('放行链：无 docs 引用（回归）→ referencesDocsPath=false（gate 应 deny AGENT_DENY_REASON）', () => {
  const prompt = '直接修改 src/app.js 增加功能';
  assert.strictEqual(referencesDocsPath(prompt), false);
});

// ---- v1.5.1 审查修复 P1-1/P1-2：isAcceptanceDelegation 验收类委派判定 ----

test('isAcceptanceDelegation：引用 docs/specs/x.review-report.json 输出路径 → true', () => {
  assert.strictEqual(
    isAcceptanceDelegation('报告输出 docs/specs/exec-plan.review-report.json，verdict 按 reviewer 规则'),
    true
  );
});

test('isAcceptanceDelegation：docs/changes/ 下的 review-report 输出路径 → true（S/M 快审报告）', () => {
  assert.strictEqual(
    isAcceptanceDelegation('快审报告写入 docs/changes/fix-typo.review-report.json'),
    true
  );
});

test('isAcceptanceDelegation：ui-report 与 test-report 输出路径 → true（UI 闭环 / 测试产出委派）', () => {
  assert.strictEqual(
    isAcceptanceDelegation('分析带 --out docs/specs/dashboard-ui.ui-report.json，直至 error=0'),
    true
  );
  assert.strictEqual(
    isAcceptanceDelegation('验收测试报告写入 docs/specs/todo-app.test-report.json'),
    true
  );
});

test('isAcceptanceDelegation：反斜杠与子目录路径 → true', () => {
  assert.strictEqual(isAcceptanceDelegation('输出 docs\\specs\\sub\\todo.review-report.json'), true);
  assert.strictEqual(isAcceptanceDelegation('输出 docs/changes/sub/fix.ui-report.json'), true);
});

// v1.5.1 第二轮修复 P2-2：字符类补 \u4e00-\u9fa5，中文 slug 报告路径不再漏判
test('isAcceptanceDelegation：中文 slug 报告路径（正斜杠，docs/specs 与 docs/changes）→ true', () => {
  assert.strictEqual(
    isAcceptanceDelegation('报告输出 docs/specs/登录模块.review-report.json'),
    true
  );
  assert.strictEqual(
    isAcceptanceDelegation('快审报告写入 docs/changes/修复typo.ui-report.json'),
    true
  );
});

test('isAcceptanceDelegation：中文 slug + 反斜杠子目录路径 → true', () => {
  assert.strictEqual(
    isAcceptanceDelegation('报告输出 docs\\specs\\中文看板\\测试验收.test-report.json'),
    true
  );
});

test('isAcceptanceDelegation：负例——非 .json 报告路径 / 非 specs|changes 目录 / 普通报告词 → false', () => {
  assert.strictEqual(isAcceptanceDelegation('报告写 docs/specs/x.review-report.md'), false); // 非 .json
  assert.strictEqual(isAcceptanceDelegation('报告写 docs/other/x.review-report.json'), false); // 目录不符
  assert.strictEqual(isAcceptanceDelegation('写报告 review-report，不涉路径'), false); // 无路径
});

test('isAcceptanceDelegation：空串 / null → false', () => {
  assert.strictEqual(isAcceptanceDelegation(''), false);
  assert.strictEqual(isAcceptanceDelegation(null), false);
});

test('验收链：reviewer 委派带 .js 改动清单 + review-report 输出路径 → 验收类豁免（gate 应放行，不因 .js 误拦）', () => {
  const prompt =
    '按 docs/tasks/exec-plan.md 与 docs/specs/exec-plan.md 四维审查；改动文件清单：hooks/gate.js、' +
    'test/exec-plan.test.js、docs/workflow.html（均修改）；diff 获取：git diff HEAD~1..HEAD；' +
    '报告输出 docs/specs/exec-plan.review-report.json';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), true); // 含 .js/.html → 编码类
  assert.strictEqual(isAcceptanceDelegation(prompt), true); // → 验收类豁免，置于编码判定之前 → 放行
});

test('验收链：UI 闭环委派含 ui-analyzer.mjs 脚本 + ui-report.json 输出 → 验收类豁免（gate 应放行）', () => {
  const prompt =
    '按 docs/tasks/dashboard-ui.md 与 docs/specs/dashboard-ui.md 执行量化验收自动闭环：' +
    '用 <安装目录>/hooks/ui-collect.js 与 <安装目录>/hooks/ui-analyzer.mjs 采集分析，' +
    '采集→分析→修复→复测直至 error=0，报告落盘 --out docs/specs/dashboard-ui.ui-report.json';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), true); // 含 .js/.mjs → 编码类
  assert.strictEqual(isAcceptanceDelegation(prompt), true); // → 验收类豁免 → 放行
});

test('验收链：纯编码委派无任何验收报告路径 → 无豁免（仍应 deny 编码缺执行书）', () => {
  const prompt = '按 docs/tasks/todo.md 任务书修改 src/app.js 与 src/util.ts，产出汇总说明';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isAcceptanceDelegation(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), true); // → gate 应 deny（EXEC_PLAN_DENY_REASON）
});

// ---- v1.5.1 第二轮修复 P2-1（根治）：豁免标记行首锚定整行精确匹配 ----

test('豁免行锚定：独立成行（多行 prompt 中整行精确匹配）→ hasExecPlanReference=true', () => {
  assert.strictEqual(
    hasExecPlanReference('按 docs/tasks/todo.md 执行调研。\nexec-plan: exempt\n请直接开始'),
    true
  );
  assert.strictEqual(hasExecPlanReference('exec-plan:exempt'), true); // 单行 prompt 串首串尾
  assert.strictEqual(hasExecPlanReference('exec-plan:   exempt'), true); // 冒号后多空格仍整行
});

test('豁免行锚定：句中引用（deny 原文式嵌句）不触发 → hasExecPlanReference=false', () => {
  // gate deny 原文中该串嵌在句中、不独立成行——引用/转述拒绝原文不会再被误判为声明豁免
  assert.strictEqual(hasExecPlanReference('非编码任务，exec-plan: exempt，请直接执行'), false);
  assert.strictEqual(
    hasExecPlanReference('或声明 exec-plan: exempt（仅限非编码任务或用户明确豁免）；勘探由主会话亲自完成'),
    false
  );
});

test('豁免行锚定：行尾带多余文字不触发 → hasExecPlanReference=false', () => {
  assert.strictEqual(hasExecPlanReference('exec-plan: exempt（用户已批准）'), false);
  assert.strictEqual(hasExecPlanReference('exec-plan: exempt 已由用户批准'), false);
});

test('豁免行锚定：前缀粘连 / 大写变体不触发（回归）→ hasExecPlanReference=false', () => {
  assert.strictEqual(hasExecPlanReference('已办理 2exec-plan: exempt 手续'), false);
  assert.strictEqual(hasExecPlanReference('标记 my-exec-plan: exempt 无效'), false);
  assert.strictEqual(hasExecPlanReference('EXEC-PLAN: EXEMPT'), false); // 规格正则无 i 标志
});

// ---- v1.5.1 审查修复 P2-4：main() 端到端接线（spawn 真实 hook，喂 stdin JSON）----

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const GATE_JS = path.join(__dirname, '..', 'hooks', 'gate.js');
const PLUGIN_DIR = path.join(__dirname, '..');

// 端到端跑真实 gate.js：Agent 工具 + prompt → { status, stdout }
function runGate(prompt) {
  const payload = { tool_name: 'Agent', tool_input: { prompt } };
  return spawnSync(process.execPath, [GATE_JS], {
    input: JSON.stringify(payload),
    cwd: PLUGIN_DIR,
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: PLUGIN_DIR }),
    timeout: 20000,
    encoding: 'utf8',
  });
}

test('main() e2e：验收类委派（reviewer 形态：.js 清单 + review-report 路径）→ exit 0 放行且无 deny 输出', () => {
  const r = runGate(
    '按 docs/tasks/exec-plan.md 与 docs/specs/exec-plan.md 审查；改动文件清单：hooks/gate.js、' +
    'test/exec-plan.test.js；diff 获取：git diff HEAD~1..HEAD；报告输出 docs/specs/exec-plan.review-report.json'
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), ''); // 放行时不产生 deny JSON
});

test('main() e2e：编码委派无执行书（仅任务书引用）→ exit 2，deny reason 含执行书要求与验收豁免句', () => {
  const r = runGate('按 docs/tasks/todo.md 任务书修改 src/app.js');
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('编码委派必须附执行书'),
    'deny reason 须含执行书要求原文'
  );
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('验收类委派'),
    'deny reason 须含验收类自动豁免说明句'
  );
});

test('main() e2e：豁免标记词边界——粘连 2exec-plan: exempt 不生效 → 编码委派仍 exit 2 deny', () => {
  const r = runGate('按 docs/tasks/todo.md 修改 src/app.js（提示语里的 2exec-plan: exempt 是粘连词，不算豁免）');
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

// ---- v1.5.1 第二轮回归：gate Agent 分支判定矩阵 9 项复跑（spawn 真实 hook）----

const GATE_MATRIX = [
  {
    name: '1/ 无 docs 引用（含代码文件）→ deny AGENT_DENY_REASON',
    prompt: '直接修改 src/app.js 增加功能',
    exit: 2,
    reason: '委派任务前请先走 /spec 流程',
  },
  {
    name: '2/ docs 引用+执行书 → allow',
    prompt: '按 docs/tasks/todo.md 与执行书 docs/tasks/todo-exec.md 修改 src/app.js',
    exit: 0,
  },
  {
    name: '3/ docs 引用+变更单 → allow',
    prompt: '按 docs/changes/fix-typo.md 变更单修改 src/app.js',
    exit: 0,
  },
  {
    name: '4/ docs 引用+豁免标记独立成行 → allow',
    prompt: '按 docs/tasks/todo.md 执行调研汇总，标记如下：\nexec-plan: exempt',
    exit: 0,
  },
  {
    name: '5/ docs 引用+验收报告路径 → allow（验收类豁免，置于编码判定之前）',
    prompt:
      '按 docs/tasks/exec-plan.md 审查改动清单 hooks/gate.js，报告输出 docs/specs/exec-plan.review-report.json',
    exit: 0,
  },
  {
    name: '6/ docs 引用+编码+无执行书/豁免/验收 → deny EXEC_PLAN_DENY_REASON',
    prompt: '按 docs/tasks/todo.md 任务书修改 src/app.js',
    exit: 2,
    reason: '编码委派必须附执行书',
  },
  {
    name: '7/ docs 引用+非编码（纯 .md）→ allow（维持现状放行）',
    prompt: '阅读 docs/tasks/todo.md，校对 README.md 文案',
    exit: 0,
  },
  {
    name: '8/ docs 引用+豁免标记嵌在句中（deny 原文引用）→ deny（P2-1 根治）',
    prompt:
      '按 docs/tasks/todo.md 修改 src/app.js（上次拒绝理由是"或声明 exec-plan: exempt（仅限非编码任务或用户明确豁免）"，此处仅为引用）',
    exit: 2,
    reason: '编码委派必须附执行书',
  },
  {
    name: '9/ docs 引用+中文 slug 验收报告路径 → allow（P2-2 中文 slug 补齐）',
    prompt:
      '按 docs/tasks/执行书核对.md 审查改动 hooks/gate.js，报告输出 docs/specs/登录模块.review-report.json',
    exit: 0,
  },
];

test('gate 矩阵 9 项复跑：Agent 分支全判定链（放行/拦截与拒绝原因接线一致）', () => {
  for (const item of GATE_MATRIX) {
    const r = runGate(item.prompt);
    assert.strictEqual(r.status, item.exit, item.name);
    if (item.exit === 2) {
      const out = JSON.parse(r.stdout.trim());
      assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny', item.name);
      assert.ok(
        out.hookSpecificOutput.permissionDecisionReason.includes(item.reason),
        item.name + '：deny reason 须含 "' + item.reason + '"'
      );
    } else {
      assert.strictEqual(r.stdout.trim(), '', item.name + '：放行时不产生 deny JSON');
    }
  }
});

// ---- v1.6.0：isCodingDelegation 先剔除 docs/ 前缀路径子串（文档委派误拦修复）----

test('v1.6.0 docs 剔除：prompt 仅含 docs/x.js 提及（报告/清单名）→ 不判编码（放行）', () => {
  assert.strictEqual(
    isCodingDelegation('汇总 docs/reports/build-stats.js 的运行数据到 docs/tasks/sum.md'),
    false
  );
  assert.strictEqual(isCodingDelegation('读取 docs/x.js 说明与 docs/temp/check.js 清单'), false);
});

test('v1.6.0 docs 剔除：含 src/x.js（非 docs 前缀）→ 仍判编码', () => {
  assert.strictEqual(isCodingDelegation('按任务书修改 src/x.js'), true);
});

test('v1.6.0 docs 剔除：docs 提及 + src 混合 → 判编码（剔除只作用于 docs/ 子串）', () => {
  assert.strictEqual(
    isCodingDelegation('参考 docs/guide/demo.js 示例，修改 src/app.js 与 src/util.ts'),
    true
  );
});

test('v1.6.0 deny 文案：EXEC_PLAN_DENY_REASON 末尾含新豁免提示句', () => {
  assert.ok(
    EXEC_PLAN_DENY_REASON.includes('纯文档/调研类委派可加独立成行的 exec-plan: exempt。'),
    'deny reason 须含纯文档/调研类豁免提示句'
  );
});

test('v1.6.0 docs 剔除：docs/ 中文路径正确剔除（中文文件名 + 中文标点边界）', () => {
  // 中文文件名整体剔除，不再误判为编码
  assert.strictEqual(isCodingDelegation('整理 docs/报告/构建统计.js 到汇总文档'), false);
  // 全角逗号边界：剔除到中文标点为止，其后的 src/app.js 仍判编码
  assert.strictEqual(isCodingDelegation('见 docs/示例/check.js，另改 src/app.js'), true);
});

test('v1.6.0 放行链：纯文档委派仅提 docs 内 .js 报告名 + docs/tasks .md 引用 → 全链放行', () => {
  const prompt = '汇总 docs/reports/build-stats.js 到 docs/tasks/sum.md，纯调研任务';
  assert.strictEqual(referencesDocsPath(prompt), true);
  assert.strictEqual(hasExecPlanReference(prompt), false);
  assert.strictEqual(isAcceptanceDelegation(prompt), false);
  assert.strictEqual(isCodingDelegation(prompt), false); // → gate 放行（非编码类）
});

// ---- 修复轮（审查后 P1 根治）：边界安全剔除——docs 前须行首或分隔符，防 mydocs 误配 ----

test('修复轮 P1：反斜杠 docs 路径纯文档（docs\\reports\\x.js）→ 不判编码（放行）', () => {
  assert.strictEqual(
    isCodingDelegation('汇总 docs\\reports\\x.js 的运行数据到 docs\\tasks\\sum.md'),
    false
  );
  assert.strictEqual(isCodingDelegation('读取 docs\\x.js 说明与 docs\\temp\\check.js 清单'), false);
});

test('修复轮 P1：mydocs/x.js（docs 前是字母，非行首/分隔符）→ 仍判编码', () => {
  assert.strictEqual(isCodingDelegation('修改 mydocs/x.js'), true);
  assert.strictEqual(isCodingDelegation('改动 my_docs/y.js 与 mydocs/z.js'), true);
});

test('修复轮 P1：docs token 后同一行再跟 src/x.js → 判编码（剔除止于分隔符，不吞后续内容）', () => {
  assert.strictEqual(isCodingDelegation('见 docs/a.js 并修改 src/x.js'), true);
});

test('修复轮 P1：docs 路径后紧跟中文句号 → 仅剔至句号（其后内容保留参与判定）', () => {
  assert.strictEqual(isCodingDelegation('整理 docs/report.js。汇总成文档'), false);
  assert.strictEqual(isCodingDelegation('见 docs/a.js。另改 src/b.js'), true);
});

test('修复轮 P1：行首 docs/ 与行首 docs\\ 开头 → 正确剔除（^ 锚生效）', () => {
  assert.strictEqual(isCodingDelegation('docs/reports/build-stats.js 汇总到文档'), false);
  assert.strictEqual(isCodingDelegation('docs\\reports\\x.js 仅作参考'), false);
});

test('修复轮 P1：整串即 docs 路径 → 剔除后空 prompt 边界不崩溃（非编码）', () => {
  assert.strictEqual(isCodingDelegation('docs/x.js'), false);
  assert.strictEqual(isCodingDelegation('docs\\x.js'), false);
});
