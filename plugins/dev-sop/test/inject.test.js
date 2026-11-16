'use strict';
// inject.test.js — inject 注入闩锁纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/efficiency-optimization.md 2.A 注入闩锁
//   stdin JSON 兼容 session_id/sessionId；缺失 → 回退现状全量注入（decision=inject）。
//   闩锁 ~/.zcode/hooks/dev-sop-inject-<id>.latch：不存在 → 全文（末尾追加一句
//   "本会话后续轮次将以一行提醒替代全文"）+ 创建闩锁 + decision=inject-full；
//   存在 → 一行提醒 + decision=inject-reminder。
//   创建闩锁时清理同目录 mtime>48h 的 dev-sop-inject-*.latch。
//   闩锁写失败 → 输出回退纯 CONTEXT_TEXT（不带提示句，P2-1 fail-open 对齐）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  extractSessionId,
  sanitizeSessionId,
  latchFileFor,
  LATCH_HOME_RELATIVE_DIR,
  LATCH_FILE_PREFIX,
  LATCH_NOTICE,
  REMINDER_TEXT,
  decideInjection,
  outputTextFor,
  staleLatchFiles,
  cleanStaleLatches,
  CONTEXT_TEXT,
} = require('../hooks/inject.js');

const HOUR_MS = 60 * 60 * 1000;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-inject-'));
}

// ---- extractSessionId：session_id / sessionId 兼容 ----

test('extractSessionId：session_id 存在 → 原样返回', () => {
  assert.strictEqual(extractSessionId({ session_id: 'abc', prompt: 'x' }), 'abc');
});

test('extractSessionId：sessionId 别名同样识别', () => {
  assert.strictEqual(extractSessionId({ sessionId: 'xyz' }), 'xyz');
});

test('extractSessionId：session_id 与 sessionId 并存时 session_id 优先', () => {
  assert.strictEqual(extractSessionId({ session_id: 'a', sessionId: 'b' }), 'a');
});

test('extractSessionId：缺失 / 非字符串 / 空串 → null（回退全量注入）', () => {
  assert.strictEqual(extractSessionId({ prompt: 'x' }), null);
  assert.strictEqual(extractSessionId({}), null);
  assert.strictEqual(extractSessionId(null), null);
  assert.strictEqual(extractSessionId({ session_id: 123 }), null);
  assert.strictEqual(extractSessionId({ session_id: '' }), null);
  assert.strictEqual(extractSessionId({ session_id: '  ' }), null);
});

// ---- sanitizeSessionId / latchFileFor：文件名安全 ----

test('sanitizeSessionId：路径分隔符与穿越字符被替换，长度受控', () => {
  const s = sanitizeSessionId('../../evil/id<>:x');
  assert.ok(!/[\\/:*?"<>|]/.test(s), '不得残留 Windows 非法字符');
  assert.ok(!s.includes('..'), '不得残留路径穿越片段');
  assert.ok(s.length > 0 && s.length <= 128);
});

test('latchFileFor：<homeDir>/.zcode/hooks/dev-sop-inject-<id>.latch', () => {
  const home = tempHome();
  const p = latchFileFor('t1', home);
  assert.strictEqual(p, path.join(home, '.zcode', 'hooks', 'dev-sop-inject-t1.latch'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('LATCH_HOME_RELATIVE_DIR / LATCH_FILE_PREFIX 常量符合规格路径', () => {
  assert.strictEqual(LATCH_HOME_RELATIVE_DIR, path.join('.zcode', 'hooks'));
  assert.strictEqual(LATCH_FILE_PREFIX, 'dev-sop-inject-');
});

// ---- decideInjection：首轮 / 次轮 / 无 id ----

test('decideInjection：有 id 且闩锁不存在 → inject-full，全文含追加句', () => {
  const r = decideInjection('t1', false);
  assert.strictEqual(r.decision, 'inject-full');
  assert.strictEqual(r.createLatch, true);
  assert.strictEqual(r.text, CONTEXT_TEXT + LATCH_NOTICE);
  assert.ok(r.text.endsWith('本会话后续轮次将以一行提醒替代全文。'));
});

test('decideInjection：有 id 且闩锁已存在 → inject-reminder，仅一行提醒', () => {
  const r = decideInjection('t1', true);
  assert.strictEqual(r.decision, 'inject-reminder');
  assert.strictEqual(r.createLatch, false);
  assert.strictEqual(r.text, REMINDER_TEXT);
});

test('decideInjection：无 sessionId → 回退现状全量（inject，无追加句）', () => {
  const r = decideInjection(null, false);
  assert.strictEqual(r.decision, 'inject');
  assert.strictEqual(r.createLatch, false);
  assert.strictEqual(r.text, CONTEXT_TEXT);
  assert.ok(!r.text.includes('一行提醒替代全文'));
});

// ---- outputTextFor：闩锁写失败回退（P2-1）----

test('outputTextFor：闩锁写失败时输出不含提示句（fail-open 与实际行为对齐）', () => {
  const plan = decideInjection('t1', false);
  assert.strictEqual(plan.decision, 'inject-full');
  // 写闩锁失败 → 回退纯 CONTEXT_TEXT，末尾不得含提示句
  const failed = outputTextFor(plan, false);
  assert.strictEqual(failed, CONTEXT_TEXT);
  assert.ok(!failed.endsWith(LATCH_NOTICE), '写失败时不得追加提示句');
  assert.ok(!failed.includes('一行提醒替代全文'));
  // 写闩锁成功 → 保留提示句
  assert.strictEqual(outputTextFor(plan, true), CONTEXT_TEXT + LATCH_NOTICE);
  // 其余分支不受闩锁写入结果影响
  assert.strictEqual(outputTextFor(decideInjection(null, false), false), CONTEXT_TEXT);
  assert.strictEqual(outputTextFor(decideInjection('t1', true), false), REMINDER_TEXT);
});

test('REMINDER_TEXT：一行提醒文案含全部关键标记', () => {
  for (const marker of [
    'status',
    'wireframe: approved',
    'ui/test/review-report.json',
    '单命令≤2min',
    'reviewer 独立审查',
    '重读 spec 与任务书',
  ]) {
    assert.ok(REMINDER_TEXT.includes(marker), '提醒文案缺少标记：' + marker);
  }
  assert.ok(!REMINDER_TEXT.includes('\n'), '提醒必须只有一行');
});

test('CONTEXT_TEXT：十条纪律完整，第 6 条含 diff 委派要求（v1.2.0 新增）', () => {
  for (let i = 1; i <= 10; i++) {
    assert.ok(CONTEXT_TEXT.includes(i + ')'), '缺少第 ' + i + ' 条');
  }
  assert.ok(CONTEXT_TEXT.includes('改动文件清单'));
  assert.ok(/6\)[^9]*?diff 获取方式/.test(CONTEXT_TEXT), '第 6 条须含 diff 获取方式');
});

// ---- staleLatchFiles / cleanStaleLatches：48h 清理 ----

test('staleLatchFiles：mtime>48h 被列出，48h 内与非 latch 文件不列', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-latch-'));
  const now = Date.now();
  const stale = path.join(dir, 'dev-sop-inject-old.latch');
  const fresh = path.join(dir, 'dev-sop-inject-new.latch');
  const other = path.join(dir, 'keep.log');
  fs.writeFileSync(stale, '');
  fs.writeFileSync(fresh, '');
  fs.writeFileSync(other, '');
  fs.utimesSync(stale, new Date(now - 49 * HOUR_MS), new Date(now - 49 * HOUR_MS));
  fs.utimesSync(fresh, new Date(now - 1 * HOUR_MS), new Date(now - 1 * HOUR_MS));
  const names = staleLatchFiles(dir, now, 48 * HOUR_MS).map((p) => path.basename(p));
  assert.ok(names.includes('dev-sop-inject-old.latch'));
  assert.strictEqual(names.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cleanStaleLatches：目录不存在不抛错；仅删除过期 latch', () => {
  const home = tempHome();
  const dir = path.join(home, '.zcode', 'hooks');
  assert.deepStrictEqual(cleanStaleLatches(path.join(home, 'no-such-dir')), 0);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const stale = path.join(dir, 'dev-sop-inject-stale.latch');
  const fresh = path.join(dir, 'dev-sop-inject-fresh.latch');
  fs.writeFileSync(stale, '');
  fs.writeFileSync(fresh, '');
  fs.writeFileSync(path.join(dir, 'dev-sop.log'), '');
  fs.utimesSync(stale, new Date(now - 72 * HOUR_MS), new Date(now - 72 * HOUR_MS));
  const removed = cleanStaleLatches(dir, now, 48 * HOUR_MS);
  assert.strictEqual(removed, 1);
  assert.ok(!fs.existsSync(stale), '过期闩锁应被删除');
  assert.ok(fs.existsSync(fresh), '48h 内闩锁应保留');
  assert.ok(fs.existsSync(path.join(dir, 'dev-sop.log')), '日志文件不得误删');
  fs.rmSync(home, { recursive: true, force: true });
});

test('decideInjection 边界：mtime 恰好 48h 整不属于过期（>48h 才清理）', () => {
  const home = tempHome();
  const dir = path.join(home, '.zcode', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const edge = path.join(dir, 'dev-sop-inject-edge.latch');
  fs.writeFileSync(edge, '');
  fs.utimesSync(edge, new Date(now - 48 * HOUR_MS), new Date(now - 48 * HOUR_MS));
  assert.strictEqual(staleLatchFiles(dir, now, 48 * HOUR_MS).length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});
