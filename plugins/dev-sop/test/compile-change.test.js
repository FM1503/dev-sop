'use strict';
// compile-change.test.js — dev-sop v1.8.0 变更单编译器单测（规格 2.A / 验收 checklist 第 1 项）
// 通过 CLI + python 子进程黑盒验证：单行/跨行替换、新文件全文、CRLF 字节保真 roundtrip、
// 锚点不匹配失败含 ±3 行上下文、旧行数越界失败、回滚还原、expect_after 失败、多文件混合、
// 中文内容、<NL> 多行转义、frontmatter 解析（rollback 文件按 slug 命名）、无表报错。
// 注：脚本为 ESM(.mjs)，测试为 CJS(.js)，故一律 spawn `node <script>` / `python -` 调用。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'compile-change.mjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
}
function seed(dir, map) {
  for (const rel of Object.keys(map)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, map[rel]);
  }
}
function writeChange(dir, md) {
  fs.writeFileSync(path.join(dir, 'change.md'), md);
}
function compile(dir, args) {
  return spawnSync('node', [SCRIPT, 'change.md'].concat(args || []), {
    cwd: dir,
    encoding: 'utf-8',
  });
}
function apply(dir, py) {
  return spawnSync('python', ['-'], { cwd: dir, encoding: 'utf-8', input: py });
}
// 一步：编译并执行正向补丁
function compileAndApply(dir) {
  const c = compile(dir);
  assert.strictEqual(c.status, 0, '编译失败: ' + c.stderr);
  return { compile: c, apply: apply(dir, c.stdout) };
}
function readBuf(dir, rel) {
  return fs.readFileSync(path.join(dir, rel));
}
function fm(slug, tier, changedFiles) {
  return [
    '---',
    'slug: ' + slug,
    'tier: ' + tier,
    'changed-files: ' + changedFiles,
    '---',
    '',
  ].join('\n');
}

test('单行替换 + 验证字段透传 + 编译产物为 python', () => {
  const dir = tmp();
  seed(dir, { 'hello.txt': 'a\nbb\nc\n' });
  writeChange(
    dir,
    fm('t1', 'S', 'hello.txt') +
      '\n## 变更表\n\n' +
      '| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | hello.txt | 2 | bb | 1 | xx |\n\n' +
      '## 验证\nnode --test t1 && echo ok （timeout 60000）\n'
  );
  const r = compileAndApply(dir);
  assert.match(r.compile.stdout, /^import /, 'stdout 应为 python 脚本');
  assert.match(r.compile.stderr, /node --test t1/, '验证字段应透传到 stderr 执行提示');
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'hello.txt').toString('utf-8'), 'a\nxx\nc\n');
});

test('跨行替换（旧行数 2）', () => {
  const dir = tmp();
  seed(dir, { 'x.txt': 'l1\nl2\nl3\nl4\n' });
  writeChange(
    dir,
    fm('t2', 'S', 'x.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | x.txt | 2 | l2 | 2 | NEW |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'x.txt').toString('utf-8'), 'l1\nNEW\nl4\n');
});

test('新文件全文写 + 目录自动创建（<NEWFILE> 前缀）', () => {
  const dir = tmp();
  writeChange(
    dir,
    fm('t3', 'S', 'sub/dir/new.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | sub/dir/new.txt | - | - | - | <NEWFILE>line1<NL>line2<NL>line3 |\n\n' +
      '## 验证\ngrep -q line2 sub/dir/new.txt && echo assert （timeout 30000）\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'dir', 'new.txt')), '目录应自动创建');
  assert.strictEqual(readBuf(dir, 'sub/dir/new.txt').toString('utf-8'), 'line1\nline2\nline3');
});

test('CRLF 字节保真 roundtrip（编辑后仍 CRLF，回滚逐字节还原）', () => {
  const dir = tmp();
  const orig = Buffer.from('x\r\nyy\r\nz\r\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'crlf.txt'), orig);
  writeChange(
    dir,
    fm('t4', 'S', 'crlf.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | crlf.txt | 2 | yy | 1 | ZZ |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.ok(readBuf(dir, 'crlf.txt').equals(Buffer.from('x\r\nZZ\r\nz\r\n', 'utf-8')), '应保持 CRLF');
  // 回滚
  const rb = compile(dir, ['--rollback']);
  assert.strictEqual(rb.status, 0, rb.stderr);
  const rr = apply(dir, rb.stdout);
  assert.strictEqual(rr.status, 0, rr.stderr);
  assert.ok(readBuf(dir, 'crlf.txt').equals(orig), '回滚应逐字节还原原始 CRLF');
});

test('锚点不匹配失败（exit 1 + ±3 行上下文）', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'l1\nl2\nl3\nl4\nl5\n' });
  writeChange(
    dir,
    fm('t5', 'S', 'a.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | a.txt | 3 | WRONG | 1 | zzz |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.notStrictEqual(r.apply.status, 0, '锚点不匹配应非零退出');
  assert.match(r.apply.stderr, /锚点/, '应报告锚点不匹配');
  // ±3 行上下文：打印含邻近行号 l1..l5
  assert.match(r.apply.stderr, /\s3 l3/, '应打印出错行上下文');
});

test('旧行数越界失败（exit 1）', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'l1\nl2\nl3\n' });
  writeChange(
    dir,
    fm('t6', 'S', 'a.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | a.txt | 2 | l2 | 50 | zzz |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.notStrictEqual(r.apply.status, 0, '旧行数越界应非零退出');
  assert.match(r.apply.stderr, /旧行数越界/);
});

test('回滚还原（编辑文件 + 删除新建文件）', () => {
  const dir = tmp();
  seed(dir, { 'e.txt': 'one\ntwo\n' });
  writeChange(
    dir,
    fm('t7', 'S', 'e.txt, created.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | e.txt | 1 | one | 1 | EIN |\n' +
      '| 2 | created.txt | - | - | - | <NEWFILE>brand new |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'created.txt')));
  const rb = compile(dir, ['--rollback']);
  const rr = apply(dir, rb.stdout);
  assert.strictEqual(rr.status, 0, rr.stderr);
  assert.strictEqual(readBuf(dir, 'e.txt').toString('utf-8'), 'one\ntwo\n', '编辑文件应还原');
  assert.ok(!fs.existsSync(path.join(dir, 'created.txt')), '新建文件应被删除');
});

test('expect_after 后置断言失败', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'l1\nl2\n' });
  writeChange(
    dir,
    fm('t8', 'S', 'a.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | a.txt | 1 | l1 | 1 | zzz |\n\n' +
      '## expect_after\n\n| 文件 | 包含子串 |\n| --- | --- |\n| a.txt | NOT_PRESENT |\n\n' +
      '## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.notStrictEqual(r.apply.status, 0, 'expect_after 缺失应失败');
  assert.match(r.apply.stderr, /expect_after/);
});

test('多文件混合（两编辑 + 一新文件）', () => {
  const dir = tmp();
  seed(dir, { 'f1.txt': 'a\nb\n', 'f2.txt': 'c\nd\n' });
  writeChange(
    dir,
    fm('t9', 'S', 'f1.txt, f2.txt, f3.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | f1.txt | 1 | a | 1 | A1 |\n' +
      '| 2 | f2.txt | 2 | d | 1 | D2 |\n' +
      '| 3 | f3.txt | - | - | - | <NEWFILE>fresh |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'f1.txt').toString('utf-8'), 'A1\nb\n');
  assert.strictEqual(readBuf(dir, 'f2.txt').toString('utf-8'), 'c\nD2\n');
  assert.strictEqual(readBuf(dir, 'f3.txt').toString('utf-8'), 'fresh');
});

test('中文内容替换（utf-8 字节保真）', () => {
  const dir = tmp();
  seed(dir, { 'zh.txt': '第一行\n第二行\n' });
  writeChange(
    dir,
    fm('t10', 'S', 'zh.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | zh.txt | 2 | 第二行 | 1 | 替换为中文内容 |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'zh.txt').toString('utf-8'), '第一行\n替换为中文内容\n');
});

test('<NL> 多行新内容（编辑行展开为多行）', () => {
  const dir = tmp();
  seed(dir, { 'm.txt': 'l1\nX\nl3\n' });
  writeChange(
    dir,
    fm('t11', 'S', 'm.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | m.txt | 2 | X | 1 | p<NL>q<NL>r |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'm.txt').toString('utf-8'), 'l1\np\nq\nr\nl3\n');
});

test('frontmatter 解析：rollback 文件按 slug 命名（相对 cwd）', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'x\ny\n' });
  writeChange(
    dir,
    fm('myslug', 'M', 'a.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | a.txt | 1 | x | 1 | z |\n\n## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  const rbPath = path.join(dir, 'docs', 'changes', 'myslug.rollback.json');
  assert.ok(fs.existsSync(rbPath), 'rollback 文件应使用 slug 命名: ' + rbPath);
  const data = JSON.parse(fs.readFileSync(rbPath, 'utf-8'));
  assert.ok('snapshot' in data && 'created' in data, 'rollback 结构含 snapshot/created');
});

test('无变更表 → 编译报错（非零退出）', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'x\n' });
  writeChange(dir, fm('t13', 'S', 'a.txt') + '\n# 标题\n没有表格\n\n## 验证\nnode --test\n');
  const c = compile(dir);
  assert.notStrictEqual(c.status, 0, '缺变更表应非零退出');
  assert.match(c.stderr, /变更表|解析失败/);
});

test('--rollback 缺 rollback.json → 失败非零', () => {
  const dir = tmp();
  writeChange(
    dir,
    fm('t14', 'S', 'a.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout\n'
  );
  const rb = compile(dir, ['--rollback']);
  assert.strictEqual(rb.status, 0, '编译回滚脚本本身应成功');
  const rr = apply(dir, rb.stdout); // 未先 apply，无 rollback.json
  assert.notStrictEqual(rr.status, 0, '缺 rollback.json 应非零');
  assert.match(rr.stderr, /回滚失败/);
});

// ===== 修复轮1：P1-1 表格 \| 转义 =====
function tableWith(rowsMd, slug, tier, changed) {
  return (
    fm(slug, tier, changed) +
    '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
    rowsMd +
    '\n\n## 验证\nnode --test && timeout\n'
  );
}

test('P1-1 单元格含 a\\|b：字面竖线还原写入（不再截断）', () => {
  const dir = tmp();
  seed(dir, { 'p.txt': 'x\ny\n' });
  writeChange(dir, tableWith('| 1 | p.txt | 1 | x | 1 | a\\|b |\n', 'e1', 'S', 'p.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.compile.status, 0, r.compile.stderr);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'p.txt').toString('utf-8'), 'a|b\ny\n');
});

test('P1-1 单元格含代码 if (a \\| b)：转义竖线还原为逻辑或竖线', () => {
  const dir = tmp();
  seed(dir, { 'c.txt': 'old\nnext\n' });
  writeChange(dir, tableWith('| 1 | c.txt | 1 | old | 1 | if (a \\| b) return; |\n', 'e2', 'S', 'c.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'c.txt').toString('utf-8'), 'if (a | b) return;\nnext\n');
});

test('P1-1 转义竖线在首尾：\\|x\\| → |x|', () => {
  const dir = tmp();
  seed(dir, { 'f.txt': 'old\n' });
  writeChange(dir, tableWith('| 1 | f.txt | 1 | old | 1 | \\|x\\| |\n', 'e3', 'S', 'f.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'f.txt').toString('utf-8'), '|x|\n');
});

test('P1-1 无转义回归：普通单元格列数正确（多列不被破坏）', () => {
  const dir = tmp();
  seed(dir, { 'g.txt': 'l1\nl2\n' });
  writeChange(dir, tableWith('| 1 | g.txt | 1 | l1 | 1 | A1 |\n| 2 | g.txt | 2 | l2 | 1 | A2 |\n', 'e4', 'S', 'g.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'g.txt').toString('utf-8'), 'A1\nA2\n');
});

// ===== 修复轮1：P1-2 删除语义（空新内容=删除旧行数行）=====
test('P1-2 删除单行（旧行数 1、新内容空）', () => {
  const dir = tmp();
  seed(dir, { 'd1.txt': 'a\nb\nc\n' });
  writeChange(dir, tableWith('| 1 | d1.txt | 2 | b | 1 |  |\n', 'del1', 'M', 'd1.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.compile.status, 0, r.compile.stderr);
  assert.match(r.compile.stdout, /== ""/);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'd1.txt').toString('utf-8'), 'a\nc\n');
});

test('P1-2 删除多行（旧行数 2、新内容空）', () => {
  const dir = tmp();
  seed(dir, { 'd2.txt': 'l1\nl2\nl3\nl4\n' });
  writeChange(dir, tableWith('| 1 | d2.txt | 2 | l2 | 2 |  |\n', 'del2', 'M', 'd2.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'd2.txt').toString('utf-8'), 'l1\nl4\n');
});

test('P1-2 删除后行数校验 + expect_after 仍适用', () => {
  const dir = tmp();
  seed(dir, { 'd3.txt': 'l1\nl2\nl3\nl4\nl5\n' });
  writeChange(
    dir,
    fm('del3', 'M', 'd3.txt') +
      '\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 1 | d3.txt | 2 | l2 | 3 |  |\n\n' +
      '## expect_after\n\n| 文件 | 包含子串 |\n| --- | --- |\n| d3.txt | l5 |\n\n' +
      '## 验证\nnode --test && timeout\n'
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'd3.txt').toString('utf-8'), 'l1\nl5\n', '应删除 3 行，余 2 行');
});

// ===== 修复轮1：P1-5 --emit-exec 执行书产物 =====
test('P1-5 编译成功默认产出 docs/tasks/<slug>-exec.md（含脚本/命令/回滚）', () => {
  const dir = tmp();
  seed(dir, { 'x.txt': 'a\n' });
  writeChange(dir, tableWith('| 1 | x.txt | 1 | a | 1 | b |\n', 'ex1', 'S', 'x.txt'));
  const c = compile(dir);
  assert.strictEqual(c.status, 0, c.stderr);
  const execPath = path.join(dir, 'docs', 'tasks', 'ex1-exec.md');
  assert.ok(fs.existsSync(execPath), '应写出执行书产物');
  const doc = fs.readFileSync(execPath, 'utf-8');
  assert.match(doc, /```python/, '执行书应含 Python 代码块');
  assert.match(doc, /import sys, os, json, base64/, 'Python 代码块应为生成的补丁脚本');
  assert.match(doc, /compile-change\.mjs ex1|compile-change\.mjs change\.md/, '执行书应含执行命令');
  assert.match(doc, /回滚/, '执行书应含回滚说明');
  assert.match(doc, /变更表/, '执行书应含变更表');
});

test('P1-5 编译失败（无变更表）→ 不写执行书产物', () => {
  const dir = tmp();
  seed(dir, { 'x.txt': 'a\n' });
  writeChange(dir, fm('ex2', 'S', 'x.txt') + '\n# 标题\n没有表格\n\n## 验证\nnode --test\n');
  const c = compile(dir);
  assert.notStrictEqual(c.status, 0, '缺变更表应非零退出');
  assert.ok(!fs.existsSync(path.join(dir, 'docs', 'tasks', 'ex2-exec.md')), '编译失败不得写出执行书');
});

// ===== 修复轮1：P2-5 混合行尾保真 =====
test('P2-5 混合行尾文件改 1 行 → 其余行字节级 EOL 不变', () => {
  const dir = tmp();
  const orig = Buffer.from('l1\r\nl2\nl3\r\nl4\n', 'utf-8'); // l1 CRLF/l2 LF/l3 CRLF/l4 LF
  fs.writeFileSync(path.join(dir, 'mx.txt'), orig);
  writeChange(dir, tableWith('| 1 | mx.txt | 1 | l1 | 1 | L1X |\n', 'mx1', 'M', 'mx.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  const out = readBuf(dir, 'mx.txt');
  // 仅 l1 改 L1X 且沿用其原 CRLF；l2 LF、l3 CRLF、l4 LF 行尾完全不变
  assert.ok(out.equals(Buffer.from('L1X\r\nl2\nl3\r\nl4\n', 'utf-8')), '未触碰行行尾应原样保留，实得=' + JSON.stringify(out.toString('utf-8')));
});

test('P2-5 混合行尾：替换 LF 行产出 LF，不污染相邻 CRLF', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'my.txt'), Buffer.from('l1\r\nl2\nl3\r\n', 'utf-8'));
  writeChange(dir, tableWith('| 1 | my.txt | 2 | l2 | 1 | NEW |\n', 'my1', 'M', 'my.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  // l2 原为 LF → NEW 用 LF；l1 CRLF/l3 CRLF 不变
  assert.ok(
    readBuf(dir, 'my.txt').equals(Buffer.from('l1\r\nNEW\nl3\r\n', 'utf-8')),
    '被替换行按自身行尾归一，实得=' + JSON.stringify(readBuf(dir, 'my.txt').toString('utf-8'))
  );
});

// ===== 修复轮1：P2-8 行号/slug 非法清晰报错 exit 2 =====
test('P2-8 编辑行行号非正整数（-）→ 清晰报错 exit 2', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'x\ny\n' });
  writeChange(dir, tableWith('| 1 | a.txt | - | x | 1 | z |\n', 'badlineno', 'M', 'a.txt'));
  const c = compile(dir);
  assert.strictEqual(c.status, 2, '行号非法应 exit 2，实得=' + c.status);
  assert.match(c.stderr, /行号/);
});

test('P2-8 frontmatter 缺 slug → 清晰报错 exit 2', () => {
  const dir = tmp();
  seed(dir, { 'a.txt': 'x\n' });
  writeChange(
    dir,
    '---\ntier: M\nchanged-files: a.txt\n---\n\n## 变更表\n\n| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | a.txt | 1 | x | 1 | y |\n\n## 验证\nnode --test && timeout\n'
  );
  const c = compile(dir);
  assert.strictEqual(c.status, 2, '缺 slug 应 exit 2，实得=' + c.status);
  assert.match(c.stderr, /slug/);
});

// ===== 终修轮（P2×8）=====
// P2-1 \\| 双转义：连续反斜杠段紧跟 | 时整段视为转义竖线（与 \| 同效），输出字面 |
test('终修P2-1 双转义 \\\\| 与四反斜杠+竖线：均解析为字面竖线', () => {
  const dir = tmp();
  seed(dir, { 'p2.txt': 'x\ny\n' });
  // 变更单实际内容：第 1 行新内容 a\\|b（两反斜杠+竖线）；第 2 行 c\\\\|d（四反斜杠+竖线）
  writeChange(
    dir,
    tableWith(
      '| 1 | p2.txt | 1 | x | 1 | a\\\\|b |\n' +
        '| 2 | p2.txt | 2 | y | 1 | c\\\\\\\\|d |\n',
      'esc2',
      'S',
      'p2.txt'
    )
  );
  const r = compileAndApply(dir);
  assert.strictEqual(r.compile.status, 0, r.compile.stderr);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'p2.txt').toString('utf-8'), 'a|b\nc|d\n');
});

// P2-1：反斜杠段后无 | 时整段坍缩为单个字面反斜杠（连续 \\\\ → \）
test('终修P2-1 连续四反斜杠（后无竖线）输出字面反斜杠', () => {
  const dir = tmp();
  seed(dir, { 'bs.txt': 'x\ny\n' });
  // 变更单实际内容：a\\\\b（四反斜杠） → 解析为 a\b（单字面反斜杠）
  writeChange(dir, tableWith('| 1 | bs.txt | 1 | x | 1 | a\\\\\\\\b |\n', 'esc4', 'S', 'bs.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.compile.status, 0, r.compile.stderr);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'bs.txt').toString('utf-8'), 'a\\b\ny\n');
});

// P2-2 Unicode 行界：\f 不得再被当作换行（弃用 splitlines(True)），行号不漂移
test('终修P2-2 含 \\f 的文件行号不漂移（仅 \\r\\n/\\r/\\n 分行）', () => {
  const dir = tmp();
  // 实际字节：'l1<FF>l2\nl3\n' —— splitlines(True) 会把 <FF> 当行界致第 2 行错位
  seed(dir, { 'ff.txt': 'l1\nl3\n' });
  fs.writeFileSync(path.join(dir, 'ff.txt'), Buffer.from('l1\x0cl2\nl3\n', 'utf-8'));
  writeChange(dir, tableWith('| 1 | ff.txt | 2 | l3 | 1 | NEW |\n', 'uni1', 'S', 'ff.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, '按物理行界 l3 应在第 2 行命中，apply 失败: ' + r.apply.stderr);
  assert.strictEqual(readBuf(dir, 'ff.txt').toString('utf-8'), 'l1\x0cl2\nNEW\n');
});

// P2-3 文件末行无换行：替换区间含无 EOL 末行 → 新内容同样不补尾 EOL
test('终修P2-3 替换无尾换行文件的末行 → 结果仍无尾换行', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'nl.txt'), Buffer.from('a\nb\nc', 'utf-8')); // 末行 c 无 EOL
  writeChange(dir, tableWith('| 1 | nl.txt | 3 | c | 1 | C1 |\n', 'nl1', 'S', 'nl.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.ok(
    readBuf(dir, 'nl.txt').equals(Buffer.from('a\nb\nC1', 'utf-8')),
    '应保持无尾换行，实得=' + JSON.stringify(readBuf(dir, 'nl.txt').toString('utf-8'))
  );
});

// P2-3：删除末行区间（区间含无 EOL 末行）→ 其余行原样、区间消失
test('终修P2-3 删除含末行的区间 → 余行字节不变', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'nd.txt'), Buffer.from('p\nq\nr', 'utf-8')); // 末行 r 无 EOL
  writeChange(dir, tableWith('| 1 | nd.txt | 2 | q | 2 |  |\n', 'nl2', 'S', 'nd.txt'));
  const r = compileAndApply(dir);
  assert.strictEqual(r.apply.status, 0, r.apply.stderr);
  assert.ok(
    readBuf(dir, 'nd.txt').equals(Buffer.from('p\n', 'utf-8')),
    '删除 p 之后的 2 行，实得=' + JSON.stringify(readBuf(dir, 'nd.txt').toString('utf-8'))
  );
});
