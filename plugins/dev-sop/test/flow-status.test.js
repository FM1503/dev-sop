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
  return ['---', 'slug: ' + slug, 'status: ' + status, 'tier: S'].concat(
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
