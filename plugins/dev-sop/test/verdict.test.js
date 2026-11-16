'use strict';
// verdict.test.js — reviewer 判定规则纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/code-review.md 2.1 判定规则
//   任何 P0 → fail；P1 ≥ 3 → fail；仅 P2 或 P1 ≤ 2 → pass-with-issues；全清 → pass。
//   报告级：缺 verdict 字段 / 非法输入 → 按 fail 处理（accept-check 第五把钥匙据此阻断）。
//   第五把钥匙放行规则（v1.1.1 规格修订）：checkReviewReport 对 verdict 为 pass 或
//   pass-with-issues 的报告放行（pass-with-issues 需主会话经用户确认定稿）；
//   fail/未知取值/缺 verdict/报告缺失/非法 JSON 均阻断。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  computeVerdictFromIssues,
  effectiveReportVerdict,
  checkReviewReport,
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

// ---- checkReviewReport：第五把钥匙放行/阻断（v1.1.1 规格修订：pass-with-issues 放行）----

function writeTempReviewReport(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-verdict-'));
  const file = path.join(dir, 'review-report.json');
  fs.writeFileSync(file, JSON.stringify(report), 'utf8');
  return file;
}

function cleanupTempReviewReport(file) {
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
}

test('checkReviewReport：报告 verdict=pass-with-issues → 放行（返回 null）', () => {
  const file = writeTempReviewReport({
    verdict: 'pass-with-issues',
    issues: [{ severity: 'P2', file: 'a.js', line: 1, dim: '测试', desc: 'x', suggestion: 'y' }],
    summary: { p0: 0, p1: 0, p2: 1, checked: [] },
  });
  assert.strictEqual(checkReviewReport(file), null);
  cleanupTempReviewReport(file);
});

test('checkReviewReport：报告 verdict=fail → 阻断（返回原因，含 verdict=fail）', () => {
  const file = writeTempReviewReport({
    verdict: 'fail',
    issues: [],
    summary: { p0: 0, p1: 0, p2: 0, checked: [] },
  });
  const reason = checkReviewReport(file);
  assert.ok(typeof reason === 'string' && reason.includes('verdict=fail'));
  assert.ok(reason.includes('必须为 pass 或 pass-with-issues'));
  cleanupTempReviewReport(file);
});

test('checkReviewReport：报告 verdict 未知值 → 阻断（按 fail 处理）', () => {
  const file = writeTempReviewReport({ verdict: 'ok', issues: [], summary: {} });
  const reason = checkReviewReport(file);
  assert.ok(typeof reason === 'string' && reason.includes('verdict=ok'));
  assert.ok(reason.includes('必须为 pass 或 pass-with-issues'));
  cleanupTempReviewReport(file);
});
