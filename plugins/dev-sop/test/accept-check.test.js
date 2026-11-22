'use strict';
// accept-check.test.js — dev-sop v1.10.0 分级审查链单测（规格 docs/specs/review-speedup.md 2.A/2.C）
//
// 纯函数 assessReviewRequirement(input) → { allow, reason }：
//   ① lint 硬前置（所有级别、accept 不可豁免）：docs/specs|changes/<slug>.lint-report.json 存在
//      且 summary.violations=0，否则 block（reason 含违规数与"先修机器项"）；
//   ② tier S 变更单：lint 干净 → 放行（lite-reviewed-by-lint）；
//   ③ tier M 变更单 / spec（视为 L）：lint 干净 + review-report verdict∈{pass,pass-with-issues}
//      （fast-review / full-review）或有效 accept 标记（user-accepted），都缺 → block。
//   accept 标记：<slug>-accept.md（specs/changes 同 slug 任一），frontmatter accepted: true、
//   非空 quoted、slug 一致。
// 另有 main() e2e（Stop 门禁 block/allow + 四态 reason）与历史 spec 兼容场景。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'accept-check.js');
const {
  assessReviewRequirement,
  parseAcceptMarker,
  checkLintReport,
  findAcceptMarker,
  reviewChainReason,
} = require('../hooks/accept-check.js');

// ---- 纯函数用例 ----

function base(over) {
  return Object.assign(
    {
      slug: 'x',
      kind: 'spec', // 'spec' | 'change'
      tier: '', // 'S' | 'M' | ''（spec）
      implemented: true,
      lintReportPath: null,
      lintClean: false,
      reviewReportPath: null,
      reviewVerdict: null,
      acceptMarker: null,
    },
    over || {}
  );
}

test('分级链①：lint 报告缺失 → block，reason 含"先修机器项"', () => {
  const r = assessReviewRequirement(base({ kind: 'change', tier: 'S' }));
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /lint/);
  assert.match(r.reason, /先修机器项/);
});

test('分级链②：S 级 lint 违规（violations>0）→ block，reason 含违规数且不可被 accept 豁免', () => {
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'S', lintReportPath: 'l.json', lintClean: false, lintViolations: 3, acceptMarker: { ok: true } })
  );
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /3/);
  assert.match(r.reason, /先修机器项/);
});

test('分级链③：S 级 lint 干净 → 直接放行，reason=lite-reviewed-by-lint（无需 review-report）', () => {
  const r = assessReviewRequirement(base({ kind: 'change', tier: 'S', lintReportPath: 'l.json', lintClean: true }));
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'lite-reviewed-by-lint');
});

test('分级链④：M 级 lint 干净 + 快审 pass-with-issues → 放行，reason=fast-review', () => {
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l.json', lintClean: true, reviewReportPath: 'r.json', reviewVerdict: 'pass-with-issues' })
  );
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'fast-review');
});

test('分级链⑤：M 级 lint 干净 + 有效 accept 标记（无 review-report）→ 放行，reason=user-accepted', () => {
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l.json', lintClean: true, acceptMarker: { ok: true, quoted: '确认定稿' } })
  );
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'user-accepted');
});

test('分级链⑥：M 级 lint 干净但 review 与 accept 双缺 → block，reason 同时说明两条路径', () => {
  const r = assessReviewRequirement(base({ kind: 'change', tier: 'M', lintReportPath: 'l.json', lintClean: true }));
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /review-report/);
  assert.match(r.reason, /accept/i);
});

test('分级链⑦：spec（L）lint 干净 + review-report pass → 放行，reason=full-review', () => {
  const r = assessReviewRequirement(base({ kind: 'spec', lintReportPath: 'l.json', lintClean: true, reviewReportPath: 'r.json', reviewVerdict: 'pass' }));
  assert.strictEqual(r.allow, true);
  assert.strictEqual(r.reason, 'full-review');
});

test('分级链⑧：L 级 lint 干净 + 有效 accept 标记 → 放行 user-accepted；但 accept + lint 违规 → 仍 block', () => {
  const ok = assessReviewRequirement(base({ kind: 'spec', lintReportPath: 'l.json', lintClean: true, acceptMarker: { ok: true } }));
  assert.strictEqual(ok.reason, 'user-accepted');
  const bad = assessReviewRequirement(
    base({ kind: 'spec', lintReportPath: 'l.json', lintClean: false, lintViolations: 2, acceptMarker: { ok: true } })
  );
  assert.strictEqual(bad.allow, false);
  assert.match(bad.reason, /2/);
});

test('分级链⑨：review-report verdict=fail 且无 accept → block（快审未通过不因 lint 干净放行）', () => {
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l.json', lintClean: true, reviewReportPath: 'r.json', reviewVerdict: 'fail' })
  );
  assert.strictEqual(r.allow, false);
});

test('分级链⑩：accept 标记无 quoted（或 accepted 非 true）视为无效 → 不能单独放行', () => {
  const r = assessReviewRequirement(
    base({ kind: 'spec', lintReportPath: 'l.json', lintClean: true, acceptMarker: { ok: false, quoted: '' } })
  );
  assert.strictEqual(r.allow, false);
});

test('分级链⑪（历史兼容）：lint 报告缺失的 spec 场景 → block 且 reason 指明跑 review-lint --out 与 lint-report 路径', () => {
  const r = assessReviewRequirement(base({ kind: 'spec', lintReportPath: 'docs/specs/old.lint-report.json' }));
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /old\.lint-report\.json/);
  assert.match(r.reason, /review-lint/);
});

test('分级链⑫：链序（lint 先于 review/accept）——四态 reason 集合固定', () => {
  const states = new Set(['lite-reviewed-by-lint', 'fast-review', 'full-review', 'user-accepted']);
  const seen = new Set();
  for (const c of [
    base({ kind: 'change', tier: 'S', lintReportPath: 'l', lintClean: true }),
    base({ kind: 'change', tier: 'M', lintReportPath: 'l', lintClean: true, reviewReportPath: 'r', reviewVerdict: 'pass' }),
    base({ kind: 'spec', lintReportPath: 'l', lintClean: true, reviewReportPath: 'r', reviewVerdict: 'pass' }),
    base({ kind: 'spec', lintReportPath: 'l', lintClean: true, acceptMarker: { ok: true } }),
  ]) {
    const r = assessReviewRequirement(c);
    assert.ok(states.has(r.reason), '非四态 reason：' + r.reason);
    seen.add(r.reason);
  }
  assert.deepStrictEqual([...seen].sort(), [...states].sort());
  // lint 违规时永远 block，先于任何 review/accept 分支
  assert.strictEqual(assessReviewRequirement(base({ kind: 'change', tier: 'S', lintClean: false, acceptMarker: { ok: true } })).allow, false);
});

test('parseAcceptMarker：accepted/slug/quoted 齐备 → ok；quoted 空 / accepted: false / 无 quote → 非 ok', () => {
  const ok = parseAcceptMarker('---\naccepted: true\nslug: a\ndate: 2026-11-23\nquoted: "确认定稿 v1.9.0"\n---\n', 'a');
  assert.strictEqual(ok.ok, true);
  assert.match(ok.quoted, /确认定稿/);
  assert.strictEqual(parseAcceptMarker('---\naccepted: true\nslug: a\nquoted: ""\n---\n', 'a').ok, false);
  assert.strictEqual(parseAcceptMarker('---\naccepted: false\nslug: a\nquoted: ok\n---\n', 'a').ok, false);
  assert.strictEqual(parseAcceptMarker('---\naccepted: true\nslug: a\n---\n', 'a').ok, false);
  // slug 不一致 → 无效（防止标记错配）
  assert.strictEqual(parseAcceptMarker('---\naccepted: true\nslug: other\nquoted: ok\n---\n', 'a').ok, false);
});

test('findAcceptMarker：specs 或 changes 同 slug 任一即可', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-mk-'));
  fs.mkdirSync(path.join(root, 'docs', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'changes'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'docs', 'changes', 'm9-accept.md'),
    '---\naccepted: true\nslug: m9\ndate: 2026-11-23\nquoted: "好的，验收通过"\n---\n',
    'utf8'
  );
  const m = findAcceptMarker(root, 'm9');
  assert.strictEqual(m.ok, true);
  assert.ok(m.path.endsWith('m9-accept.md'));
  assert.strictEqual(findAcceptMarker(root, 'nope').ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkLintReport：缺失 / 非法 JSON / violations>0 / 干净 / 旧聚合结构 → 五种结论', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-lint-'));
  assert.strictEqual(checkLintReport(path.join(dir, 'none.json')).missing, true);
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, '{not json', 'utf8');
  assert.strictEqual(checkLintReport(bad).clean, false);
  assert.strictEqual(checkLintReport(bad).invalid, true);
  const dirty = path.join(dir, 'dirty.json');
  fs.writeFileSync(dirty, JSON.stringify({ producedBy: 'review-lint', target: 'c.md', slug: 'd', generatedAt: new Date().toISOString(), violations: [{ rule: 'x' }], warnings: [] }), 'utf8');
  assert.strictEqual(checkLintReport(dirty).clean, false);
  assert.strictEqual(checkLintReport(dirty).violations, 1);
  const clean = path.join(dir, 'clean.json');
  fs.writeFileSync(clean, JSON.stringify({ producedBy: 'review-lint', target: 'c.md', slug: 'c', generatedAt: new Date().toISOString(), violations: [], warnings: [] }), 'utf8');
  assert.strictEqual(checkLintReport(clean).clean, true);
  // 旧聚合结构（v1.10.1 及更早）→ 格式过期，判需重跑
  const legacy = path.join(dir, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ reports: [], summary: { violations: 0 } }), 'utf8');
  const lv = checkLintReport(legacy);
  assert.strictEqual(lv.clean, false, '旧聚合结构不得视为干净');
  assert.strictEqual(lv.stale, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reviewChainReason：四态之一；block 时为空串（日志 reason 构造）', () => {
  for (const s of ['lite-reviewed-by-lint', 'fast-review', 'full-review', 'user-accepted']) {
    assert.strictEqual(reviewChainReason(s), s);
  }
  assert.strictEqual(reviewChainReason(''), '');
  assert.strictEqual(reviewChainReason('blocked'), '');
});

// ---- main() e2e：临时项目 + 日志重定向（HOME 覆盖） ----

function e2e(over) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-e2e-'));
  const home = path.join(root, '.home');
  const w = (rel, content) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };
  if (over) over(w, root);
  const r = spawnSync('node', [HOOK], {
    cwd: root,
    encoding: 'utf-8',
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: root, HOME: home, USERPROFILE: home }),
    input: '{}',
  });
  let decision = 'allow';
  let reason = '';
  const out = (r.stdout || '').trim();
  if (out) {
    const j = JSON.parse(out);
    decision = j.decision;
    reason = String(j.reason || '');
  }
  let log = '';
  try {
    log = fs.readFileSync(path.join(home, '.zcode', 'hooks', 'dev-sop.log'), 'utf8');
  } catch (e) {
    log = '';
  }
  fs.rmSync(root, { recursive: true, force: true });
  return { decision, reason, log };
}

const NOW = () => new Date().toISOString();
const CLEAN_LINT = () => JSON.stringify({ producedBy: 'review-lint', target: 'x.md', slug: 'x', generatedAt: NOW(), violations: [], warnings: [] });
const DIRTY_LINT = () => JSON.stringify({ producedBy: 'review-lint', target: 'x.md', slug: 'x', generatedAt: NOW(), violations: [{ rule: 'placeholder', detail: 'x' }], warnings: [] });
// v1.10.3：结构正确但缺来源戳（手写伪造形态）
const UNSIGNED_LINT = () => JSON.stringify({ target: 'x.md', slug: 'x', generatedAt: NOW(), violations: [], warnings: [] });
const LEGACY_LINT = () => JSON.stringify({ reports: [{ violations: [], warnings: [] }], summary: { violations: 0 } });
const PASS_TEST = () => JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 0 } });

function changeNote(w, slug, tier) {
  w('docs/changes/' + slug + '.md', '---\nslug: ' + slug + '\nstatus: approved\ntier: ' + tier + '\nchanged-files: src/' + slug + '.js\n---\n# ' + slug + '\n');
  w('src/' + slug + '.js', 'module.exports = 1;\n');
  w('docs/tasks/' + slug + '-exec.md', '# exec\n');
}
function specDoc(w, slug) {
  w('docs/specs/' + slug + '.md', '---\nslug: ' + slug + '\nstatus: approved\nreview: required\ncode-files: src/' + slug + '.js\n---\n# ' + slug + '\n');
  w('src/' + slug + '.js', 'module.exports = 1;\n');
  w('docs/specs/' + slug + '.test-report.json', PASS_TEST());
  w('docs/tasks/' + slug + '-exec.md', '# exec\n');
}

test('e2e①：S 级变更单 + lint 干净 → allow，日志 reason=lite-reviewed-by-lint', () => {
  const { decision, log } = e2e((w) => {
    changeNote(w, 'es', 'S');
    w('docs/changes/es.lint-report.json', CLEAN_LINT());
  });
  assert.strictEqual(decision, 'allow');
  assert.match(log, /reason=lite-reviewed-by-lint/);
});

test('e2e②：S 级变更单 + lint 违规 → block，reason 含违规数与"先修机器项"；即使有 review-report 也不放行', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'es2', 'S');
    w('docs/changes/es2.lint-report.json', DIRTY_LINT());
    w('docs/changes/es2.review-report.json', JSON.stringify({ verdict: 'pass' }));
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /1/);
  assert.match(reason, /先修机器项/);
});

test('e2e③：M 级 + lint 干净 + 快审 pass-with-issues → allow，日志 reason=fast-review', () => {
  const { decision, log } = e2e((w) => {
    changeNote(w, 'em', 'M');
    w('docs/changes/em.lint-report.json', CLEAN_LINT());
    w('docs/changes/em.test-report.json', PASS_TEST());
    w('docs/changes/em.review-report.json', JSON.stringify({ verdict: 'pass-with-issues' }));
  });
  assert.strictEqual(decision, 'allow');
  assert.match(log, /reason=fast-review/);
});

test('e2e④：M 级 + lint 干净 + accept 标记（无 review-report）→ allow，日志 reason=user-accepted', () => {
  const { decision, log } = e2e((w) => {
    changeNote(w, 'em2', 'M');
    w('docs/changes/em2.lint-report.json', CLEAN_LINT());
    w('docs/changes/em2.test-report.json', PASS_TEST());
    w('docs/changes/em2-accept.md', '---\naccepted: true\nslug: em2\ndate: 2026-11-23\nquoted: "验收通过"\n---\n');
  });
  assert.strictEqual(decision, 'allow');
  assert.match(log, /reason=user-accepted/);
});

test('e2e⑤：M 级 + lint 干净 + 双缺 → block，reason 说明两条路径，且 block 文案不含任何 lint 指引（P1-A 修复轮2）', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'em3', 'M');
    w('docs/changes/em3.lint-report.json', CLEAN_LINT());
    w('docs/changes/em3.test-report.json', PASS_TEST());
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /review-report/);
  assert.match(reason, /accept/i);
  // P1-A：lint 干净时不得出现 lint 指引（此前误挂"先按上面 lint 提示清零"）
  assert.ok(!/lint/i.test(reason), 'lint 干净时 block 文案不得含 lint 措辞：' + reason);
  assert.ok(!/review-lint/.test(reason), 'lint 干净时不得提示重跑 review-lint');
  assert.ok(!/先按上面 lint 提示/.test(reason));
  assert.ok(!/S 级/.test(reason), 'spec/变更单 block 文案不应混入 S 级结案提示');
  // 应给出 review/accept 两条路径指引
  assert.match(reason, /需满足/);
  assert.match(reason, /em3\.review-report\.json/);
  assert.match(reason, /em3-accept\.md/);
});

test('e2e⑥：spec（L）+ lint 干净 + review-report pass → allow，日志 reason=full-review', () => {
  const { decision, log } = e2e((w) => {
    specDoc(w, 'el');
    w('docs/specs/el.lint-report.json', CLEAN_LINT());
    w('docs/specs/el.review-report.json', JSON.stringify({ verdict: 'pass' }));
  });
  assert.strictEqual(decision, 'allow');
  assert.match(log, /reason=full-review/);
});

test('e2e⑦：spec + accept 标记但 lint 违规 → 仍 block（机器项不可签字豁免）', () => {
  const { decision, reason } = e2e((w) => {
    specDoc(w, 'el2');
    w('docs/specs/el2.lint-report.json', DIRTY_LINT());
    w('docs/specs/el2-accept.md', '---\naccepted: true\nslug: el2\ndate: 2026-11-23\nquoted: "验收通过"\n---\n');
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /先修机器项/);
});

test('e2e⑧（历史兼容）：review: required 且已实现但无 lint-report 的历史 spec → block，reason 指明跑 review-lint --out', () => {
  const { decision, reason } = e2e((w) => {
    specDoc(w, 'eold');
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /lint-report/);
  assert.match(reason, /review-lint/);
});
// ---- 审查修复轮1（v1.10.2）：M 级 test-report 硬校验 / 旧 lint 结构 / accept date ----

test('v1.10.2 P1-1 纯函数：M 级 lint 干净 + review pass 但 testReportFailure 非空 → block（accept 不可豁免）', () => {
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l', lintClean: true, reviewReportPath: 'r', reviewVerdict: 'pass', testReportFailure: '验收测试报告 records 为空：x' })
  );
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /验收测试报告未通过/);
  assert.match(r.reason, /test-report/);
  const acc = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l', lintClean: true, acceptMarker: { ok: true }, testReportFailure: '缺少验收测试报告 x' })
  );
  assert.strictEqual(acc.allow, false, 'accept 标记不得豁免 M 级 test-report');
  const ok = assessReviewRequirement(
    base({ kind: 'change', tier: 'M', lintReportPath: 'l', lintClean: true, reviewReportPath: 'r', reviewVerdict: 'pass', testReportFailure: null })
  );
  assert.strictEqual(ok.allow, true);
});

test('v1.10.2 P1-2 旧聚合结构 lint 报告 → block 且 reason 提示"报告格式过期，需重跑 lint"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-leg-'));
  const legacy = path.join(dir, 'legacy.lint-report.json');
  fs.writeFileSync(legacy, LEGACY_LINT(), 'utf8');
  const lint = checkLintReport(legacy);
  assert.strictEqual(lint.stale, true);
  const r = assessReviewRequirement(
    base({ kind: 'change', tier: 'S', lintReportPath: legacy, lintClean: lint.clean, lintViolations: lint.violations, lintStale: lint.stale })
  );
  assert.strictEqual(r.allow, false);
  assert.match(r.reason, /格式过期/);
  assert.match(r.reason, /重跑 lint/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v1.10.2 P2 accept date：缺失/非法 → 标记仍有效但带 warning；合法日期无 warning', () => {
  const legacyOk = parseAcceptMarker('---\naccepted: true\nslug: a\nquoted: ok\n---\n', 'a');
  assert.strictEqual(legacyOk.ok, true);
  assert.match(legacyOk.warning, /缺少 date/);
  const bad = parseAcceptMarker('---\naccepted: true\nslug: a\ndate: 2026-13-45\nquoted: ok\n---\n', 'a');
  assert.strictEqual(bad.ok, true, 'date 非法不 block');
  assert.match(bad.warning, /date 非法/);
  const bad2 = parseAcceptMarker('---\naccepted: true\nslug: a\ndate: 11/23/2026\nquoted: ok\n---\n', 'a');
  assert.match(bad2.warning, /YYYY-MM-DD/);
  const good = parseAcceptMarker('---\naccepted: true\nslug: a\ndate: 2026-11-23\nquoted: ok\n---\n', 'a');
  assert.strictEqual(good.warning, '');
  assert.strictEqual(good.date, '2026-11-23');
});

test('e2e⑨：M 级 + lint 干净 + review-report pass 但缺 test-report → block（M 级 test-report 回归防护）', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'em4', 'M');
    w('docs/changes/em4.lint-report.json', CLEAN_LINT());
    w('docs/changes/em4.review-report.json', JSON.stringify({ verdict: 'pass' }));
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /验收测试报告未通过/);
  assert.match(reason, /em4\.test-report\.json/);
});

test('e2e⑩：M 级 + lint 干净 + review pass + test-report failed>0 → block，reason 含 failed 数', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'em5', 'M');
    w('docs/changes/em5.lint-report.json', CLEAN_LINT());
    w('docs/changes/em5.review-report.json', JSON.stringify({ verdict: 'pass' }));
    w('docs/changes/em5.test-report.json',
      JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 2 } }));
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /summary\.failed=2/);
});

test('e2e⑪：S 级 + lint 干净 + 无 test-report → allow（S 级仍免 test-report）', () => {
  const { decision, log } = e2e((w) => {
    changeNote(w, 'es6', 'S');
    w('docs/changes/es6.lint-report.json', CLEAN_LINT());
  });
  assert.strictEqual(decision, 'allow');
  assert.match(log, /reason=lite-reviewed-by-lint/);
});

test('e2e⑫：M 级 + 旧聚合结构 lint 报告 → block，提示报告格式过期需重跑 lint', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'em6', 'M');
    w('docs/changes/em6.lint-report.json', LEGACY_LINT());
    w('docs/changes/em6.test-report.json', PASS_TEST());
    w('docs/changes/em6.review-report.json', JSON.stringify({ verdict: 'pass' }));
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /格式过期/);
});
// ===== v1.10.3（修复轮2）：P1-A block 文案分流 + producedBy 来源戳校验 =====

test('v1.10.3 P1-A 纯函数：composeBlockMessage 在 lint 干净时不产生任何 lint 段', () => {
  const { composeBlockMessage, assessReviewRequirement } = require('../hooks/accept-check.js');
  const clean = assessReviewRequirement(base({ kind: 'change', tier: 'M', lintReportPath: 'l', lintClean: true }));
  const m1 = composeBlockMessage(clean, 'emx', 'change');
  assert.strictEqual(m1.lintState, 'clean');
  assert.strictEqual(m1.hasLintPart, false);
  assert.strictEqual(m1.lintPart, '');
  assert.ok(!/lint/i.test(m1.text), 'lint 干净时整段文案不得含 lint：' + m1.text);
  assert.match(m1.pathPart, /需满足/);
  assert.match(m1.pathPart, /emx\.review-report\.json/);
  assert.match(m1.pathPart, /emx-accept\.md/);

  const dirty = assessReviewRequirement(
    base({ kind: 'change', tier: 'S', lintReportPath: 'l', lintClean: false, lintViolations: 4 })
  );
  const m2 = composeBlockMessage(dirty, 'edx', 'change');
  assert.strictEqual(m2.lintState, 'blocked');
  assert.strictEqual(m2.hasLintPart, true);
  assert.match(m2.lintPart, /4 个违规/);
  assert.match(m2.lintPart, /重跑/);
  assert.match(m2.lintPart, /review-lint/);
  // lint 段必须排在路径段之前
  assert.ok(m2.text.indexOf(m2.lintPart) === 0, 'lint 段应在最前：' + m2.text);
});

test('e2e⑬（P1-A）：lint 干净 + spec 双缺 → block 文案不含 lint 措辞，只给 review/accept 指引', () => {
  const { decision, reason } = e2e((w) => {
    specDoc(w, 'ea1');
    w('docs/specs/ea1.lint-report.json', CLEAN_LINT());
  });
  assert.strictEqual(decision, 'block');
  assert.ok(!/lint/i.test(reason), 'lint 干净时不得含 lint 措辞：' + reason);
  assert.ok(!/先按上面 lint 提示/.test(reason));
  assert.match(reason, /需满足/);
  assert.match(reason, /ea1\.review-report\.json/);
  assert.match(reason, /ea1-accept\.md/);
});

test('e2e⑭（P1-A）：lint 违规 → block 文案含违规计数与"重跑 review-lint"，且路径项仍在', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'ed1', 'S');
    w('docs/changes/ed1.lint-report.json', DIRTY_LINT());
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /lint/);
  assert.match(reason, /1 个违规/);
  assert.match(reason, /重跑/);
  assert.match(reason, /review-lint/);
  assert.match(reason, /需满足/);
  assert.match(reason, /ed1\.review-report\.json/);
  // lint 段先于路径段
  assert.ok(reason.indexOf('重跑') < reason.indexOf('需满足'), 'lint 段应在路径段之前');
});

test('e2e⑮（P1-A）：旧聚合 lint 报告（lint 未清零族）→ block 文案提示格式过期需重跑，不出现"先按上面 lint 提示"挂错', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'ed2', 'M');
    w('docs/changes/ed2.lint-report.json', LEGACY_LINT());
    w('docs/changes/ed2.test-report.json', PASS_TEST());
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /格式过期/);
  assert.match(reason, /重跑/);
  assert.match(reason, /需满足/);
});

test('v1.10.3 checkLintReport：结构正确但缺 producedBy → stale（需重跑），不可视为干净', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-src-'));
  const p = path.join(dir, 'unsigned.json');
  fs.writeFileSync(p, UNSIGNED_LINT(), 'utf8');
  const r = checkLintReport(p);
  assert.strictEqual(r.clean, false, '缺来源戳不得判干净');
  assert.strictEqual(r.stale, true, '缺来源戳应判需重跑');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('v1.10.3 producedBy 错误值（非 review-lint）→ stale；review-lint → 正常读取 violations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-src2-'));
  const bad = path.join(dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ producedBy: 'handwritten', target: 'x.md', slug: 'x', generatedAt: NOW(), violations: [], warnings: [] }), 'utf8');
  assert.strictEqual(checkLintReport(bad).stale, true);
  const good = path.join(dir, 'good.json');
  fs.writeFileSync(good, JSON.stringify({ producedBy: 'review-lint', target: 'x.md', slug: 'x', generatedAt: NOW(), violations: [], warnings: [] }), 'utf8');
  assert.strictEqual(checkLintReport(good).clean, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('e2e⑯（producedBy）：lint 报告缺来源戳 → block 并提示重跑 lint', () => {
  const { decision, reason } = e2e((w) => {
    changeNote(w, 'eu1', 'S');
    w('docs/changes/eu1.lint-report.json', UNSIGNED_LINT());
  });
  assert.strictEqual(decision, 'block');
  assert.match(reason, /格式过期|不可信/);
  assert.match(reason, /重跑/);
  assert.match(reason, /review-lint/);
});
