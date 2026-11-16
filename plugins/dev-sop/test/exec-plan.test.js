'use strict';
// exec-plan.test.js — v1.5.0 执行书硬门禁新判定纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/exec-plan.md 2.3 Agent 委派硬门禁
//   isCodingDelegation：prompt 提及代码扩展名文件或 lvgl+.c（.c 已在扩展名表内），
//     大小写不敏感；纯文档（.md）与报告类 .json 不算编码。
//   hasExecPlanReference：prompt 引用 docs/tasks/<slug>-exec.md（执行书）或
//     docs/changes/<slug>.md（变更单，其改动清单表同样文本级精确，视为执行书载体）
//     或显式标记 exec-plan: exempt。
//   放行条件链（gate.js Agent/Task 分支，docs 引用前提下）：无 docs 引用 → deny
//     （AGENT_DENY_REASON，回归）；有 docs 引用且有执行书引用/豁免标记 → 放行；
//     否则编码类 → deny（编码委派必须附执行书…），非编码类 → 维持现状放行。

const test = require('node:test');
const assert = require('node:assert');

const {
  isCodingDelegation,
  hasExecPlanReference,
  referencesDocsPath,
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

test('hasExecPlanReference：显式标记 exec-plan: exempt → true', () => {
  assert.strictEqual(
    hasExecPlanReference('非编码任务，exec-plan: exempt，请直接执行'),
    true
  );
});

test('hasExecPlanReference：豁免标记大小写与空格宽容（EXEC-PLAN: EXEMPT / exec-plan:exempt / 多空格）→ true', () => {
  assert.strictEqual(hasExecPlanReference('用户已豁免 EXEC-PLAN: EXEMPT'), true);
  assert.strictEqual(hasExecPlanReference('exec-plan:exempt'), true);
  assert.strictEqual(hasExecPlanReference('exec-plan:   exempt'), true);
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
