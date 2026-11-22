'use strict';
// state-consistency.test.js — dev-sop v1.8.0 修复轮1 P1-3/P1-4 跨一致性测试
// 对同一临时项目分别 spawn 三个组件，断言其状态结论一致：
//   - hooks/inject.js        → 取【当前状态】一行（computePhaseHint）
//   - scripts/flow-status.mjs → 取状态表行（classify）
//   - hooks/accept-check.js   → 取 Stop 门禁 block/allow（checkChangeNote / code / review checks）
// 三者必须把每个 slug 归到同一桶：compliant / need-test / need-review。
// v1.10.0：accept-check 分级审查链以 lint-report 为硬前置，故一致性场景须同时提供干净
// lint 报告（docs/specs|changes/<slug>.lint-report.json，violations=0），否则 accept-check
// 以 lint 违规前置 block（该分支由 accept-check.test.js 的 e2e 场景覆盖）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INJECT = path.join(__dirname, '..', 'hooks', 'inject.js');
const FLOW = path.join(__dirname, '..', 'scripts', 'flow-status.mjs');
const ACCEPT = path.join(__dirname, '..', 'hooks', 'accept-check.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
}
function w(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
}

// v1.10.0：干净 lint 报告（分级链硬前置）
// v1.10.2：lint-report 覆盖语义新结构 {target,slug,generatedAt,violations,warnings}
const CLEAN_LINT = () => JSON.stringify({ producedBy: 'review-lint', target: 'x.md', slug: 'x', generatedAt: new Date().toISOString(), violations: [], warnings: [] });

// ---- 各组件 → canonical 桶 ----

// inject：spawn（无 session id → 不写闩锁；prompt 含开发意图触发状态行）
function injectBucket(root) {
  const r = spawnSync('node', [INJECT], {
    cwd: root,
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: root }),
    input: JSON.stringify({ prompt: '开发一个功能' }),
  });
  assert.strictEqual(r.status, 0, 'inject 应 exit 0: ' + r.stderr);
  let ctx = '';
  try {
    ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  } catch (e) {
    throw new Error('inject stdout 解析失败: ' + r.stdout + ' / ' + r.stderr);
  }
  const m = /【当前状态】([^\n]*)/.exec(ctx);
  assert.ok(m, 'inject 输出应含【当前状态】行: ' + ctx);
  const line = m[1];
  if (line.includes('缺 test-report')) return 'need-test';
  if (line.includes('缺 review-report')) return 'need-review';
  if (line.includes('缺 ui-report')) return 'need-ui'; // 终修 P2-6 ui 态
  if (line.includes('待实现')) return 'pending'; // 终修 P2-6 未实现期
  if (line.includes('全部合规')) return 'compliant';
  throw new Error('inject 状态行非预期态: ' + line);
}

// flow-status：spawn --root，解析表格（取唯一 slug 行的 state）
function flowBucket(root) {
  const r = spawnSync('node', [FLOW, '--root', root], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, 'flow-status 应 exit 0: ' + r.stderr);
  const states = [];
  for (const ln of r.stdout.split(/\r?\n/)) {
    const l = ln.trim();
    if (!l.startsWith('|') || /^[\s|:-]+$/.test(l)) continue;
    const cells = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells[0] === 'slug') continue;
    states.push(cells[2]);
  }
  assert.strictEqual(states.length, 1, '本测试每个项目恰含一个 slug，实得: ' + JSON.stringify(states));
  const s = states[0];
  if (s === '已实现缺test-report') return 'need-test';
  if (s === '缺review-report') return 'need-review';
  if (s === '已实现缺ui-report') return 'need-ui'; // 终修 P2-6 ui 态
  if (s === 'approved待实现') return 'pending'; // 终修 P2-6 未实现期
  if (s === '合规') return 'compliant';
  throw new Error('flow-status 状态非预期: ' + s);
}

// accept-check：spawn（stdin '{}'），解析 Stop decision
function acceptBucket(root) {
  const r = spawnSync('node', [ACCEPT], {
    cwd: root,
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: root }),
    input: '{}',
  });
  const out = (r.stdout || '').trim();
  if (!out) return 'compliant'; // allow：accept-check 放行不打印 stdout
  let j;
  try {
    j = JSON.parse(out);
  } catch (e) {
    throw new Error('accept-check stdout 非 JSON: ' + out + ' / ' + r.stderr);
  }
  if (j.decision !== 'block') return 'compliant';
  const reason = String(j.reason || '');
  if (/\.test-report\.json|验收测试报告/.test(reason)) return 'need-test';
  if (/\.review-report\.json|代码审查报告/.test(reason)) return 'need-review';
  if (/\.ui-report\.json|量化验收报告/.test(reason)) return 'need-ui'; // 终修 P2-6 ui 态
  throw new Error('accept-check block reason 非预期: ' + reason);
}

// ---- 场景构造 ----

test('一致性A：spec code-files 非 none + review:required，已实现无报告 → 三者均为 need-test', () => {
  const root = tmpRoot();
  w(root, 'docs/specs/aSpec.md', '---\nslug: aSpec\nstatus: approved\ncode-files: src/a.js\nreview: required\n---\n# aSpec\n');
  w(root, 'src/a.js', 'module.exports = 1;\n');
  w(root, 'docs/tasks/aSpec-exec.md', '# exec\n');
  w(root, 'docs/specs/aSpec.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.strictEqual(i, 'need-test');
  assert.deepStrictEqual([i, f, a], ['need-test', 'need-test', 'need-test']);
});

test('一致性B：tier S 变更单 review:exempt + review-report pass → 三者均为 compliant（不认 exempt，但有报告）', () => {
  const root = tmpRoot();
  w(root, 'docs/changes/bChg.md', '---\nslug: bChg\nstatus: approved\ntier: S\nreview: exempt\nchanged-files: src/b.js\n---\n# bChg\n');
  w(root, 'src/b.js', 'x\n');
  w(root, 'docs/changes/bChg.review-report.json', JSON.stringify({ verdict: 'pass' }));
  w(root, 'docs/changes/bChg.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.deepStrictEqual([i, f, a], ['compliant', 'compliant', 'compliant']);
});

test('一致性C：spec code-files none（纯文档）已实现无 review 字段 → 三者均为 compliant', () => {
  const root = tmpRoot();
  w(root, 'docs/specs/cDoc.md', '---\nslug: cDoc\nstatus: approved\ncode-files: none\n---\n# cDoc\n');
  w(root, 'docs/tasks/cDoc.md', '# task\n');
  w(root, 'docs/specs/cDoc.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.deepStrictEqual([i, f, a], ['compliant', 'compliant', 'compliant']);
});

test('一致性D：spec code-files 非 none + review:required + test-report 合规缺 review → 三者均为 need-review', () => {
  const root = tmpRoot();
  w(root, 'docs/specs/dFeat.md', '---\nslug: dFeat\nstatus: approved\ncode-files: src/d.js\nreview: required\n---\n# dFeat\n');
  w(root, 'src/d.js', 'd\n');
  w(root, 'docs/tasks/dFeat-exec.md', '# exec\n');
  w(
    root,
    'docs/specs/dFeat.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 5, result: 'pass' }], summary: { passed: 1, failed: 0 } })
  );
  w(root, 'docs/specs/dFeat.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.deepStrictEqual([i, f, a], ['need-review', 'need-review', 'need-review']);
});

// ===== 终修轮 P2-6：跨一致性测试补 2 场景 =====

test('一致性E（未实现期）：spec 声明 code-files 均不存在 + 有执行书/review:required → inject/flow 待实现、accept-check 放行（不催报告方向一致）', () => {
  const root = tmpRoot();
  w(root, 'docs/specs/eUn.md', '---\nslug: eUn\nstatus: approved\ncode-files: src/e.js\nreview: required\n---\n# eUn\n');
  w(root, 'docs/tasks/eUn-exec.md', '# exec\n');
  w(root, 'docs/specs/eUn.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.strictEqual(i, 'pending', 'inject 应显示待实现，实得=' + i);
  assert.strictEqual(f, 'pending', 'flow-status 应显示待实现，实得=' + f);
  // accept-check 对未实现期不拦（"文件不存在不要求报告"），与"待实现"同方向：均不催报告
  assert.strictEqual(a, 'compliant', 'accept-check 不得因缺报告拦截未实现期 slug');
});

test('一致性F（ui 态）：wireframe approved + ui-files 已实现缺 ui-report → 三者均为 need-ui', () => {
  const root = tmpRoot();
  w(
    root,
    'docs/specs/fUi.md',
    '---\nslug: fUi\nstatus: approved\nwireframe: approved\nneeds-ui: true\ncode-files: none\nui-files: ui/f.html\n---\n# fUi\n'
  );
  w(root, 'ui/f.html', '<html></html>\n');
  w(root, 'docs/tasks/fUi-exec.md', '# exec\n');
  w(root, 'docs/specs/fUi.lint-report.json', CLEAN_LINT());
  const i = injectBucket(root);
  const f = flowBucket(root);
  const a = acceptBucket(root);
  assert.deepStrictEqual([i, f, a], ['need-ui', 'need-ui', 'need-ui']);
});
