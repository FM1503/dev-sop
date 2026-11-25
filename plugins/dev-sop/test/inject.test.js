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
  computePhaseHint,
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

test('REMINDER_TEXT：一行提醒文案含全部关键标记（v1.4.0 增补变更单标记；v1.5.0 增补执行书标记）', () => {
  for (const marker of [
    '十一条流程纪律',
    'status',
    'wireframe: approved',
    'docs/changes 变更单',
    'tier S/M',
    '执行书 docs/tasks/<slug>-exec.md',
    'exec-plan: exempt',
    'ui/test/review-report.json',
    'lint-report + accept 标记',
    '单命令≤2min',
    'reviewer 独立审查',
    '重读 spec 与任务书',
  ]) {
    assert.ok(REMINDER_TEXT.includes(marker), '提醒文案缺少标记：' + marker);
  }
  assert.ok(!REMINDER_TEXT.includes('\n'), '提醒必须只有一行');
});

test('CONTEXT_TEXT：十二条纪律完整，第 5 条含勘探义务+执行书+豁免（v1.5.0 改写），第 6 条含分级审查链（v1.10.0），第 11 条含分级路由（v1.4.0 新增），第 12 条含上下文账本（v1.11.0）', () => {
  for (let i = 1; i <= 12; i++) {
    assert.ok(CONTEXT_TEXT.includes(i + ')'), '缺少第 ' + i + ' 条');
  }
  const item5 = /5\)([^]*?)6\)/.exec(CONTEXT_TEXT);
  assert.ok(item5, '未能截取第 5 条');
  for (const marker of [
    '亲自勘探（Read/Grep）',
    '产出执行书内容',
    '文本级精确 old→new',
    '每步验证命令与预期输出',
    'S 级并入变更单改动清单',
    'worker 单轮完成落盘执行书+机械应用+验证',
    '（v1.6.0 单轮三步）',
    '默认补丁直改：勘探后生成补丁脚本嵌入执行书',
    'worker 仅执行执行命令',
    'Edit 备选需定位行号定向 Read',
    'code-worker 只机械应用',
    '不匹配即停报不重试',
    'exec-plan: exempt',
  ]) {
    assert.ok(item5[1].includes(marker), '第 5 条缺少标记：' + marker);
  }
  const item6 = /6\)([^]*?)7\)/.exec(CONTEXT_TEXT);
  assert.ok(item6, '未能截取第 6 条');
  assert.ok(item6[1].includes('改动文件清单'), '第 6 条须含改动文件清单');
  for (const marker of ['分级路由', '按判据定级', '单问快速通道', '禁止小改套全流程', 'docs/changes/<slug>.md', '才走全量流程', '判据不含 UI 文件']) {
    assert.ok(CONTEXT_TEXT.includes(marker), '第 11 条缺少标记：' + marker);
  }
});

test('CONTEXT_TEXT：第 6 条含统一 diff 审查与精简委派模板（v1.12.0），不再有快审/全审两套模式', () => {
  const item6 = /6\)([^]*?)7\)/.exec(CONTEXT_TEXT);
  assert.ok(item6, '未能截取第 6 条');
  for (const marker of [
    'v1.12.0',
    '统一委派 reviewer 做 diff 审查',
    '禁止复跑测试',
    '工具调用预算 ≤12',
    '改动文件清单',
    '至多 3 条一行关注点',
    '正文 ≤1500 字、条目 ≤10',
    '不得写核对清单',
    'fast-review',
    'full-review',
    'user-accepted',
    '复审轮只审修复产生的增量 diff',
  ]) {
    assert.ok(item6[1].includes(marker), '第 6 条缺少标记：' + marker);
  }
  for (const stale of ['全审模式', '全审六维', '报告四段', '复审轮优先消费执行书验证清单']) {
    assert.ok(!item6[1].includes(stale), '第 6 条仍残留旧模式表述：' + stale);
  }
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

// ---- v1.8.0 动态状态行：computePhaseHint 五态（规格 2.C，状态机与 flow-status 同源） ----

function mkProj(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-phase-'));
  for (const rel of Object.keys(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, files[rel], 'utf8');
  }
  return root;
}

function specDoc(slug, status, extra) {
  return '---\nstatus: ' + status + '\nslug: ' + slug + (extra ? '\n' + extra : '') + '\n---\n# ' + slug + '\n';
}

test('computePhaseHint：无 docs 目录 → 空串（无 docs 不加状态行）', () => {
  const root = mkProj({ 'README.md': '# no docs\n' });
  assert.strictEqual(computePhaseHint(root), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('computePhaseHint：draft spec → 一行【当前状态】待批准（含 slug，请呈报批准）', () => {
  const root = mkProj({ 'docs/specs/login.md': specDoc('login', 'draft', 'review: required') });
  const hint = computePhaseHint(root);
  assert.ok(hint.startsWith('【当前状态】待批准：'), hint);
  assert.ok(hint.includes('login'), hint);
  assert.ok(hint.includes('请呈报批准'), hint);
  assert.ok(!hint.includes('\n'), '状态行必须一行');
  fs.rmSync(root, { recursive: true, force: true });
});

test('computePhaseHint：approved 无实现标记 → 待实现；docs/tasks 执行书存在 → 转为缺 test-report', () => {
  // P1-3：spec 须声明非 none 的 code-files 才进入"缺 test-report"态（与 accept-check 对齐）
  const root = mkProj({ 'docs/specs/api.md': specDoc('api', 'approved', 'review: required\ncode-files: src/api.js') });
  assert.ok(computePhaseHint(root).startsWith('【当前状态】待实现：'), computePhaseHint(root));
  // 终修P2-6：声明的 code-files 须已落盘（否则判入未实现期"待实现"而非催报告），再验证执行书标记态
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'api.js'), '// impl\n', 'utf8');
  fs.mkdirSync(path.join(root, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'tasks', 'api-exec.md'), '# exec\n', 'utf8');
  const hint = computePhaseHint(root);
  assert.ok(hint.startsWith('【当前状态】缺 test-report：'), hint);
  assert.ok(hint.includes('api'), hint);
  fs.rmSync(root, { recursive: true, force: true });
});

test('终修P2-6 未实现期：spec 声明 code-files 文件均不存在 → 有执行书也显示待实现（不催报告）', () => {
  const root = mkProj({
    'docs/specs/gone.md': specDoc('gone', 'approved', 'review: required\ncode-files: src/gone.js'),
    'docs/tasks/gone-exec.md': '# exec\n',
  });
  const hint = computePhaseHint(root);
  assert.ok(hint.startsWith('【当前状态】待实现：'), hint);
  assert.ok(hint.includes('gone'), hint);
  assert.ok(!hint.includes('缺 test-report') && !hint.includes('缺 review-report'), '未实现期不得催报告：' + hint);
  fs.rmSync(root, { recursive: true, force: true });
});

test('终修P2-6 规则0：approved + wireframe 未批 → 待批准（线框）', () => {
  const root = mkProj({ 'docs/specs/wf.md': specDoc('wf', 'approved', 'wireframe: pending\nui-files: ui/wf.html') });
  const hint = computePhaseHint(root);
  assert.ok(hint.startsWith('【当前状态】待批准（线框）：'), hint);
  assert.ok(hint.includes('wf'), hint);
  assert.ok(hint.includes('请呈报批准'), hint);
  fs.rmSync(root, { recursive: true, force: true });
});

test('computePhaseHint：test-report 齐缺 review-report → 缺 review-report（委派 reviewer）；review: exempt 不再要求', () => {
  const root = mkProj({
    'docs/specs/core.md': specDoc('core', 'approved', 'review: required'),
    'docs/specs/core.test-report.json': '{"records":[],"summary":{"passed":0,"failed":0}}',
  });
  assert.ok(computePhaseHint(root).startsWith('【当前状态】缺 review-report：'), computePhaseHint(root));
  const exempt = mkProj({
    'docs/specs/tiny.md': specDoc('tiny', 'approved', 'review: exempt'),
    'docs/specs/tiny.test-report.json': '{}',
  });
  assert.ok(computePhaseHint(exempt).startsWith('【当前状态】全部合规：'), computePhaseHint(exempt));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(exempt, { recursive: true, force: true });
});

test('computePhaseHint：五态全齐（test+review 报告）→ 全部合规（可定稿）；S 级变更单免 test-report', () => {
  const root = mkProj({
    'docs/specs/feat.md': specDoc('feat', 'approved', 'review: required'),
    'docs/specs/feat.test-report.json': '{}',
    'docs/specs/feat.review-report.json': '{}',
  });
  assert.ok(computePhaseHint(root).startsWith('【当前状态】全部合规：'), computePhaseHint(root));
  assert.ok(computePhaseHint(root).includes('可定稿'), computePhaseHint(root));
  const sLevel = mkProj({
    'docs/changes/fix-typo.md': '---\nslug: fix-typo\nstatus: approved\ntier: S\n---\n# fix\n',
    'docs/tasks/fix-typo-exec.md': '# exec\n',
  });
  assert.ok(computePhaseHint(sLevel).startsWith('【当前状态】缺 review-report：'), computePhaseHint(sLevel));
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sLevel, { recursive: true, force: true });
});

test('computePhaseHint：优先级 first-match（draft 压在合规之上，一行只报最高优先级态）', () => {
  const root = mkProj({
    'docs/specs/ok.md': specDoc('ok', 'approved', 'review: required'),
    'docs/specs/ok.test-report.json': '{}',
    'docs/specs/ok.review-report.json': '{}',
    'docs/specs/wip.md': specDoc('wip', 'draft', ''),
  });
  const hint = computePhaseHint(root);
  assert.ok(hint.startsWith('【当前状态】待批准：wip'), hint);
  assert.ok(!hint.includes('ok'), '合规 slug 不应出现在待批准行：' + hint);
  fs.rmSync(root, { recursive: true, force: true });
});

test('decideInjection 追加位：状态行同时追加到首轮全文与一行提醒末尾；空 hint 旧文案逐字符不变（闩锁回归）', () => {
  const hint = '【当前状态】待批准：foo（请呈报批准）';
  const full = decideInjection('t1', false, hint);
  assert.ok(full.text.endsWith('\n' + hint), '首轮全文末尾未追加状态行');
  const rem = decideInjection('t1', true, hint);
  assert.ok(rem.text.endsWith('\n' + hint), '一行提醒末尾未追加状态行');
  // 空 hint：与 v1.7 文案逐字符一致（无 docs 不加）
  assert.strictEqual(decideInjection('t1', false, '').text, CONTEXT_TEXT + LATCH_NOTICE);
  assert.strictEqual(decideInjection('t1', true, '').text, REMINDER_TEXT);
  assert.strictEqual(decideInjection('t1', false).text, CONTEXT_TEXT + LATCH_NOTICE);
});
