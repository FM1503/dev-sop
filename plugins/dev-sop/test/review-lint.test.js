'use strict';
// review-lint.test.js — dev-sop v1.8.0 机器预检单测（规格 3 / 验收 checklist 第 2 项）
// 四类检查 + exit code：fileset 子集违规 / linecap 超限 / placeholder 占位 / 干净通过；
// 另含 diff 命令失败容错（warning 不阻断）与 verify 缺 timeout 仅警告。
// diff 由可控假 diff.py 注入（读同目录 diff_config.json），避免依赖真实 git 仓库状态。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'review-lint.mjs');

const DIFF_PY = [
  'import sys, os, json',
  'cfg = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "diff_config.json")))',
  'if cfg.get("fail"): sys.exit(1)',
  'if "--name-only" in sys.argv:',
  '    sys.stdout.write("\\n".join(cfg.get("names", [])) + "\\n")',
  'else:',
  '    out = []',
  '    out.append("--- a")',
  '    out.append("+++ b")',
  '    for i in range(cfg.get("plus", 0)): out.append("+x")',
  '    for i in range(cfg.get("minus", 0)): out.append("-y")',
  '    sys.stdout.write("\\n".join(out) + "\\n")',
  '',
].join('\n');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rl-'));
}
function fm(slug, tier, changedFiles) {
  return ['---', 'slug: ' + slug, 'tier: ' + tier, 'changed-files: ' + changedFiles, '---', ''].join('\n');
}
function setup(dir, { names, plus = 0, minus = 0, fail = false }) {
  fs.writeFileSync(path.join(dir, 'diff.py'), DIFF_PY);
  fs.writeFileSync(path.join(dir, 'diff_config.json'), JSON.stringify({ names, plus, minus, fail }));
  return 'python "' + path.join(dir, 'diff.py').replace(/\\/g, '/') + '"';
}
function runLint(dir, md, diffCmd) {
  fs.writeFileSync(path.join(dir, 'change.md'), md);
  // diffCmd 省略 → 走脚本默认 git 形态（P2-6 真实仓库测试）；提供 → 注入可控假 diff（其余测试）
  const argv = diffCmd == null ? [SCRIPT, 'change.md'] : [SCRIPT, 'change.md', '--diff-cmd', diffCmd];
  const r = spawnSync('node', argv, { cwd: dir, encoding: 'utf-8' });
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    /* keep null */
  }
  return { result: r, json: parsed };
}

test('fileset 子集违规：diff 触及未声明文件', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt', 'surprise.txt'] });
  const md =
    fm('s1', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 1, '有违规应 exit 1');
  assert.ok(json.violations.some((v) => v.rule === 'fileset' && /surprise/.test(v.detail)));
});

test('linecap 超限：净变更行数 > S 级 30', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt'], plus: 20, minus: 15 }); // churn 35 > 30
  const md =
    fm('s2', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 1);
  assert.ok(json.violations.some((v) => v.rule === 'linecap' && /超过/.test(v.detail)));
});

test('placeholder 占位：新内容含 TODO', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt'] });
  const md =
    fm('s3', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | TODO finish this |\n\n## 验证\nnode --test && timeout\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 1);
  assert.ok(json.violations.some((v) => v.rule === 'placeholder' && /TODO/.test(v.detail)));
});

test('干净通过：四类检查全过 exit 0', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt'], plus: 2, minus: 1 });
  const md =
    fm('s4', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test s4.test.js && grep -q assert （timeout 60000）\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 0, '无违规应 exit 0，stderr=' + result.stderr);
  assert.strictEqual(json.violations.length, 0, JSON.stringify(json.violations));
});

test('diff 命令失败容错：仅 warning，不阻断 exit 0', () => {
  const dir = tmp();
  const cmd = setup(dir, { fail: true });
  const md =
    fm('s5', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 0, 'diff 失败不应因 fileset 误报，stderr=' + result.stderr);
  assert.ok(json.warnings.some((w) => w.rule === 'diff-failed'));
  assert.strictEqual(json.violations.length, 0);
});

test('警告不阻断：verify 缺 timeout → warning，exit 0', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt'], plus: 1, minus: 0 });
  const md =
    fm('s6', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test s6 && echo assert 检查\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 0, '仅警告应 exit 0');
  assert.strictEqual(json.violations.length, 0);
  assert.ok(json.warnings.some((w) => w.rule === 'verify-timeout'));
});

// ===== 修复轮1：P2-8 verify-timeout 不再被 params/items 误判 =====
test('P2-8 验证含 params 无 timeout → 仍出 verify-timeout 警告（旧 ms\\b 误判回归防护）', () => {
  const dir = tmp();
  const cmd = setup(dir, { names: ['a.txt'], plus: 1, minus: 0 });
  const md =
    fm('s8', 'S', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode test --params items.json && echo assert 检查\n';
  const { result, json } = runLint(dir, md, cmd);
  assert.strictEqual(result.status, 0);
  assert.ok(
    json.warnings.some((w) => w.rule === 'verify-timeout'),
    'params/items 不得被视为已声明 timeout'
  );
});

// ===== 修复轮1：P2-6 默认 diff 覆盖未跟踪/staged 新文件（真实 git 仓库） =====
function gitRepo() {
  const dir = tmp();
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8' });
    if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败: ' + (r.stderr || r.error));
  };
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'test']);
  // 忽略测试自身写入的 change.md，避免它作为未跟踪文件污染 fileset 校验
  fs.writeFileSync(path.join(dir, '.gitignore'), 'change.md\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  run(['add', '.gitignore', 'a.txt']);
  run(['commit', '-q', '-m', 'init']);
  // 制造三类触及：①修改已跟踪 ②staged 新建 ③未跟踪新建
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\nmodified\n');
  fs.writeFileSync(path.join(dir, 'staged.txt'), 'staged new\n');
  run(['add', 'staged.txt']);
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked new\n');
  return dir;
}

test('P2-6 默认 diff：未跟踪 + staged 新文件被纳入 fileset 校验', () => {
  let dir;
  try {
    dir = gitRepo();
  } catch (e) {
    console.log('跳过：git 不可用 - ' + e.message);
    return;
  }
  // 仅声明 a.txt → staged.txt / untracked.txt 应触发 fileset 违规
  const md =
    fm('g1', 'M', 'a.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | base | 1 | base |\n\n## 验证\nnode --test && timeout 60000\n';
  const { result, json } = runLint(dir, md);
  assert.strictEqual(result.status, 1, '未声明新文件应 exit 1');
  const det = json.violations.filter((v) => v.rule === 'fileset').map((v) => v.detail).join(' ');
  assert.match(det, /staged\.txt/, 'staged 新建文件应被检出');
  assert.match(det, /untracked\.txt/, '未跟踪新建文件应被检出');
});

test('P2-6 默认 diff：声明齐备时未跟踪/staged 不误报（exit 0）', () => {
  let dir;
  try {
    dir = gitRepo();
  } catch (e) {
    console.log('跳过：git 不可用 - ' + e.message);
    return;
  }
  const md =
    fm('g2', 'L', 'a.txt, staged.txt, untracked.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | base | 1 | base |\n\n## 验证\nnode --test && timeout 60000\n';
  const { result, json } = runLint(dir, md);
  assert.strictEqual(result.status, 0, '声明齐备应 exit 0，violations=' + JSON.stringify(json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'fileset').length, 0);
});

// ===== v1.10.0（docs/specs/review-speedup.md 2.A）：--out 聚合 + 三条新机器规则 =====

function project() {
  // 隔离沙箱：specs/ / tasks/ / changes/ / diff 均置于 <dir>/proj 下，lint 的 --out 相对 cwd
  const dir = tmp();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  return { dir, proj };
}
function wj(proj, rel, content) {
  const abs = path.join(proj, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf-8');
  return abs;
}
function specFm(slug, extra) {
  return '---\nslug: ' + slug + '\nstatus: approved\n' + (extra ? extra + '\n' : '') + '---\n# ' + slug + '\n';
}
// 干净变更单正文（变更表无占位、验证含断言+timeout）
const CLEAN_BODY =
  '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
  '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout 60000\n';

function runLintOut(ctx, mdRel, args) {
  fs.writeFileSync(path.join(ctx.proj, mdRel), ctx.md, 'utf-8'); // 入口文件由调用方经 ctx.md 提供
  // 项目根 = proj 子目录（隔离沙箱，避免跨用例串扰）：--out 为相对 proj 的路径
  const r = spawnSync('node', [SCRIPT, mdRel].concat(args || []), { cwd: ctx.proj, encoding: 'utf-8' });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch (e) {
    /* keep null */
  }
  return { result: r, json };
}

test('v1.10.0 --out 首建：结构 {target,slug,generatedAt,violations,warnings}，stdout 与本次结果一致', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  ctx.md = fm('o1', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', 'docs/specs/o1.lint-report.json']);
  assert.strictEqual(result.status, 0, 'stderr=' + result.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(ctx.proj, 'docs', 'specs', 'o1.lint-report.json'), 'utf-8'));
  assert.ok(Array.isArray(out.violations), '必须含 violations 数组');
  assert.ok(Array.isArray(out.warnings), '必须含 warnings 数组');
  assert.strictEqual(out.slug, 'o1');
  assert.strictEqual(out.target, 'change.md');
  assert.ok(!Number.isNaN(Date.parse(out.generatedAt)), 'generatedAt 须为 ISO 时间戳：' + out.generatedAt);
  assert.deepStrictEqual(out.violations, json.violations);
  assert.deepStrictEqual(out.warnings, json.warnings);
});

test('v1.10.2 --out 覆盖：第二次运行整体替换旧脏报告（不追加、不留历史 violation）', () => {
  const ctx = project();
  const outRel = 'docs/specs/o2.lint-report.json';
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  // 第一次：placeholder 1 条违规
  ctx.md = (fm('o2', 'S', 'a.txt') + CLEAN_BODY).replace('| 1 | a.txt | 1 | x | 1 | y |', '| 1 | a.txt | 1 | x | 1 | TODO x |');
  const first = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', outRel]);
  assert.strictEqual(first.json.violations.length, 1);
  // 第二次：干净 → 报告应被整体替换为 0 违规
  ctx.md = fm('o2', 'S', 'a.txt') + CLEAN_BODY;
  const second = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', outRel]);
  const out = JSON.parse(fs.readFileSync(path.join(ctx.proj, outRel), 'utf-8'));
  assert.strictEqual(out.reports, undefined, '不得再写聚合 reports 结构');
  assert.strictEqual(out.violations.length, 0, '覆盖写后旧违规不得残留：' + JSON.stringify(out.violations));
  assert.strictEqual(second.json.reports, undefined, 'stdout 只输出本次 {violations,warnings}');
});

test('v1.10.0 exec-missing 正：spec 声明 review: required 但无执行书/变更单 → violation', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/m1.md', specFm('m1', 'review: required\ncode-files: src/m1.js'));
  ctx.md = fm('m1', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 1);
  assert.ok(json.violations.some((v) => v.rule === 'exec-missing' && /m1/.test(v.detail)), JSON.stringify(json.violations));
});

test('v1.10.0 exec-missing 反：变更单存在（docs/changes/<slug>.md）→ 不报；review: exempt 的 spec 不查', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/m2.md', specFm('m2', 'review: required\ncode-files: src/m2.js'));
  wj(ctx.proj, 'docs/changes/m2.md', '---\nslug: m2\nstatus: approved\ntier: S\nchanged-files: a.txt\n---\n# m2\n');
  wj(ctx.proj, 'docs/specs/m3.md', specFm('m3', 'review: exempt\ncode-files: src/m3.js'));
  ctx.md = fm('m4', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'exec-missing').length, 0);
});

test('v1.10.0 test-cmd-empty 正：test-report records[].command 空串 → violation', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(
    ctx.proj,
    'docs/changes/m5.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }, { item: 'b', command: '', durationMs: 1, result: 'pass' }], summary: { passed: 2, failed: 0 } })
  );
  ctx.md = fm('m5', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 1);
  assert.ok(json.violations.some((v) => v.rule === 'test-cmd-empty' && /m5/.test(v.detail)), JSON.stringify(json.violations));
});

test('v1.10.0 test-cmd-empty 反：command 为真实命令（含 records 缺失 command 的 spec 目录检查分离）→ 0 违规', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(
    ctx.proj,
    'docs/specs/m6.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 0 } })
  );
  ctx.md = fm('m6', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'test-cmd-empty').length, 0);
});

test('v1.10.0 lint-stale 正：lint-report 早于受审对象声明文件 → 提示过期（v1.10.3 起为 warning 不阻断）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/m7c.md', specFm('m7c', 'tier: S\ncode-files: src/m7c.js'));
  wj(ctx.proj, 'docs/tasks/m7c-exec.md', '# exec\n');
  const implTc = wj(ctx.proj, 'src/m7c.js', 'x\n');
  fs.utimesSync(implTc, new Date(), new Date());
  const reportTc = wj(ctx.proj, 'docs/specs/m7c.lint-report.json', JSON.stringify({ reports: [], summary: { violations: 0 } }));
  fs.utimesSync(reportTc, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
  const report = wj(ctx.proj, 'docs/specs/m7.lint-report.json', JSON.stringify({ reports: [], summary: { violations: 0 } }));
  wj(ctx.proj, 'docs/specs/m7.md', specFm('m7', 'code-files: src/m7.js'));
  const impl = wj(ctx.proj, 'src/m7.js', 'x\n');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(report, old, old);
  fs.utimesSync(impl, new Date(), new Date());
  ctx.md = fm('m7c', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json.violations));
  assert.ok(
    json.warnings.some((w) => w.rule === 'lint-stale' && /过期/.test(w.detail)),
    '过期报告应提示 lint-stale warning：' + JSON.stringify(json.warnings)
  );
});

test('v1.10.0 lint-stale 反：lint-report 晚于受审对象文件 / 无报告 → 不报', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/m8.md', specFm('m8', 'code-files: src/m8.js'));
  const impl = wj(ctx.proj, 'src/m8.js', 'x\n');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(impl, old, old);
  wj(ctx.proj, 'docs/specs/m8.lint-report.json', JSON.stringify({ reports: [], summary: { violations: 0 } }));
  ctx.md = fm('m8', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'lint-stale').length, 0);
});

test('v1.10.0 --out 值不被当作输入文件；无法写入 --out → exit 1 且 stderr 提示', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  ctx.md = fm('o3', 'S', 'a.txt') + CLEAN_BODY;
  // 以已存在目录充当 --out 目标 → 写盘 EISDIR 失败
  fs.mkdirSync(path.join(ctx.proj, 'outdir'));
  const bad = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', 'outdir']);
  assert.strictEqual(bad.result.status, 1, '写 --out 失败应 exit 1');
  assert.match(bad.result.stderr, /lint-report|--out|写入/i);
});
// ===== v1.10.1（fix 轮）：三规则按 slug 作用域 / test-report 等价证据 / --repo / --project-scan =====

test('v1.10.1 slug 隔离：目标变更单不因项目内其他 spec 缺执行证据而违规', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  // 其他条目 specOther 声明 review: required 且无任何执行证据；目标 o10 有变更单
  wj(ctx.proj, 'docs/specs/specOther.md', specFm('specOther', 'review: required\ncode-files: src/other.js'));
  wj(ctx.proj, 'docs/changes/o10.md', '---\nslug: o10\ntier: S\nchanged-files: a.txt\n---\n# o10\n');
  ctx.md = fm('o10', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'exec-missing').length, 0);
});

test('v1.10.1 test-report 等价执行证据：仅 docs/specs/<slug>.test-report.json 存在 → 无 exec-missing', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/o11.md', specFm('o11', 'review: required\ncode-files: src/o11.js'));
  wj(ctx.proj, 'docs/specs/o11.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 0 } }));
  ctx.md = fm('o11', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'exec-missing').length, 0);
});

test('v1.10.1 三者全无才 exec-missing：目标 spec 无 exec / 变更单 / test-report', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/o12.md', specFm('o12', 'review: required\ncode-files: src/o12.js'));
  ctx.md = fm('o12', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 1);
  const hits = json.violations.filter((v) => v.rule === 'exec-missing');
  assert.strictEqual(hits.length, 1, JSON.stringify(json.violations));
  assert.match(hits[0].detail, /无任何执行证据/);
});

test('v1.10.1 test-cmd-empty 按 slug 过滤：其他 slug 的空 command 不影响目标', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/changes/other.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: '', durationMs: 1, result: 'pass' }] }));
  wj(ctx.proj, 'docs/changes/o13.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: 'node --test', durationMs: 1, result: 'pass' }] }));
  ctx.md = fm('o13', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json && json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'test-cmd-empty').length, 0);
});

test('v1.10.1 --project-scan：跨 slug 汇总，写独立 <root>/docs/specs/_project-scan.lint-report.json', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: [], plus: 0, minus: 0 });
  wj(ctx.proj, 'docs/specs/p1.md', specFm('p1', 'review: required\ncode-files: src/p1.js'));
  wj(ctx.proj, 'docs/specs/p2.md', specFm('p2', 'review: required\ncode-files: src/p2.js'));
  // 显式 --diff-cmd 避免依赖 git；--project-scan 无位置参数文件；显式 --out
  const scanRel = 'docs/specs/_project-scan.lint-report.json';
  const r = spawnSync('node', [SCRIPT, '--project-scan', '--repo', ctx.proj, '--diff-cmd', cmd, '--out', scanRel], { cwd: ctx.proj, encoding: 'utf-8' });
  const json = JSON.parse(r.stdout);
  const scanPath = path.join(ctx.proj, scanRel);
  assert.ok(fs.existsSync(scanPath), '应写独立 _project-scan.lint-report.json，stderr=' + r.stderr);
  const out = JSON.parse(fs.readFileSync(scanPath, 'utf-8'));
  // v1.10.2 覆盖语义：{target,slug,generatedAt,violations,warnings,scope}
  assert.strictEqual(out.scope, 'project-scan');
  assert.ok(Array.isArray(out.violations));
  const slugs = out.violations.filter((v) => v.rule === 'exec-missing').map((v) => v.detail).join(' ');
  assert.match(slugs, /p1/);
  assert.match(slugs, /p2/);
  assert.deepStrictEqual(json.violations, out.violations);
});

test('v1.10.1 --repo 生效：仓库内跑 docs/specs 路径时 git diff 在 repo 根执行，无 diff-failed', () => {
  let dir;
  try {
    dir = gitRepo();
  } catch (e) {
    console.log('跳过：git 不可用 - ' + e.message);
    return;
  }
  // 目标文件位于 <repo>/docs/specs/，从插件子目录 cwd 以 --repo <repo> 运行
  const specRel = 'docs/specs/mixed.md';
  fs.mkdirSync(path.join(dir, 'docs', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, specRel), fm('g-repo', 'L', 'a.txt') + CLEAN_BODY, 'utf-8');
  const r = spawnSync('node', [SCRIPT, specRel, '--repo', dir], { cwd: __dirname, encoding: 'utf-8' });
  const json = JSON.parse(r.stdout);
  assert.ok(json, 'stderr=' + r.stderr);
  assert.strictEqual(json.warnings.filter((w) => w.rule === 'diff-failed').length, 0,
    '--repo 应使 git diff 在仓库根成功，warnings=' + JSON.stringify(json.warnings));
});

test('v1.10.1 无 git 时 diff-failed 仅为 warning 非 violation（退出码不受它影响）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: [], plus: 0, minus: 0, fail: true });
  ctx.md = fm('o14', 'L', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, '只有 warning 时应 exit 0，violations=' + JSON.stringify(json.violations));
  assert.ok(json.warnings.some((w) => w.rule === 'diff-failed'));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'diff-failed').length, 0);
});
test('终修P2-4 未跟踪目录内新文件：已声明则 exit 0，不得报 "dir/" 违规', () => {
  let dir;
  try {
    dir = gitRepo();
  } catch (e) {
    console.log('跳过：git 不可用 - ' + e.message);
    return;
  }
  // NEWFILE 常见形态：新建子目录内放新文件（未跟踪）。旧实现 porcelain 只报 "?? newdir/"。
  fs.mkdirSync(path.join(dir, 'newdir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'newdir', 'inner.txt'), 'fresh\n');
  const md =
    fm('g3', 'L', 'a.txt, staged.txt, untracked.txt, newdir/inner.txt') +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    '| 1 | a.txt | 1 | base | 1 | base |\n\n## 验证\nnode --test && timeout 60000\n';
  const { result, json } = runLint(dir, md);
  assert.ok(json, '应输出 JSON，stderr=' + result.stderr);
  assert.strictEqual(
    result.status,
    0,
    '未跟踪目录应展开为成员文件，不得出现目录条目假阳性，violations=' + JSON.stringify(json.violations)
  );
  const det = json.violations.filter((v) => v.rule === 'fileset').map((v) => v.detail).join(' ');
  assert.ok(!/newdir\/?$/.test(det), '不得出现 "newdir/" 目录条目违规');
});

// ===== v1.10.2（审查修复轮1）：覆盖写 + 规则分域（P1-2 / P1-3） =====

test('v1.10.2 覆盖写入：旧聚合结构脏报告被整体替换（reports/summary 消失，violations 只含本次）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  const outRel = 'docs/specs/o20.lint-report.json';
  // 预置旧聚合结构脏报告（历史 3 条 violation 累计）
  wj(ctx.proj, outRel, JSON.stringify({
    reports: [{ violations: [{ rule: 'verify', detail: 'old1' }, { rule: 'verify', detail: 'old2' }] }, { violations: [{ rule: 'verify', detail: 'old3' }] }],
    summary: { violations: 3 },
  }));
  ctx.md = fm('o20', 'S', 'a.txt') + CLEAN_BODY;
  const { result } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', outRel]);
  assert.strictEqual(result.status, 0, 'stderr=' + result.stderr);
  const out = JSON.parse(fs.readFileSync(path.join(ctx.proj, outRel), 'utf-8'));
  assert.strictEqual(out.reports, undefined, '旧聚合 reports 不得保留');
  assert.strictEqual(out.summary, undefined, '旧聚合 summary 不得保留');
  assert.strictEqual(out.slug, 'o20');
  assert.strictEqual(out.violations.length, 0, '旧 3 条 violation 不得残留：' + JSON.stringify(out.violations));
  assert.ok(typeof out.generatedAt === 'string');
});

test('v1.10.2 分域 spec：只有 code-files 的 spec 无"## 验证"节 → 不产生 verify/fileset 违规', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 200, minus: 200 }); // 若误跑 linecap/fileset 必报
  fs.writeFileSync(path.join(ctx.proj, 'spec.md'), '---\nslug: sp1\nstatus: approved\ncode-files: src/sp1.js\n---\n# sp1\n\n## 2. 机制\n\nno verify section here\n', 'utf-8');
  const proc = spawnSync('node', [SCRIPT, 'spec.md', '--diff-cmd', cmd, '--out', 'docs/specs/sp1.lint-report.json'], { cwd: ctx.proj, encoding: 'utf-8' });
  const json = JSON.parse(proc.stdout);
  assert.strictEqual(proc.status, 0, JSON.stringify(json.violations) + ' stderr=' + proc.stderr);
  assert.deepStrictEqual(json.violations, []);
  assert.strictEqual(json.domain, 'spec');
  assert.strictEqual(json.warnings.filter((w) => w.rule === 'verify-timeout').length, 0, 'spec 不检查 verify-timeout');
  const out = JSON.parse(fs.readFileSync(path.join(ctx.proj, 'docs', 'specs', 'sp1.lint-report.json'), 'utf-8'));
  assert.strictEqual(out.violations.length, 0);
});

test('v1.10.2 分域 变更单：有 changed-files 仍校验 verify（缺 "## 验证" → violation）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  ctx.md = fm('ch1', 'S', 'a.txt') + '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | a.txt | 1 | x | 1 | y |\n';
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 1);
  assert.strictEqual(json.domain, 'change');
  assert.ok(json.violations.some((v) => v.rule === 'verify' && /## 验证/.test(v.detail)), JSON.stringify(json.violations));
});

test('v1.10.2 分域 spec：test-cmd-empty 类项目违规对 spec 仍可拦截（消除 L 级自锁但不放过真违规）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: [], plus: 0, minus: 0 });
  wj(ctx.proj, 'docs/changes/sp2.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: '  ', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 0 } }));
  wj(ctx.proj, 'docs/specs/sp2.test-report.json',
    JSON.stringify({ records: [{ item: 'a', command: '  ', durationMs: 1, result: 'pass' }], summary: { passed: 1, failed: 0 } }));
  fs.writeFileSync(path.join(ctx.proj, 'spec.md'), '---\nslug: sp2\nstatus: approved\ncode-files: src/sp2.js\n---\n# sp2\n', 'utf-8');
  const proc = spawnSync('node', [SCRIPT, 'spec.md', '--diff-cmd', cmd], { cwd: ctx.proj, encoding: 'utf-8' });
  const json = JSON.parse(proc.stdout);
  assert.strictEqual(proc.status, 1, 'spec 输入仍须被 test-cmd-empty 拦截');
  const hits = json.violations.filter((v) => v.rule === 'test-cmd-empty');
  assert.strictEqual(hits.length, 1, JSON.stringify(json.violations)); // 同名按文件名去重：specs 先命中
  assert.match(hits[0].detail, /specs\/sp2\.test-report\.json/);
});

test('v1.10.2 分域正确性：同一项目下 spec 目标 0 违规、变更单目标仍有 verify/linecap（互不影响）', () => {
  const ctx = project();
  // 40 行 churn：变更单 M 上限 120 内不报；S 级必报 linecap
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 20, minus: 20 });
  fs.writeFileSync(path.join(ctx.proj, 'spec.md'), '---\nslug: sp3\ncode-files: src/sp3.js\n---\n# sp3\n', 'utf-8');
  const specProc = spawnSync('node', [SCRIPT, 'spec.md', '--diff-cmd', cmd], { cwd: ctx.proj, encoding: 'utf-8' });
  const specJson = JSON.parse(specProc.stdout);
  assert.strictEqual(specProc.status, 0, JSON.stringify(specJson.violations));
  ctx.md = fm('ch3', 'S', 'a.txt') + '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout 60000\n';
  const ch = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(ch.result.status, 1);
  assert.ok(ch.json.violations.some((v) => v.rule === 'linecap'), JSON.stringify(ch.json.violations));
});

test('v1.10.2 扫描异常降级：projectRules 抛错 → warnings 含 scan-degraded（不升级为 violation、exit 0）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  // 把 docs/specs 建成**文件**（非目录）：规则层 readdir/scanDocEntries 各自内部吞错，正常路径不产生
  // scan-degraded；此处验证该异常形态下 lint 不崩溃、不误升级为 violation。
  fs.writeFileSync(path.join(ctx.proj, 'docs'), 'not a dir\n', 'utf-8');
  ctx.md = fm('d1', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.ok(json, 'stderr=' + result.stderr);
  assert.strictEqual(result.status, 0, '扫描异常不得升级为 violation：' + JSON.stringify(json.violations));
  assert.strictEqual(json.violations.length, 0);
  assert.ok(Array.isArray(json.warnings));
});

test('v1.10.3 scan-degraded 降级路径：docs/specs 不存在 → warning 提示核对 cwd/--repo（不再静默 fail-open）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/changes/y.md', '---\nslug: y\ntier: S\nchanged-files: a.txt\n---\n# y\n');
  ctx.md = fm('d2', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  // docs/specs 缺失属真实降级：warning 明示（不升级为 violation，exit 仍由 violations 决定）
  assert.strictEqual(result.status, 0, JSON.stringify(json.violations));
  const degraded = json.warnings.filter((w) => w.rule === 'scan-degraded');
  assert.strictEqual(degraded.length, 1, 'docs/specs 缺失应恰好一条 scan-degraded（lint-stale 连带扫描去重）：' + JSON.stringify(json.warnings));
  assert.match(degraded[0].detail, /docs\/specs/);
  assert.match(degraded[0].detail, /--repo/);
});

test('v1.10.3 scan-degraded 无误报：docs/specs 与 docs/changes 均存在 → 0 条 scan-degraded', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/s.md', specFm('s', 'code-files: none'));
  wj(ctx.proj, 'docs/changes/y.md', '---\nslug: y\ntier: S\nchanged-files: a.txt\n---\n# y\n');
  ctx.md = fm('d3', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json.violations));
  assert.strictEqual(json.warnings.filter((w) => w.rule === 'scan-degraded').length, 0, '正常扫描不应产生 scan-degraded');
});

// ===== v1.10.3（修复轮2）：lint-stale 以 generatedAt 为准 / producedBy 来源戳 =====

test('v1.10.3 lint-stale 用报告内 generatedAt：报告 mtime 很新但 generatedAt 早于代码 → 报 lint-stale warning（不阻断）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  // 变更单自身（目标 slug = self1）声明 code-files（spec 目录条目）：目标自身参与 lint-stale 判定
  wj(ctx.proj, 'docs/specs/self1.md', '---\nslug: self1\ntier: S\nchanged-files: a.txt\ncode-files: src/self1.js\n---\n# self1\n');
  wj(ctx.proj, 'docs/tasks/self1-exec.md', '# exec\n'); // 执行证据，避免 exec-missing 干扰
  const impl = wj(ctx.proj, 'src/self1.js', 'x\n');
  fs.utimesSync(impl, new Date(), new Date());
  // 报告刚写（mtime=now），但声称生成于 1 分钟前 → 早于代码 mtime，判 stale
  wj(
    ctx.proj,
    'docs/specs/self1.lint-report.json',
    JSON.stringify({ producedBy: 'review-lint', target: 'docs/specs/self1.md', slug: 'self1', generatedAt: new Date(Date.now() - 60000).toISOString(), violations: [], warnings: [] })
  );
  ctx.md = fm('self1', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  // v1.10.3 决策：lint-stale 判在 writeReport 之前，若升格 violation 则重跑自身必然 exit 1（自参照）；
  // 故降级为 warning，一次重跑即清零（新报告 generatedAt 晚于旧代码）。
  assert.strictEqual(result.status, 0, 'lint-stale 不得阻断：' + JSON.stringify(json.violations));
  const stale = json.warnings.filter((w) => w.rule === 'lint-stale');
  assert.strictEqual(stale.length, 1, '目标自身应提示一次 lint-stale 过期：' + JSON.stringify(json.warnings));
  assert.match(stale[0].detail, /过期/);
  assert.strictEqual(json.violations.filter((v) => v.rule === 'lint-stale').length, 0);
});

test('v1.10.3 lint-stale 目标自身参与判定：目标 slug 的盘上旧报告早于其声明文件 → 仍提示', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/self1.md', '---\nslug: self1\ntier: S\nchanged-files: a.txt\ncode-files: src/self1.js\n---\n# self1\n');
  wj(ctx.proj, 'docs/tasks/self1-exec.md', '# exec\n'); // 执行证据，避免 exec-missing 干扰
  const impl = wj(ctx.proj, 'src/self1.js', 'x\n');
  fs.utimesSync(impl, new Date(), new Date());
  wj(
    ctx.proj,
    'docs/specs/self1.lint-report.json',
    JSON.stringify({ producedBy: 'review-lint', generatedAt: new Date(Date.now() - 60000).toISOString(), violations: [], warnings: [] })
  );
  ctx.md = fm('self1', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json.violations));
  assert.strictEqual(json.warnings.filter((w) => w.rule === 'lint-stale').length, 1, JSON.stringify(json.warnings));
});

test('v1.10.3 lint-stale 一次重跑即清零：报告 mtime 很旧但 generatedAt 晚于代码 → 不报', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  wj(ctx.proj, 'docs/specs/g2c.lint-report.json', JSON.stringify({ producedBy: 'review-lint', generatedAt: new Date().toISOString(), violations: [], warnings: [] }));
  wj(ctx.proj, 'docs/specs/g2.md', specFm('g2', 'code-files: src/g2.js'));
  const impl = wj(ctx.proj, 'src/g2.js', 'x\n');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(impl, old, old);
  const report = wj(
    ctx.proj,
    'docs/specs/g2.lint-report.json',
    JSON.stringify({ producedBy: 'review-lint', target: 'docs/specs/g2.md', slug: 'g2', generatedAt: new Date(Date.now() - 60000).toISOString(), violations: [], warnings: [] })
  );
  fs.utimesSync(report, old, old); // 文件 mtime 早于代码（旧实现会误报 stale）
  ctx.md = fm('g2c', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, JSON.stringify(json.violations));
  assert.strictEqual(json.violations.filter((v) => v.rule === 'lint-stale').length, 0, 'generatedAt 晚于代码时不得报 stale');
  assert.strictEqual(json.warnings.filter((w) => w.rule === 'lint-stale').length, 0, '不得出现 lint-stale warning');
});

test('v1.10.3 lint-stale 回退：目标报告无 generatedAt → 按文件 mtime 判定（报 warning 不阻断）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  // 目标自身声明了代码文件（spec 目录条目），其报告缺 generatedAt 且 mtime 早于代码 → 回退 mtime 判 stale
  wj(ctx.proj, 'docs/specs/g3c.md', '---\nslug: g3c\ntier: S\nchanged-files: a.txt\ncode-files: src/g3c.js\n---\n# g3c\n');
  wj(ctx.proj, 'docs/tasks/g3c-exec.md', '# exec\n');
  const implTc = wj(ctx.proj, 'src/g3c.js', 'x\n');
  fs.utimesSync(implTc, new Date(), new Date());
  const reportTc = wj(ctx.proj, 'docs/specs/g3c.lint-report.json', JSON.stringify({ violations: [], warnings: [] }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(reportTc, old, old);
  ctx.md = fm('g3c', 'S', 'a.txt') + CLEAN_BODY;
  const { result, json } = runLintOut(ctx, 'change.md', ['--diff-cmd', cmd]);
  assert.strictEqual(result.status, 0, 'lint-stale 为 warning，不阻断：' + JSON.stringify(json.violations));
  const stale = json.warnings.filter((w) => w.rule === 'lint-stale');
  assert.strictEqual(stale.length, 1, '无 generatedAt 时应回退文件 mtime 并判出过期：' + JSON.stringify(json.warnings));
  assert.match(stale[0].detail, /过期/);
});

test('v1.10.3 --out 报告写入来源戳 producedBy:"review-lint"（含 --project-scan 形态）', () => {
  const ctx = project();
  const cmd = setup(ctx.dir, { names: ['a.txt'], plus: 1, minus: 0 });
  ctx.md = fm('p1', 'S', 'a.txt') + CLEAN_BODY;
  runLintOut(ctx, 'change.md', ['--diff-cmd', cmd, '--out', 'docs/specs/p1.lint-report.json']);
  const out = JSON.parse(fs.readFileSync(path.join(ctx.proj, 'docs', 'specs', 'p1.lint-report.json'), 'utf-8'));
  assert.strictEqual(out.producedBy, 'review-lint');
  // --project-scan 形态同样带来源戳
  const ps = spawnSync('node', [SCRIPT, '--project-scan', '--out', 'docs/specs/_project-scan.lint-report.json'], { cwd: ctx.proj, encoding: 'utf-8' });
  assert.ok(ps.status === 0 || ps.status === 1, 'stderr=' + ps.stderr);
  const scan = JSON.parse(fs.readFileSync(path.join(ctx.proj, 'docs', 'specs', '_project-scan.lint-report.json'), 'utf-8'));
  assert.strictEqual(scan.producedBy, 'review-lint');
  assert.strictEqual(scan.scope, 'project-scan');
});
