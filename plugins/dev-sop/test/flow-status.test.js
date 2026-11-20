'use strict';
// flow-status.test.js — dev-sop v1.8.0 断点续作状态扫描单测（规格 B / 验收 checklist 第 4 项）
// 多 slug 混合状态、仅 changes 来源、合规场景、无 docs 目录容错。状态判定：
// draft / approved待实现 / 已实现缺test-report / 缺review-report / 已实现缺ui-report / 合规。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'flow-status.mjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fs-'));
}
function specDoc(slug, { status = 'approved', needsUi } = {}) {
  // P1-4：spec 声明非 none 的 code-files 才要求 test-report；review: required 才要求 review-report（与 accept-check 对齐）
  return ['---', 'slug: ' + slug, 'status: ' + status, 'tier: S', 'code-files: app.js', 'review: required'].concat(
    needsUi ? ['needs-ui: true'] : [],
    ['---', '', '# spec ' + slug, '']
  ).join('\n');
}
function changeDoc(slug, { status = 'approved', needsUi } = {}) {
  return ['---', 'slug: ' + slug, 'status: ' + status, 'tier: S', 'changed-files: a.txt'].concat(
    needsUi ? ['needs-ui: true'] : [],
    ['---', '', '# change ' + slug, '']
  ).join('\n');
}
function ensure(root, sub) {
  const d = path.join(root, 'docs', sub);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function writeReport(root, sub, slug, kind) {
  const d = ensure(root, sub);
  fs.writeFileSync(path.join(d, slug + '.' + kind + '-report.json'), JSON.stringify({ verdict: 'pass' }));
}
function writeTask(root, slug, exec) {
  const d = ensure(root, 'tasks');
  fs.writeFileSync(path.join(d, slug + (exec ? '-exec.md' : '.md')), '# task');
}
function run(root) {
  const r = spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf-8' });
  return r;
}
function parseTable(stdout) {
  const rows = {};
  for (const line of stdout.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('|')) continue;
    if (/^[\s|:-]+$/.test(l)) continue; // 分隔行
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells[0] === 'slug') continue; // 表头
    rows[cells[0]] = { source: cells[1], state: cells[2], next: cells[3] };
  }
  return rows;
}

test('多 slug 混合状态：draft/待实现/缺test/缺review/缺ui/合规', () => {
  const root = tmp();
  // 终修P2-6：specDoc 声明 code-files: app.js，须落盘该文件，否则判入"未实现期"（待实现）而非缺报告态
  fs.writeFileSync(path.join(root, 'app.js'), '// implemented\n');
  const specs = ensure(root, 'specs');
  fs.writeFileSync(path.join(specs, 'slugA.md'), specDoc('slugA', { status: 'draft' }));
  fs.writeFileSync(path.join(specs, 'slugB.md'), specDoc('slugB', { status: 'approved' }));
  fs.writeFileSync(path.join(specs, 'slugC.md'), specDoc('slugC', { status: 'approved' }));
  fs.writeFileSync(path.join(specs, 'slugD.md'), specDoc('slugD', { status: 'approved' }));
  fs.writeFileSync(path.join(specs, 'slugE.md'), specDoc('slugE', { status: 'approved', needsUi: true }));
  fs.writeFileSync(path.join(specs, 'slugF.md'), specDoc('slugF', { status: 'approved' }));
  // C：实现标记（exec 任务书）但缺 test-report
  writeTask(root, 'slugC', true);
  // D：有 test-report 缺 review-report
  writeReport(root, 'specs', 'slugD', 'test');
  // E：有 test+review，needs-ui 缺 ui-report
  writeReport(root, 'specs', 'slugE', 'test');
  writeReport(root, 'specs', 'slugE', 'review');
  // F：test+review → 合规
  writeReport(root, 'specs', 'slugF', 'test');
  writeReport(root, 'specs', 'slugF', 'review');

  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
  const rows = parseTable(r.stdout);
  assert.strictEqual(rows.slugA.state, 'draft');
  assert.strictEqual(rows.slugA.next, '呈报批准');
  assert.strictEqual(rows.slugB.state, 'approved待实现');
  assert.strictEqual(rows.slugC.state, '已实现缺test-report');
  assert.strictEqual(rows.slugD.state, '缺review-report');
  assert.strictEqual(rows.slugE.state, '已实现缺ui-report');
  assert.strictEqual(rows.slugF.state, '合规');
  assert.strictEqual(rows.slugF.next, '可定稿');
});

test('仅 changes 来源：change slug 标 source=change', () => {
  const root = tmp();
  const changes = ensure(root, 'changes');
  fs.writeFileSync(path.join(changes, 'chg1.md'), changeDoc('chg1', { status: 'approved' }));
  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
  const rows = parseTable(r.stdout);
  assert.ok(rows.chg1, 'chg1 应在表中');
  assert.strictEqual(rows.chg1.source, 'change');
  assert.strictEqual(rows.chg1.state, 'approved待实现');
});

test('合规场景：spec 有 test+review report → 合规可定稿', () => {
  const root = tmp();
  // 终修P2-6：specDoc 声明 code-files: app.js，须落盘否则判入未实现期
  fs.writeFileSync(path.join(root, 'app.js'), '// implemented\n');
  const specs = ensure(root, 'specs');
  fs.writeFileSync(path.join(specs, 'ok.md'), specDoc('ok', { status: 'approved' }));
  writeReport(root, 'specs', 'ok', 'test');
  writeReport(root, 'specs', 'ok', 'review');
  const rows = parseTable(run(root).stdout);
  assert.strictEqual(rows.ok.source, 'spec');
  assert.strictEqual(rows.ok.state, '合规');
  assert.strictEqual(rows.ok.next, '可定稿');
});

test('无 docs 目录容错：空 root 输出表头 exit 0', () => {
  const root = tmp();
  const r = run(root);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\|\s*slug\s*\|\s*来源\s*\|/);
  // 无数据行
  assert.ok(!/合规|draft|待实现/.test(r.stdout));
});

// ===== 修复轮1：P1-4 change 来源的 test-report/review-report 谓词对齐 accept-check =====
function chg(root, slug, tier) {
  const changes = ensure(root, 'changes');
  fs.writeFileSync(
    path.join(changes, slug + '.md'),
    ['---', 'slug: ' + slug, 'status: approved', 'tier: ' + tier, 'changed-files: a.txt', '---', '', '# c'].join('\n')
  );
}

test('P1-4 tier S 变更单有 review-report 即合规（免 test-report）', () => {
  const root = tmp();
  chg(root, 'sfix', 'S');
  writeTask(root, 'sfix', true); // 实现标记
  writeReport(root, 'changes', 'sfix', 'review');
  const rows = parseTable(run(root).stdout);
  assert.strictEqual(rows.sfix.state, '合规', 'S 级 review-report 齐应判合规，不得报缺 test-report');
});

test('P1-4 tier S 变更单缺 review-report → 缺review-report；tier M 缺 test-report → 已实现缺test-report', () => {
  const root = tmp();
  chg(root, 's2', 'S');
  writeTask(root, 's2', true);
  chg(root, 'm1', 'M');
  writeTask(root, 'm1', true);
  const rows = parseTable(run(root).stdout);
  assert.strictEqual(rows.s2.state, '缺review-report');
  assert.strictEqual(rows.m1.state, '已实现缺test-report');
});

// ===== 终修轮：P2-5 引号值剥离（review:/tier: 与 accept-check 的 code-files 处理一致） =====
test('终修P2-5 带引号值：review: "required" → 缺review-report；tier: "M" → 已实现缺test-report', () => {
  const root = tmp();
  const specs = ensure(root, 'specs');
  fs.writeFileSync(
    path.join(specs, 'q1.md'),
    ['---', 'slug: q1', 'status: approved', 'code-files: none', 'review: "required"', '---', '', '# q1'].join('\n')
  );
  writeTask(root, 'q1', true); // 实现标记
  const changes = ensure(root, 'changes');
  fs.writeFileSync(
    path.join(changes, 'q2.md'),
    ['---', 'slug: q2', 'status: approved', "tier: 'M'", 'changed-files: a.txt', '---', '', '# q2'].join('\n')
  );
  writeTask(root, 'q2', true);
  const rows = parseTable(run(root).stdout);
  assert.strictEqual(rows.q1.state, '缺review-report', '双引号 required 应仍要求 review-report，实得=' + rows.q1.state);
  assert.strictEqual(rows.q2.state, '已实现缺test-report', "单引号 'M' 应要求 test-report，实得=" + rows.q2.state);
});

// ===== 终修轮：P2-6 规则 0（wireframe 未批）与未实现期 =====
test('终修P2-6 wireframe 未批 → 待批准（线框）；spec 声明文件均不存在 → 待实现（不催报告）', () => {
  const root = tmp();
  const specs = ensure(root, 'specs');
  // r1：approved 但 wireframe: pending → 规则 0 优先
  fs.writeFileSync(
    path.join(specs, 'r1.md'),
    ['---', 'slug: r1', 'status: approved', 'wireframe: pending', 'ui-files: ui/r1.html', 'code-files: none', '---', '', '# r1'].join('\n')
  );
  writeTask(root, 'r1', true);
  // r2：approved + review: required + 声明 code-files 但文件不存在 + exec 标记 → 未实现期 → 待实现
  fs.writeFileSync(
    path.join(specs, 'r2.md'),
    ['---', 'slug: r2', 'status: approved', 'review: required', 'code-files: src/r2.js', '---', '', '# r2'].join('\n')
  );
  writeTask(root, 'r2', true);
  const rows = parseTable(run(root).stdout);
  assert.strictEqual(rows.r1.state, '待批准（线框）', '实得=' + rows.r1.state);
  assert.strictEqual(rows.r1.next, '呈报批准');
  assert.strictEqual(rows.r2.state, 'approved待实现', '声明文件均不存在应判未实现期，实得=' + rows.r2.state);
});
