'use strict';
// tier-routing.test.js — 分级路由新判定纯函数单测（TDD：先于实现编写）
// 规则来源：docs/specs/tier-routing.md 2.5 门禁适配
//   gate.js：docs/changes/*.md frontmatter 含 status: approved（10 行容错）→ 解锁写入
//   （reason: approved change note found）；docs/changes/ 白名单；Agent 正则扩为
//   docs/(specs|tasks|changes)/[\w\-\/\u4e00-\u9fa5]+\.md。
//   accept-check.js：变更单 tier S/M 且 approved 且 changed-files 任一存在 →
//   review-report verdict∈{pass,pass-with-issues}；M 另要求单条 test-report
//   （records≥1 全 pass）；mtime 最近 5 个变更单全为 tier S → 5-consecutive-S-hint。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  findApprovedChangeNote,
  referencesDocsPath,
  isWhitelisted,
} = require('../hooks/gate.js');
const {
  findChangeNotes,
  checkChangeNote,
  isFiveConsecutiveS,
} = require('../hooks/accept-check.js');

// ---- 临时项目工厂 ----

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-tier-'));
}

function writeChangeNote(root, name, frontmatter, body) {
  const dir = path.join(root, 'docs', 'changes');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    '---\n' + frontmatter.join('\n') + '\n---\n' + (body || '# 变更\n'),
    'utf8'
  );
  return file;
}

function writeJson(root, rel, obj) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return file;
}

const PASS_REVIEW = { verdict: 'pass', issues: [], summary: { p0: 0, p1: 0, p2: 0, checked: [] } };
const ONE_PASS_TEST = {
  records: [{ item: '受影响测试', command: 'node --test test/a.test.js', durationMs: 100, result: 'pass' }],
  summary: { passed: 1, failed: 0 },
};

// ---- gate.js：findApprovedChangeNote ----

test('findApprovedChangeNote：status: approved 的变更单 → 返回该文件路径', () => {
  const root = tempProject();
  const note = writeChangeNote(root, 'fix-typo.md', [
    'slug: fix-typo',
    'status: approved',
    'date: 2026-11-16',
    'tier: S',
    'changed-files: src/a.js',
  ]);
  assert.strictEqual(findApprovedChangeNote(root), note);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findApprovedChangeNote：status: draft → null（不解锁）', () => {
  const root = tempProject();
  writeChangeNote(root, 'fix-typo.md', [
    'slug: fix-typo',
    'status: draft',
    'tier: S',
    'changed-files: src/a.js',
  ]);
  assert.strictEqual(findApprovedChangeNote(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findApprovedChangeNote：引号取值 status: "approved" 同样识别', () => {
  const root = tempProject();
  const note = writeChangeNote(root, 'quoted.md', [
    'slug: quoted',
    'status: "approved"',
    'tier: M',
    'changed-files: src/a.js',
  ]);
  assert.strictEqual(findApprovedChangeNote(root), note);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findApprovedChangeNote：status 在 10 行窗口之外 → 不识别（10 行容错）', () => {
  const root = tempProject();
  const filler = Array.from({ length: 8 }, (_, i) => 'pad' + i + ': x');
  writeChangeNote(root, 'deep.md', [
    'slug: deep',
    ...filler,
    '---', // 第 10 行结束 frontmatter，status 落在窗口外
    'status: approved',
  ]);
  assert.strictEqual(findApprovedChangeNote(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findApprovedChangeNote：目录不存在 / 非 .md 文件 → null', () => {
  const root = tempProject();
  assert.strictEqual(findApprovedChangeNote(root), null);
  const dir = path.join(root, 'docs', 'changes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note.json'), '{"status": "approved"}', 'utf8');
  assert.strictEqual(findApprovedChangeNote(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- gate.js：referencesDocsPath（Agent 委派正则）----

test('referencesDocsPath：引用 docs/changes/c.md → 放行（v1.4.0 新增）', () => {
  assert.strictEqual(referencesDocsPath('请按 docs/changes/fix-typo.md 变更单修复'), true);
});

test('referencesDocsPath：反斜杠 docs\\changes\\c.md 同样识别', () => {
  assert.strictEqual(referencesDocsPath('按 docs\\changes\\fix-typo.md 执行'), true);
});

test('referencesDocsPath：docs/specs 与 docs/tasks 回归仍放行', () => {
  assert.strictEqual(referencesDocsPath('任务书 docs/tasks/todo.md 与规格 docs/specs/todo.md'), true);
});

test('referencesDocsPath：中文 slug 与子目录路径可识别', () => {
  assert.strictEqual(referencesDocsPath('见 docs/changes/修复-按钮/fix.md'), true);
});

test('referencesDocsPath：无任何 docs 引用 / 其他目录 → false', () => {
  assert.strictEqual(referencesDocsPath('直接修改 src/a.js'), false);
  assert.strictEqual(referencesDocsPath('见 docs/notes/c.md'), false);
  assert.strictEqual(referencesDocsPath(''), false);
});

// ---- gate.js：isWhitelisted（docs/changes 白名单）----

test('isWhitelisted：docs/changes/x.md → 白名单放行（同 docs/specs 待遇）', () => {
  const root = tempProject();
  assert.strictEqual(isWhitelisted(path.join(root, 'docs', 'changes', 'x.md'), root, 'docs/changes/x.md'), true);
  assert.strictEqual(isWhitelisted(path.join(root, 'docs', 'specs', 'x.md'), root, 'docs/specs/x.md'), true);
  assert.strictEqual(isWhitelisted(path.join(root, 'src', 'a.js'), root, 'src/a.js'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- accept-check.js：findChangeNotes ----

test('findChangeNotes：解析 slug/tier/status/changed-files 与 mtime', () => {
  const root = tempProject();
  writeChangeNote(root, 'fix-typo.md', [
    'slug: fix-typo',
    'status: approved',
    'date: 2026-11-16',
    'tier: S',
    'changed-files: src/a.js, src/b.js',
  ]);
  const notes = findChangeNotes(root);
  assert.strictEqual(notes.length, 1);
  assert.strictEqual(notes[0].slug, 'fix-typo');
  assert.strictEqual(notes[0].tier, 'S');
  assert.strictEqual(notes[0].status, 'approved');
  assert.deepStrictEqual(notes[0].changedFiles, ['src/a.js', 'src/b.js']);
  assert.ok(typeof notes[0].mtimeMs === 'number' && notes[0].mtimeMs > 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findChangeNotes：slug 缺失回退文件名；tier/status 大小写归一；changed-files 缺失为空数组', () => {
  const root = tempProject();
  writeChangeNote(root, 'no-slug.md', [
    'status: Approved',
    'tier: m',
  ]);
  const notes = findChangeNotes(root);
  assert.strictEqual(notes[0].slug, 'no-slug');
  assert.strictEqual(notes[0].tier, 'M');
  assert.strictEqual(notes[0].status, 'approved');
  assert.deepStrictEqual(notes[0].changedFiles, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('findChangeNotes：目录不存在 → 空数组（不抛错）', () => {
  assert.deepStrictEqual(findChangeNotes(tempProjectThenRemove(), ), []);
});

function tempProjectThenRemove() {
  const root = tempProject();
  fs.rmSync(root, { recursive: true, force: true });
  return root; // 已删除的目录路径：函数内部 existsSyncSafe 应安全返回空数组
}

// ---- accept-check.js：checkChangeNote ----

function makeNote(overrides) {
  return Object.assign(
    { slug: 'fix-typo', tier: 'S', status: 'approved', changedFiles: ['src/a.js'], mtimeMs: 1 },
    overrides || {}
  );
}

test('checkChangeNote：S + 文件已实现 + 缺 review-report → 失败（含报告路径）', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  const failure = checkChangeNote(makeNote(), root);
  assert.ok(typeof failure === 'string');
  assert.ok(failure.includes('docs' + path.sep + 'changes' + path.sep + 'fix-typo.review-report.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：S + review verdict=pass → 放行，且不要求 test-report', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'), PASS_REVIEW);
  // 不写任何 test-report → 仍应放行（S 免 test-report）
  assert.strictEqual(checkChangeNote(makeNote(), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：S + review verdict=fail → 失败（verdict 合规校验）', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'),
    Object.assign({}, PASS_REVIEW, { verdict: 'fail' }));
  const failure = checkChangeNote(makeNote(), root);
  assert.ok(typeof failure === 'string' && failure.includes('verdict=fail'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：S + verdict=pass-with-issues → 放行', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'),
    Object.assign({}, PASS_REVIEW, { verdict: 'pass-with-issues' }));
  assert.strictEqual(checkChangeNote(makeNote(), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：M + review 合规但缺 test-report → 失败', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'), PASS_REVIEW);
  const failure = checkChangeNote(makeNote({ tier: 'M' }), root);
  assert.ok(typeof failure === 'string');
  assert.ok(failure.includes('docs' + path.sep + 'changes' + path.sep + 'fix-typo.test-report.json'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：M + review 合规 + 单条全 pass test-report → 放行', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'), PASS_REVIEW);
  writeJson(root, path.join('docs', 'changes', 'fix-typo.test-report.json'), ONE_PASS_TEST);
  assert.strictEqual(checkChangeNote(makeNote({ tier: 'M' }), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：M + test-report records 有一条 fail → 失败', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  writeJson(root, path.join('docs', 'changes', 'fix-typo.review-report.json'), PASS_REVIEW);
  writeJson(root, path.join('docs', 'changes', 'fix-typo.test-report.json'), {
    records: [
      { item: 'a', command: 'node --test', durationMs: 10, result: 'pass' },
      { item: 'b', command: 'node --test', durationMs: 10, result: 'fail' },
    ],
    summary: { passed: 1, failed: 1 },
  });
  const failure = checkChangeNote(makeNote({ tier: 'M' }), root);
  assert.ok(typeof failure === 'string' && failure.includes('test-report'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：status: draft → 跳过（返回 null，不校验）', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  assert.strictEqual(checkChangeNote(makeNote({ status: 'draft' }), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：tier: L → 跳过（L 走 docs/specs 全量，不归变更单管辖）', () => {
  const root = tempProject();
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'x', 'utf8');
  assert.strictEqual(checkChangeNote(makeNote({ tier: 'L' }), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('checkChangeNote：changed-files 全部不存在 → 跳过（尚未实现，不拦）', () => {
  const root = tempProject();
  assert.strictEqual(checkChangeNote(makeNote({ changedFiles: ['src/not-yet.js'] }), root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

// ---- accept-check.js：isFiveConsecutiveS ----

function sNote(i) {
  return { slug: 's' + i, tier: 'S', status: 'approved', changedFiles: ['src/a.js'], mtimeMs: i };
}

function mNote(i) {
  return { slug: 'm' + i, tier: 'M', status: 'approved', changedFiles: ['src/a.js'], mtimeMs: i };
}

test('isFiveConsecutiveS：最近 5 个（mtime 降序）全为 tier S → true', () => {
  const notes = [sNote(1), sNote(2), sNote(3), sNote(4), sNote(5)];
  assert.strictEqual(isFiveConsecutiveS(notes), true);
});

test('isFiveConsecutiveS：乱序输入按 mtime 排序后判定', () => {
  const notes = [sNote(5), sNote(1), sNote(3), sNote(4), sNote(2)];
  assert.strictEqual(isFiveConsecutiveS(notes), true);
});

test('isFiveConsecutiveS：5 个中混入 1 个 M（更新）→ false', () => {
  const notes = [sNote(1), sNote(2), sNote(3), sNote(4), mNote(5)];
  assert.strictEqual(isFiveConsecutiveS(notes), false);
});

test('isFiveConsecutiveS：不足 5 个（全 S）→ false', () => {
  assert.strictEqual(isFiveConsecutiveS([sNote(1), sNote(2), sNote(3), sNote(4)]), false);
  assert.strictEqual(isFiveConsecutiveS([]), false);
});

test('isFiveConsecutiveS：mtime 第 6 旧的 M 不影响最近 5 个全 S → true', () => {
  const notes = [mNote(0), sNote(1), sNote(2), sNote(3), sNote(4), sNote(5)];
  assert.strictEqual(isFiveConsecutiveS(notes), true);
});
