'use strict';
// context-ledger.test.js — dev-sop v1.11.0 跨会话上下文账本测试（spec docs/specs/context-ledger.md 第 5 节）
// TDD：先于实现编写，补丁前须确认失败（依赖未导出符号）。覆盖 A1~A4；A2 另由 inject.test.js 全绿兜底。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INJECT = path.join(__dirname, '..', 'hooks', 'inject.js');
const GATE = path.join(__dirname, '..', 'hooks', 'gate.js');
const ACCEPT = path.join(__dirname, '..', 'hooks', 'accept-check.js');

const inj = require('../hooks/inject.js');
const { CONTEXT_TEXT, LATCH_NOTICE, LEDGER_LATCH_FILE_PREFIX, LEDGER_BLOCK_MAX_BYTES, ledgerLatchFileFor, computeLedgerBlock, decideInjection, staleLatchFilesByPrefix } = inj;
const gateMod = require('../hooks/gate.js');
const { isWhitelisted } = gateMod;
const acc = require('../hooks/accept-check.js');
const { decideLedgerNag, CTX_TOUCH_PREFIX, CTX_NAG_PREFIX } = acc;

function tmpdir(p) { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
function w(abs, content) { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content, 'utf8'); }
function latchDir(home) { return path.join(home, '.zcode', 'hooks'); }
function ctxFile(home, prefix, sid) { return path.join(latchDir(home), prefix + sid); }

const INDEX_SAMPLE = [
  '# 上下文账本索引',
  '| 卡 | 一句话摘要 | 行数 |',
  '| ACTIVE.md | 进行中：demo-task@实现阶段 | 20 |',
  '| DECISIONS.md | 决策 3 条 | 12 |',
].join('\n');

// ---- T1 decideInjection ledgerBlock 参数（纯函数，A1/A2） ----
test('T1 无第 4 参 → 与 v1.10.3 逐字节一致', () => {
  const a = decideInjection('t1', false, 'HINT');
  assert.strictEqual(a.text, CONTEXT_TEXT + LATCH_NOTICE + '\n' + 'HINT');
  assert.strictEqual(a.withLedger, false);
  assert.strictEqual(decideInjection('t1', false).text, CONTEXT_TEXT + LATCH_NOTICE);
});
test('T1b inject-full 带账本 → notice 后、状态行前', () => {
  const r = decideInjection('t1', false, 'HINT', 'LEDGER');
  assert.strictEqual(r.text, CONTEXT_TEXT + LATCH_NOTICE + '\n' + 'LEDGER' + '\n' + 'HINT');
  assert.strictEqual(r.withLedger, true);
});
test('T1c reminder / 无 session 不带账本', () => {
  assert.strictEqual(decideInjection('t1', true, '', 'LEDGER').text.includes('LEDGER'), false);
  assert.strictEqual(decideInjection(null, false, '', 'LEDGER').text.includes('LEDGER'), false);
});

// ---- T2 computeLedgerBlock（A1） ----
test('T2 无账本项目 → 空串', () => {
  assert.strictEqual(typeof computeLedgerBlock, 'function');
  assert.strictEqual(computeLedgerBlock(tmpdir('cl-')), '');
});
test('T2b 正常 INDEX → 头部行 + 全内容、无截断', () => {
  const root = tmpdir('cl-');
  w(path.join(root, 'docs', 'context', 'INDEX.md'), INDEX_SAMPLE);
  const b = computeLedgerBlock(root);
  assert.ok(b.startsWith('【上下文账本】'));
  assert.ok(b.includes('demo-task@实现阶段'));
  assert.ok(!b.includes('截断'));
});
test('T2c 超预算 → 整块 ≤1536B 且含截断提示（A1）', () => {
  const root = tmpdir('cl-');
  const big = Array.from({ length: 300 }, (_, i) => 'line-' + 'x'.repeat(60) + i).join('\n');
  w(path.join(root, 'docs', 'context', 'INDEX.md'), big);
  const b = computeLedgerBlock(root);
  assert.ok(Buffer.byteLength(b, 'utf8') <= LEDGER_BLOCK_MAX_BYTES, 'bytes=' + Buffer.byteLength(b, 'utf8'));
  assert.ok(b.includes('截断'));
});
test('T2d INDEX > 60 行 → 归档提示', () => {
  const root = tmpdir('cl-');
  w(path.join(root, 'docs', 'context', 'INDEX.md'), Array.from({ length: 70 }, (_, i) => 'l' + i).join('\n'));
  assert.ok(computeLedgerBlock(root).includes('建议归档'));
});

// ---- T3 staleLatchFilesByPrefix（清理不误伤） ----
test('T3 按前缀清理过期闩锁', () => {
  const dir = tmpdir('cl-');
  const mk = (n, ageMs) => {
    const p = path.join(dir, n);
    fs.writeFileSync(p, 'x');
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(p, t, t);
  };
  mk('dev-sop-ledger-a.latch', 49 * 3600 * 1000);
  mk('dev-sop-ledger-b.latch', 1000);
  mk('dev-sop-inject-c.latch', 49 * 3600 * 1000);
  const stale = staleLatchFilesByPrefix(dir, 'dev-sop-ledger-');
  assert.deepStrictEqual(stale.map((p) => path.basename(p)), ['dev-sop-ledger-a.latch']);
});

// ---- T4 decideLedgerNag 矩阵（A4 纯函数） ----
test('T4 软门禁判定矩阵', () => {
  assert.strictEqual(decideLedgerNag({ ledgerExists: false, sessionId: 's', touchMs: 2, activeMs: 1, nagExists: false }), 'pass');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: null, touchMs: 2, activeMs: 1, nagExists: false }), 'pass');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: 's', touchMs: null, activeMs: 1, nagExists: false }), 'pass');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: 's', touchMs: 2, activeMs: 1, nagExists: true }), 'pass');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: 's', touchMs: 2, activeMs: 1, nagExists: false }), 'block');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: 's', touchMs: 2, activeMs: null, nagExists: false }), 'block');
  assert.strictEqual(decideLedgerNag({ ledgerExists: true, sessionId: 's', touchMs: 1, activeMs: 2, nagExists: false }), 'pass');
});

// ---- T5 gate 白名单 docs/context ----
test('T5 isWhitelisted：docs/context .md 放行 / 其他扩展名不放行', () => {
  assert.strictEqual(isWhitelisted('/p/docs/context/ACTIVE.md', '/p', 'docs/context/ACTIVE.md'), true);
  assert.strictEqual(isWhitelisted('/p/docs/context/x.json', '/p', 'docs/context/x.json'), true);
  assert.strictEqual(isWhitelisted('/p/docs/context/note.html', '/p', 'docs/context/note.html'), false);
});

// ---- e2e helpers ----
function runHook(hook, root, home, stdinObj) {
  const env = { ...process.env, ZCODE_PROJECT_DIR: root, HOME: home, USERPROFILE: home };
  return spawnSync('node', [hook], { input: JSON.stringify(stdinObj), env, encoding: 'utf8', timeout: 30000 });
}
function outCtx(r) {
  const line = (r.stdout || '').trim();
  if (!line) return null;
  try {
    return JSON.parse(line).hookSpecificOutput.additionalContext;
  } catch (e) {
    return null;
  }
}

// ---- T6（A2 e2e）无账本项目开发意图首轮：不含账本段 ----
test('T6 e2e 无账本注入回归', () => {
  const root = tmpdir('cl-');
  const home = tmpdir('clh-');
  w(path.join(root, 'docs', 'specs', 'x.md'), '---\nslug: x\nstatus: approved\n---\n# x\n');
  const r = runHook(INJECT, root, home, { prompt: '实现一个功能', session_id: 'sessA2' });
  const ctx = outCtx(r);
  assert.ok(typeof ctx === 'string' && ctx.length > 0);
  assert.ok(ctx.startsWith(CONTEXT_TEXT));
  assert.ok(!ctx.includes('【上下文账本】'));
});

// ---- T7（A1+A3）双会话模拟：会话1写卡 → 会话2 首轮回读索引 ----
test('T7 e2e 账本首轮注入 + 新会话接管 + 次轮静默', () => {
  const root = tmpdir('cl-');
  const home = tmpdir('clh-');
  w(path.join(root, 'docs', 'context', 'INDEX.md'), INDEX_SAMPLE);
  w(path.join(root, 'docs', 'context', 'ACTIVE.md'), '# 进行中任务\n## demo-task\n- 阶段：实现中\n- 下一步：应用补丁\n');
  const c1 = outCtx(runHook(INJECT, root, home, { prompt: '继续 demo-task 实现', session_id: 'sess1' }));
  assert.ok(c1.includes('【上下文账本】'));
  assert.ok(c1.includes('demo-task@实现阶段'));
  assert.ok(fs.existsSync(path.join(latchDir(home), LEDGER_LATCH_FILE_PREFIX + 'sess1.latch')));
  // 会话2（纯咨询意图）仅得账本块
  const r2 = runHook(INJECT, root, home, { prompt: '你好', session_id: 'sess2' });
  const c2 = outCtx(r2);
  assert.ok(c2 && c2.startsWith('【上下文账本】'));
  assert.ok(Buffer.byteLength(c2, 'utf8') <= LEDGER_BLOCK_MAX_BYTES);
  // 新会话凭注入 + 读 ACTIVE 复述当前状态（接管协议）
  const active = fs.readFileSync(path.join(root, 'docs', 'context', 'ACTIVE.md'), 'utf8');
  assert.ok(active.includes('下一步：应用补丁'));
  // 会话2 再次提问 → 静默（账本闩锁）
  const r3 = runHook(INJECT, root, home, { prompt: '你好', session_id: 'sess2' });
  assert.strictEqual((r3.stdout || '').trim(), '');
});

// ---- T8（A4 e2e）gate touch + accept 软门禁只拦一次 ----
test('T8 e2e 代码写入 touch → Stop block 一次 → 再 Stop 放行', () => {
  const root = tmpdir('cl-');
  const home = tmpdir('clh-');
  w(path.join(root, 'docs', 'specs', 't.md'), '---\nslug: t\nstatus: approved\ncode-files: none\n---\n# t\n');
  w(path.join(root, 'docs', 'context', 'INDEX.md'), INDEX_SAMPLE);
  w(path.join(root, 'docs', 'context', 'ACTIVE.md'), '# 进行中\n');
  const env = { ...process.env, ZCODE_PROJECT_DIR: root, HOME: home, USERPROFILE: home };
  const sid = 'sessNag';
  const g = spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_name: 'Edit', session_id: sid, tool_input: { file_path: path.join(root, 'scripts', 'probe.js') } }),
    env, encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(g.status, 0, 'gate 应放行 approved-spec 代码写入');
  assert.ok(fs.existsSync(ctxFile(home, CTX_TOUCH_PREFIX, sid)), 'touch 文件应存在');
  const t = (Date.now() - 5000) / 1000;
  fs.utimesSync(path.join(root, 'docs', 'context', 'ACTIVE.md'), t, t);
  const r1 = spawnSync('node', [ACCEPT], { input: JSON.stringify({ session_id: sid }), env, encoding: 'utf8', timeout: 30000 });
  const d1 = JSON.parse((r1.stdout || '{}').trim());
  assert.strictEqual(d1.decision, 'block');
  assert.ok(String(d1.reason).includes('账本未落盘'));
  assert.ok(fs.existsSync(ctxFile(home, CTX_NAG_PREFIX, sid)), 'nag 标记应落盘');
  const r2 = spawnSync('node', [ACCEPT], { input: JSON.stringify({ session_id: sid }), env, encoding: 'utf8', timeout: 30000 });
  const line2 = (r2.stdout || '').trim();
  const d2 = line2 ? JSON.parse(line2) : {};
  assert.notStrictEqual(d2.decision, 'block', '第二次 Stop 必须放行（只拦一次）');
});

// ---- T9（审查修复轮 P1）Agent 编码委派触点 ----
test('T9 gate Agent 编码委派 allow 时 touch；纯文档委派不 touch', () => {
  const root = tmpdir('cl-');
  const home = tmpdir('clh-');
  const env = { ...process.env, ZCODE_PROJECT_DIR: root, HOME: home, USERPROFILE: home };
  const sid = 'sessAgentTouch';
  const g = spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_name: 'Agent', session_id: sid, tool_input: { prompt: '按执行书 docs/tasks/demo-exec.md 修改 hooks/demo.js 并跑测试' } }),
    env, encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(g.status, 0);
  assert.ok(fs.existsSync(ctxFile(home, CTX_TOUCH_PREFIX, sid)), 'Agent 编码委派应 touch');
  const sid2 = 'sessDocOnly';
  const g2 = spawnSync('node', [GATE], {
    input: JSON.stringify({ tool_name: 'Agent', session_id: sid2, tool_input: { prompt: '写文档 docs/specs/plan.md 与报告 plan.test-report.json' } }),
    env, encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(g2.status, 0);
  assert.ok(!fs.existsSync(ctxFile(home, CTX_TOUCH_PREFIX, sid2)), '纯文档委派不应 touch');
});

// ---- T10（审查修复轮 P2-2）CONTEXT_TEXT 第 12 条断言 ----
test('T10 CONTEXT_TEXT 含第 12 条账本纪律关键标记', () => {
  for (const marker of ['12)', 'docs/context/', 'ACTIVE', 'GOTCHAS', '单卡 ≤150 行']) {
    assert.ok(CONTEXT_TEXT.includes(marker), '第 12 条缺少标记：' + marker);
  }
});
