'use strict';
// patch-direct.test.js — v1.7.0 补丁直改配套测试（TDD：先于验收编写）
// 规则来源：docs/specs/patch-direct.md 2.B（gate.js Bash 写模式检测）
//   parseBashWriteTargets 纯函数：显式写入模式识别——重定向 > / >>（2> 忽略、
//   /dev/null 归一保留）、tee（含 -a）、sed -i、patch <f / git apply f；引号路径
//   兼容；多命令（&&、;、| 分隔）逐一解析；反斜杠按字面字符（Windows 兼容）；
//   无法确定目标（$(...) 替换、heredoc、patch 读 stdin 等）→ 'opaque' 标记项。
//   main() Bash 分支 e2e（spawn 真实 gate.js）：无 spec 写代码文件 → deny（文案同
//   Write/Edit）；写 .md → 放行；有 approved spec → 放行；heredoc → 放行且日志记
//   bash-write-opaque。另含 hooks.json Bash 组双 hook 结构断言（与 test-guard 并存
//   不互扰）与 test-guard 后台测试回归。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseBashWriteTargets, BASH_WRITE_OPAQUE } = require('../hooks/gate.js');

// ---- parseBashWriteTargets：显式写入模式识别（纯函数 ≥12 用例）----

test('parse：单重定向（空格/紧贴两种形态）→ 提取目标', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo hi > src/a.py'), ['src/a.py']);
  assert.deepStrictEqual(parseBashWriteTargets('echo hi>src/a.py'), ['src/a.py']);
});

test('parse：引号包裹路径（单引号/双引号，含空格路径）→ 提取引号内内容', () => {
  assert.deepStrictEqual(parseBashWriteTargets("echo hi > 'my file.py'"), ['my file.py']);
  assert.deepStrictEqual(parseBashWriteTargets('echo hi > "x.py"'), ['x.py']);
});

test('parse：追加 >> 与混合 2>（stderr 忽略）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo hi >> logs/x.py'), ['logs/x.py']);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js 2> err.txt'), []);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > out.py 2> err.txt'), ['out.py']);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > out.py 2>&1'), ['out.py']);
});

test('parse：>/dev/null 归一保留（豁免在 gate 层判定）；反斜杠 /dev/null 同样归一', () => {
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > /dev/null'), ['/dev/null']);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >/dev/null 2>&1'), ['/dev/null']);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > NUL'), ['NUL']); // Windows NUL 不在豁免表
});

test('parse：tee 与 tee -a → 提取目标（含多文件）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('cat in.txt | tee out.py'), ['out.py']);
  assert.deepStrictEqual(parseBashWriteTargets('echo x | tee -a log.py'), ['log.py']);
  assert.deepStrictEqual(parseBashWriteTargets('echo x | tee --append a.py b.py'), ['a.py', 'b.py']);
});

test('parse：sed -i → 提取文件操作数（引号/非引号脚本、-e 变体）；无 -i 不算写', () => {
  assert.deepStrictEqual(parseBashWriteTargets("sed -i 's/a/b/' src/a.py"), ['src/a.py']);
  assert.deepStrictEqual(parseBashWriteTargets('sed -i s/a/b/ src/a.py'), ['src/a.py']);
  assert.deepStrictEqual(
    parseBashWriteTargets("sed -i -e 's/a/b/' -e 's/c/d/' src/a.py"),
    ['src/a.py']
  );
  assert.deepStrictEqual(parseBashWriteTargets("sed 's/a/b/' src/a.py"), []);
});

test('parse：patch < f.diff 与 git apply f.diff → 提取补丁文件', () => {
  assert.deepStrictEqual(parseBashWriteTargets('patch -p1 < fix.diff'), ['fix.diff']);
  assert.deepStrictEqual(parseBashWriteTargets('git apply fix.diff'), ['fix.diff']);
  assert.deepStrictEqual(parseBashWriteTargets('git apply -p1 fix.diff'), ['fix.diff']);
});

test('parse：多命令串联（&&、||、;、| 分隔）逐一解析', () => {
  assert.deepStrictEqual(
    parseBashWriteTargets('echo a > x.py && echo b >> y.py; echo c | tee z.py'),
    ['x.py', 'y.py', 'z.py']
  );
  assert.deepStrictEqual(parseBashWriteTargets('false || echo x > fallback.py'), ['fallback.py']);
});

test('parse：opaque——$(...) 替换目标、heredoc（<<）、无目标的 git apply', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo > $(pwd)/x.py'), [BASH_WRITE_OPAQUE]);
  assert.ok(
    parseBashWriteTargets("python - <<'PYEOF'\nprint('hi')\nPYEOF").includes(BASH_WRITE_OPAQUE)
  );
  assert.deepStrictEqual(parseBashWriteTargets('git apply'), [BASH_WRITE_OPAQUE]);
  assert.ok(parseBashWriteTargets('echo > `pwd`/x.py').includes(BASH_WRITE_OPAQUE));
});

test('parse：反斜杠路径按字面字符（Windows 兼容，正反斜杠均可）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo hi > src\\a.py'), ['src\\a.py']);
  assert.deepStrictEqual(
    parseBashWriteTargets('echo hi > D:\\proj\\src\\a.py'),
    ['D:\\proj\\src\\a.py']
  );
});

test('parse：文档路径照常提取（.md/.json 豁免在 gate 层判定）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo x > docs/a.md'), ['docs/a.md']);
  assert.deepStrictEqual(parseBashWriteTargets('echo x > pkg/config.json'), ['pkg/config.json']);
});

test('parse：无显式写入模式 → 空数组；空串/非字符串边界不崩溃', () => {
  assert.deepStrictEqual(parseBashWriteTargets('ls -la && node --test test/'), []);
  assert.deepStrictEqual(parseBashWriteTargets('grep ">" input.txt'), []);
  assert.deepStrictEqual(parseBashWriteTargets(''), []);
  assert.deepStrictEqual(parseBashWriteTargets(null), []);
});

test('parse：去重保序（同一目标多次出现只记一次）', () => {
  assert.deepStrictEqual(
    parseBashWriteTargets('echo a > x.py && echo b > x.py'),
    ['x.py']
  );
});

// ---- main() Bash 分支 e2e（spawn 真实 gate.js，喂 stdin JSON）----

const GATE_JS = path.join(__dirname, '..', 'hooks', 'gate.js');
const TEST_GUARD_JS = path.join(__dirname, '..', 'hooks', 'test-guard.js');

function mkProject(withSpec) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-sop-patch-'));
  if (withSpec) {
    fs.mkdirSync(path.join(dir, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'specs', 'patch-direct.md'),
      '---\nstatus: approved\nslug: patch-direct\ndate: 2026-11-20\n---\n\n# spec\n',
      'utf8'
    );
  }
  return dir;
}

function runHook(script, payload, cwd) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    cwd: cwd,
    env: Object.assign({}, process.env, { ZCODE_PROJECT_DIR: cwd }),
    timeout: 20000,
    encoding: 'utf8',
  });
}

test('main() e2e：echo x > src/a.py 无 spec → exit 2 deny（文案同 Write/Edit）', () => {
  const dir = mkProject(false);
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'echo x > src/a.py' } }, dir);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('当前项目没有已批准的规格文档'),
    'deny reason 须与 Write/Edit 同文案'
  );
});

test('main() e2e：echo x > docs/x.md 无 spec → exit 0 放行（.md 文档豁免）', () => {
  const dir = mkProject(false);
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'echo x > docs/x.md' } }, dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e：echo x > src/a.py 有 approved spec → exit 0 放行', () => {
  const dir = mkProject(true);
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'echo x > src/a.py' } }, dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e：sed -i 写 src/a.py 无 spec → exit 2 deny', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/a.py" } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e：python heredoc → exit 0 放行且日志记 bash-write-opaque', () => {
  const dir = mkProject(false);
  const marker = 'patch-direct-opaque-' + Date.now() + '-' + process.pid;
  const command = "python - <<'PYEOF'\nprint('" + marker + "')\nPYEOF";
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: command } }, dir);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  const logPath = path.join(os.homedir(), '.zcode', 'hooks', 'dev-sop.log');
  const logLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const hit = logLines.filter((l) => l.includes(marker));
  assert.ok(hit.length > 0, '日志须含该命令记录');
  assert.ok(
    hit.some((l) => l.includes('decision=allow') && l.includes('bash-write-opaque')),
    'heredoc 放行日志须记 bash-write-opaque，实际：' + hit[hit.length - 1]
  );
});

test('main() e2e：>/dev/null 与普通只读命令 → exit 0 放行', () => {
  const dir = mkProject(false);
  const r1 = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'node x.js > /dev/null 2>&1' } },
    dir
  );
  assert.strictEqual(r1.status, 0);
  const r2 = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'ls -la' } }, dir);
  assert.strictEqual(r2.status, 0);
});

// ---- hooks.json Bash matcher 组双 hook 结构（与 test-guard 并存不互扰）----

test('hooks.json：Bash matcher 组挂 test-guard.js 与 gate.js 两条 hook（各 timeoutMs 10000，statusMessage 区分）', () => {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')
  );
  const bashGroups = cfg.hooks.PreToolUse.filter((g) => g.matcher === 'Bash');
  assert.strictEqual(bashGroups.length, 1, 'Bash matcher 组唯一');
  const bashHooks = bashGroups[0].hooks;
  assert.strictEqual(bashHooks.length, 2, 'Bash 组两条 hook');
  const scripts = bashHooks.map((h) => path.basename(h.args[0])).sort();
  assert.deepStrictEqual(scripts, ['gate.js', 'test-guard.js']);
  for (const h of bashHooks) {
    assert.strictEqual(h.timeoutMs, 10000);
  }
  const messages = bashHooks.map((h) => h.statusMessage);
  assert.strictEqual(new Set(messages).size, 2, 'statusMessage 必须互相区分');
});

test('双挂不互扰：test-guard 拦后台测试（exit 2），gate 对同命令放行（exit 0）', () => {
  const dir = mkProject(false);
  const r1 = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'node --test test/', run_in_background: true } },
    dir
  );
  assert.strictEqual(r1.status, 2, 'test-guard 须拦后台测试');
  const r2 = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'node --test test/' } },
    dir
  );
  assert.strictEqual(r2.status, 0, 'gate 对非写入命令放行，不重复 test-guard 职责');
});
