'use strict';
// reviewer-delegation.test.js — dev-sop v1.12.0 reviewer 委派清单硬门禁
//（变更单 docs/changes/reviewer-diff-scope.md）：gate.js 的 isReviewerDelegation /
// assessReviewerPrompt 纯函数，以及 main() 端到端（spawn 真实 hook，喂 stdin JSON）。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  isReviewerDelegation,
  assessReviewerPrompt,
  REVIEWER_PROMPT_DENY_REASON,
} = require('../hooks/gate.js');

const GATE_JS = path.join(__dirname, '..', 'hooks', 'gate.js');
const PLUGIN_DIR = path.join(__dirname, '..');

function agentPayload(subagentType, prompt) {
  return { tool_name: 'Agent', tool_input: { subagent_type: subagentType, prompt: prompt } };
}

function runGate(subagentType, prompt) {
  return spawnSync(process.execPath, [GATE_JS], {
    input: JSON.stringify(agentPayload(subagentType, prompt)),
    cwd: PLUGIN_DIR,
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: PLUGIN_DIR }),
    timeout: 20000,
    encoding: 'utf8',
  });
}

function runGateNoType(prompt) {
  return spawnSync(process.execPath, [GATE_JS], {
    input: JSON.stringify({ tool_name: 'Agent', tool_input: { prompt: prompt } }),
    cwd: PLUGIN_DIR,
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: PLUGIN_DIR }),
    timeout: 20000,
    encoding: 'utf8',
  });
}

// 合规委派：五项齐全的精简模板（5 个条目）
const SLIM_PROMPT = [
  '审查本次改动。',
  '- 取 diff：git diff HEAD~1..HEAD -- hooks/gate.js',
  '- 改动文件：新增 test/reviewer-delegation.test.js；修改 hooks/gate.js',
  '- 变更单：docs/changes/reviewer-diff-scope.md（验收标准在此，按需读）',
  '- 报告输出：docs/changes/reviewer-diff-scope.review-report.json',
  '- 关注点：预算计数是否把内联 diff 代码块排除在外',
].join('\n');

// 超限委派 A：步骤化核对清单（12 条）
const CHECKLIST_PROMPT =
  '审查 docs/changes/demo.md，报告写入 docs/changes/demo.review-report.json。\n' +
  Array.from({ length: 12 }, (_, i) => '- 核对第 ' + (i + 1) + ' 项：逐条给实证').join('\n');

// 超限委派 B：正文超过字数上限（非列表长段落）
const LONG_PROMPT =
  '审查 docs/changes/demo.md，报告写入 docs/changes/demo.review-report.json。\n背景：' +
  '这是一段与审查范围无关的长背景说明。'.repeat(200);

// 围栏代码块里的内联 diff：40 行 +/- 行，若不剔除会被当成 40 个列表条目
const FENCED_DIFF =
  '\n```diff\n' +
  Array.from({ length: 40 }, (_, i) =>
    (i % 2 === 0 ? '+ added line ' + i : '- removed line ' + i)
  ).join('\n') +
  '\n```\n';

test('isReviewerDelegation：类型名含 reviewer（dev-sop:reviewer / reviewer）→ true；其他类型或无类型 → false', () => {
  assert.strictEqual(isReviewerDelegation(agentPayload('dev-sop:reviewer', 'x')), true);
  assert.strictEqual(isReviewerDelegation(agentPayload('reviewer', 'x')), true);
  assert.strictEqual(isReviewerDelegation(agentPayload('dev-sop:code-worker', 'x')), false);
  assert.strictEqual(isReviewerDelegation(agentPayload('dev-sop:prospector', 'x')), false);
  assert.strictEqual(isReviewerDelegation({ tool_name: 'Agent', tool_input: { prompt: 'x' } }), false);
});

test('assessReviewerPrompt：五项精简模板 → ok，条目数 = 5', () => {
  const r = assessReviewerPrompt(SLIM_PROMPT);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.items, 5);
  assert.ok(r.chars > 0 && r.chars <= r.maxChars);
  assert.strictEqual(r.maxChars, 1500);
  assert.strictEqual(r.maxItems, 10);
});

test('assessReviewerPrompt：列表条目 12 条 → items=12、ok=false（条目超限）', () => {
  const r = assessReviewerPrompt(CHECKLIST_PROMPT);
  assert.strictEqual(r.items, 12);
  assert.strictEqual(r.ok, false);
});

test('assessReviewerPrompt：正文非空白字符超过 1500 → ok=false；空白不计入字数', () => {
  const r = assessReviewerPrompt(LONG_PROMPT);
  assert.ok(r.chars > 1500);
  assert.strictEqual(r.ok, false);
  const blank = assessReviewerPrompt('   \n\t  '.repeat(500));
  assert.strictEqual(blank.chars, 0);
  assert.strictEqual(blank.ok, true);
});

test('assessReviewerPrompt：围栏代码块里的内联 diff 不计入字数与条目', () => {
  const base = assessReviewerPrompt(SLIM_PROMPT);
  const withDiff = assessReviewerPrompt(SLIM_PROMPT + FENCED_DIFF);
  assert.deepStrictEqual(withDiff, base);
  // 反例：同样内容去掉围栏标记后按正文计，40 行 diff 行被当成列表条目
  const unfenced = assessReviewerPrompt(SLIM_PROMPT + FENCED_DIFF.replace(/```/g, ''));
  assert.ok(unfenced.items >= 40);
  assert.strictEqual(unfenced.ok, false);
});

test('assessReviewerPrompt：未闭合围栏——其后的内容按代码块处理，不计入', () => {
  const r = assessReviewerPrompt('```\n- a\n- b\n+ c');
  assert.strictEqual(r.chars, 0);
  assert.strictEqual(r.items, 0);
  assert.strictEqual(r.ok, true);
});

test('assessReviewerPrompt：空串 / null / undefined → ok（不误拦）', () => {
  for (const v of ['', null, undefined]) {
    const r = assessReviewerPrompt(v);
    assert.strictEqual(r.chars, 0);
    assert.strictEqual(r.items, 0);
    assert.strictEqual(r.ok, true);
  }
});

test('REVIEWER_PROMPT_DENY_REASON：写明上限、五项模板与禁止事项', () => {
  for (const marker of ['正文 ≤1500 字', '条目 ≤10', '改动文件清单', '至多 3 条一行关注点', '不要写核对清单']) {
    assert.ok(REVIEWER_PROMPT_DENY_REASON.includes(marker), '拒绝文案缺少：' + marker);
  }
});

test('main() e2e：reviewer + 五项精简模板 → exit 0 放行且无 deny 输出', () => {
  const r = runGate('dev-sop:reviewer', SLIM_PROMPT);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e：reviewer + 围栏内联 diff（diff 本身不计）→ exit 0 放行', () => {
  const r = runGate('reviewer', SLIM_PROMPT + FENCED_DIFF);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e：reviewer + 条目超限的核对清单 → exit 2，deny 指向委派清单超限', () => {
  const r = runGate('dev-sop:reviewer', CHECKLIST_PROMPT);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.includes('reviewer 委派清单超限'));
});

test('main() e2e：reviewer + 正文超限 → exit 2 deny', () => {
  const r = runGate('dev-sop:reviewer', LONG_PROMPT);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e：非 reviewer 类型（code-worker）+ 同一份超限清单 → 不受影响，exit 0', () => {
  const r = runGate('dev-sop:code-worker', CHECKLIST_PROMPT);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e：未带 subagent_type 的旧式载荷 → 不按 reviewer 处理，验收类委派照常放行', () => {
  const r = runGateNoType(CHECKLIST_PROMPT);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});