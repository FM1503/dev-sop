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
