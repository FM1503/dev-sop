'use strict';
// verdict.test.js — reviewer 判定规则纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/code-review.md 2.1 判定规则
//   任何 P0 → fail；P1 ≥ 3 → fail；仅 P2 或 P1 ≤ 2 → pass-with-issues；全清 → pass。
//   报告级：缺 verdict 字段 / 非法输入 → 按 fail 处理（accept-check 第五把钥匙据此阻断）。

const test = require('node:test');
const assert = require('node:assert');

const {
  computeVerdictFromIssues,
  effectiveReportVerdict,
} = require('../hooks/accept-check.js');

function issue(severity) {
  return { severity, file: 'a.js', line: 1, dim: '缺陷', desc: 'x', suggestion: 'y' };
}

// ---- computeVerdictFromIssues：按 issues 判定 ----

test('任一 P0 → fail', () => {
  assert.strictEqual(computeVerdictFromIssues([issue('P0')]), 'fail');
});

test('P0 与 P1/P2 混合时 P0 优先 → fail', () => {
  assert.strictEqual(
    computeVerdictFromIssues([issue('P2'), issue('P1'), issue('P0')]),
    'fail'
  );
});

test('P1 = 3（无 P0）→ fail', () => {
  assert.strictEqual(
    computeVerdictFromIssues([issue('P1'), issue('P1'), issue('P1')]),
    'fail'
  );
});

test('P1 = 2（无 P0）→ pass-with-issues', () => {
  assert.strictEqual(computeVerdictFromIssues([issue('P1'), issue('P1')]), 'pass-with-issues');
});

test('仅 P2 → pass-with-issues', () => {
  assert.strictEqual(computeVerdictFromIssues([issue('P2'), issue('P2')]), 'pass-with-issues');
});

test('全清（issues 为空数组）→ pass', () => {
  assert.strictEqual(computeVerdictFromIssues([]), 'pass');
});

test('issues 字段缺失（undefined）→ 视为无问题 → pass', () => {
  assert.strictEqual(computeVerdictFromIssues(undefined), 'pass');
});

test('severity 大小写不敏感（p0 亦计入 P0）→ fail', () => {
  assert.strictEqual(computeVerdictFromIssues([issue('p0')]), 'fail');
});

test('非法条目（null/非对象）被忽略，仅统计合法 severity', () => {
  assert.strictEqual(
    computeVerdictFromIssues([null, {}, 'P0', { severity: 'P2' }]),
    'pass-with-issues'
  );
});

// ---- effectiveReportVerdict：报告对象 → 生效 verdict ----

test('verdict=pass / pass-with-issues / fail 原样返回', () => {
  assert.strictEqual(effectiveReportVerdict({ verdict: 'pass' }), 'pass');
  assert.strictEqual(effectiveReportVerdict({ verdict: 'pass-with-issues' }), 'pass-with-issues');
  assert.strictEqual(effectiveReportVerdict({ verdict: 'fail' }), 'fail');
});

test('verdict 前后空白容错（" pass " → pass）', () => {
  assert.strictEqual(effectiveReportVerdict({ verdict: ' pass ' }), 'pass');
});

test('缺 verdict 字段 → 按 fail 处理', () => {
  assert.strictEqual(effectiveReportVerdict({ issues: [issue('P2')] }), 'fail');
  assert.strictEqual(effectiveReportVerdict({}), 'fail');
});

test('verdict 非字符串（数字/布尔）→ 按 fail 处理', () => {
  assert.strictEqual(effectiveReportVerdict({ verdict: 1 }), 'fail');
  assert.strictEqual(effectiveReportVerdict({ verdict: true }), 'fail');
});

test('未知 verdict 字符串 → 按 fail 处理', () => {
  assert.strictEqual(effectiveReportVerdict({ verdict: 'PASS' }), 'fail');
  assert.strictEqual(effectiveReportVerdict({ verdict: 'ok' }), 'fail');
});

test('非法输入（null/字符串/数字/数组）→ 按 fail 处理', () => {
  assert.strictEqual(effectiveReportVerdict(null), 'fail');
  assert.strictEqual(effectiveReportVerdict('pass'), 'fail');
  assert.strictEqual(effectiveReportVerdict(42), 'fail');
  assert.strictEqual(effectiveReportVerdict([{ verdict: 'pass' }]), 'fail');
});
