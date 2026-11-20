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

// ===== 终修轮：P2-4 未跟踪目录展开为成员文件（-uall），目录条目不再造成 fileset 假阳性 =====
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
