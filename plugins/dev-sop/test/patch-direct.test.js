'use strict';
// patch-direct.test.js — v1.7.0 补丁直改配套测试（TDD：先于验收编写）
// 规则来源：docs/specs/patch-direct.md 2.B（gate.js Bash 写模式检测）
//   parseBashWriteTargets 纯函数：显式写入模式识别——重定向 > / >>（2> 忽略、
//   /dev/null 归一保留）、tee（含 -a）、sed -i、patch <f / git apply f；引号路径
//   兼容；多命令（&&、;、| 分隔）逐一解析；反斜杠按字面字符（Windows 兼容）；
//   无法确定目标（$(...) 替换、heredoc、patch 读 stdin 等）→ 'opaque' 标记项。
//   main() Bash 分支 e2e（spawn 真实 gate.js，修复轮2 fail-closed）：无 spec 写代码
//   文件 → deny（文案同 Write/Edit）；写 .md → 放行；有 approved spec → 放行；
//   opaque 及一切疑似写入（heredoc / 嵌套解释器 / >& 文件名）→ 完整门禁链（无 spec
//   → deny、日志 bash-write-gated；有 spec → 放行）；纯读命令照旧放行。另含
//   hooks.json Bash 组双 hook 结构断言（与 test-guard 并存不互扰）与 test-guard
//   后台测试回归。

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
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > NUL'), ['/dev/null']); // 修复轮 P2：NUL 豁免同 /dev/null
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

// ---- 修复轮 P1-1：引号感知命令切分（splitCommands）----

test('parse（P1-1）：双引号内 && 不切分——echo "a && b" > src/a.js → 目标 src/a.js', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo "a && b" > src/a.js'), ['src/a.js']);
});

test("parse（P1-1）：单引号内 | 不切分——echo 'x|y' > src/b.js → 目标 src/b.js", () => {
  assert.deepStrictEqual(parseBashWriteTargets("echo 'x|y' > src/b.js"), ['src/b.js']);
});

test('parse（P1-1）：未闭合引号 → 整段一条并标记 opaque（安全侧）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo "a && b > src/a.js'), [BASH_WRITE_OPAQUE]);
  assert.ok(parseBashWriteTargets("echo 'x > src/b.js").includes(BASH_WRITE_OPAQUE));
});

test('parse（P1-1）：引号内 ; 不切分——echo "a;b" > src/c.js → 目标 src/c.js', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo "a;b" > src/c.js'), ['src/c.js']);
});

test('parse（P1-1）：反斜杠转义分隔符（\\; \\|）不构成切分点', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo a\\;b > src/d.js'), ['src/d.js']);
  assert.deepStrictEqual(parseBashWriteTargets('echo x\\|y > src/e.js'), ['src/e.js']);
});

// ---- 修复轮 P1-2：嵌套解释器（bash -c / sh -c / cmd /c）→ opaque ----

test('parse（P1-2）：嵌套解释器 bash -c / sh -c / cmd /c（词边界）→ 追加 opaque', () => {
  assert.deepStrictEqual(
    parseBashWriteTargets('bash -c "echo x > src/a.js"'),
    [BASH_WRITE_OPAQUE]
  );
  assert.ok(parseBashWriteTargets("sh -c 'sed -i s/a/b/ f.py'").includes(BASH_WRITE_OPAQUE));
  assert.ok(parseBashWriteTargets('cmd /c "echo x > src/a.js"').includes(BASH_WRITE_OPAQUE));
});

test('parse（P1-2）：普通 bash/sh 调用不受影响（无 opaque、无目标）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('bash build.sh && sh run.sh'), []);
  assert.deepStrictEqual(parseBashWriteTargets('bash --version'), []);
});

// ---- 修复轮 P2：>&2 / 2>&1 fd 复制忽略；NUL 豁免同 /dev/null ----

test('parse（P2）：>&2 / 1>&2 fd 复制不标 opaque（stderr 重定向忽略）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >&2'), []);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js 1>&2'), []);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > out.py 2>&1'), ['out.py']);
});

test('parse（P2）：>> NUL / 小写 nul 同样归一 /dev/null', () => {
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >> NUL'), ['/dev/null']);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js > nul'), ['/dev/null']);
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

test('main() e2e（轮2 fail-closed）：python heredoc 无 spec → exit 2 deny 且日志记 bash-write-gated', () => {
  const dir = mkProject(false);
  const marker = 'patch-direct-opaque-' + Date.now() + '-' + process.pid;
  const command = "python - <<'PYEOF'\nprint('" + marker + "')\nPYEOF";
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: command } }, dir);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('检测到疑似文件写入的命令'),
    'opaque 门禁 deny 须用 Bash 写检测专用文案，实际：' + out.hookSpecificOutput.permissionDecisionReason
  );
  const logPath = path.join(os.homedir(), '.zcode', 'hooks', 'dev-sop.log');
  const logLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const hit = logLines.filter((l) => l.includes(marker));
  assert.ok(hit.length > 0, '日志须含该命令记录');
  assert.ok(
    hit.some((l) => l.includes('decision=deny') && l.includes('bash-write-gated')),
    'heredoc deny 日志须记 bash-write-gated，实际：' + hit[hit.length - 1]
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

// ---- 修复轮 e2e：P1-1 引号内 && 不再漏判；P1-2 嵌套解释器 opaque（轮2 起 fail-closed 过门禁）----

test('main() e2e（P1-1）：echo "a && b" > src/a.js 无 spec → exit 2 deny（引号内 && 不再漏判目标）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'echo "a && b" > src/a.js' } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e（轮2 fail-closed）：bash -c "echo x > src/a.js" 无 spec → exit 2 deny（嵌套解释器 opaque 过门禁）', () => {
  const dir = mkProject(false);
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'bash -c "echo x > src/a.js"' } }, dir);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('检测到疑似文件写入的命令'),
    'opaque 门禁 deny 须用 Bash 写检测专用文案，实际：' + out.hookSpecificOutput.permissionDecisionReason
  );
});

// ---- 修复轮2（fail-closed）：解析边角 + opaque 及一切疑似写入走完整门禁链 ----

test('parse（轮2）：解释器枚举扩展（bash -x -c / node -e / python3 -c / pwsh -c）→ opaque', () => {
  assert.ok(parseBashWriteTargets('bash -x -c "echo x > src/a.js"').includes(BASH_WRITE_OPAQUE));
  assert.ok(
    parseBashWriteTargets('node -e "fs.writeFileSync(\'src/a.js\', \'x\')"').includes(BASH_WRITE_OPAQUE)
  );
  assert.ok(parseBashWriteTargets('python3 -c "open(\'src/a.js\', \'w\')"').includes(BASH_WRITE_OPAQUE));
  assert.ok(parseBashWriteTargets('pwsh -c "Set-Content src/a.js x"').includes(BASH_WRITE_OPAQUE));
});

test('parse（轮2）：>& 文件名（古式）→ opaque；>&2 / 2>&1 fd 复制仍忽略', () => {
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >& out.log'), [BASH_WRITE_OPAQUE]);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >&out.log'), [BASH_WRITE_OPAQUE]);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js >&2'), []);
  assert.deepStrictEqual(parseBashWriteTargets('node x.js 2>&1'), []);
});

test('parse（轮2）：heredoc 混合 cat > f <<EOF → 显式目标与 opaque 并存（不短路）', () => {
  assert.deepStrictEqual(
    parseBashWriteTargets('cat > src/a.js <<EOF\nhello\nEOF'),
    ['src/a.js', BASH_WRITE_OPAQUE]
  );
});

test('parse（轮2）：双引号内转义引号不切分，目标正常提取', () => {
  assert.deepStrictEqual(parseBashWriteTargets('echo "a\\"b && c" > src/a.js'), ['src/a.js']);
});

test('main() e2e（轮2）：echo "a\\"b && c" > src/a.js 无 spec → exit 2 deny（转义引号不漏判目标）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'echo "a\\"b && c" > src/a.js' } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e（轮2）：cat > src/a.js <<EOF 混合无 spec → exit 2 deny（显式目标+opaque 统一门禁不短路）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'cat > src/a.js <<EOF\nhello\nEOF' } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e（轮2）：bash -x -c "echo x > src/a.js" 无 spec → exit 2 deny 且日志记 bash-write-gated', () => {
  const dir = mkProject(false);
  const marker = 'patch-direct-r2-nested-' + Date.now() + '-' + process.pid;
  const command = 'bash -x -c "echo ' + marker + ' > src/a.js"';
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: command } }, dir);
  assert.strictEqual(r.status, 2);
  const logPath = path.join(os.homedir(), '.zcode', 'hooks', 'dev-sop.log');
  const logLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const hit = logLines.filter((l) => l.includes(marker));
  assert.ok(hit.length > 0, '日志须含该命令记录');
  assert.ok(
    hit.some((l) => l.includes('decision=deny') && l.includes('bash-write-gated')),
    '嵌套解释器 deny 日志须记 bash-write-gated，实际：' + hit[hit.length - 1]
  );
});

test('main() e2e（轮2）：node -e "fs.writeFileSync(...)" 无 spec → exit 2 deny', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'node -e "fs.writeFileSync(\'src/a.js\', \'x\')"' } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('检测到疑似文件写入的命令'),
    'opaque 门禁 deny 须用 Bash 写检测专用文案，实际：' + out.hookSpecificOutput.permissionDecisionReason
  );
});

test('main() e2e（轮2）：>& out.log 无 spec → exit 2 deny（古式 >& 文件名标 opaque 过门禁）', () => {
  const dir = mkProject(false);
  const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: 'node x.js >& out.log' } }, dir);
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('main() e2e（轮2）：纯 pytest tests/ → exit 0 放行且日志不含 bash-write-gated', () => {
  const dir = mkProject(false);
  const marker = 'patch-direct-r2-pure-' + Date.now() + '-' + process.pid;
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'pytest tests/ && echo ' + marker } },
    dir
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
  const logPath = path.join(os.homedir(), '.zcode', 'hooks', 'dev-sop.log');
  const logLines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const hit = logLines.filter((l) => l.includes(marker));
  assert.ok(hit.length > 0, '日志须含该命令记录');
  assert.ok(
    hit.every((l) => l.includes('decision=allow') && !l.includes('bash-write-gated')),
    '纯读命令日志不得含 bash-write-gated，实际：' + hit[hit.length - 1]
  );
});

test('main() e2e（轮2）：grep x > /dev/null → exit 0 放行（/dev/null 豁免不受 fail-closed 影响）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'grep x input.txt > /dev/null' } },
    dir
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e（轮2）：有 approved spec 时上述写入全放行（含 opaque 与混合 heredoc）', () => {
  const dir = mkProject(true);
  const commands = [
    'echo "a\\"b && c" > src/a.js',
    'cat > src/a.js <<EOF\nhello\nEOF',
    'bash -x -c "echo x > src/a.js"',
    'node -e "fs.writeFileSync(\'src/a.js\', \'x\')"',
    'node x.js >& out.log',
  ];
  for (const command of commands) {
    const r = runHook(GATE_JS, { tool_name: 'Bash', tool_input: { command: command } }, dir);
    assert.strictEqual(r.status, 0, '有 approved spec 须放行：' + command);
    assert.strictEqual(r.stdout.trim(), '');
  }
});

// ---- 终修：解释器执行旗标命令位锚定（interpreterExecFlag，杜绝非命令位字面误报）----

test('parse（终修）：命令位解释器执行旗标 → opaque（bash -cx / powershell -Command / node -e / python -c / cmd /c）', () => {
  assert.ok(
    parseBashWriteTargets('bash -cx "echo x > src/a.js"').includes(BASH_WRITE_OPAQUE),
    'bash -cx 短旗标组合须命中'
  );
  assert.ok(
    parseBashWriteTargets('powershell -Command "Set-Content src/a.js x"').includes(BASH_WRITE_OPAQUE),
    'powershell -Command 须命中'
  );
  assert.deepStrictEqual(parseBashWriteTargets("node -e 'code'"), [BASH_WRITE_OPAQUE]);
  assert.deepStrictEqual(parseBashWriteTargets('python -c "print(1)"'), [BASH_WRITE_OPAQUE]);
  assert.ok(parseBashWriteTargets('cmd /c "echo x > src/a.js"').includes(BASH_WRITE_OPAQUE));
  assert.ok(parseBashWriteTargets('echo x | bash -c "y > src/a.js"').includes(BASH_WRITE_OPAQUE));
});

test('parse（终修）：非命令位提及解释器旗标不误报（grep 参数 / echo 句中 / git -m 引号内）', () => {
  assert.deepStrictEqual(parseBashWriteTargets('grep -n "node -e" docs/readme.md'), []);
  assert.deepStrictEqual(parseBashWriteTargets('echo run node -e code here'), []);
  assert.deepStrictEqual(parseBashWriteTargets('git commit -m "bash -c demo"'), []);
});

test('main() e2e（终修）：bash -cx "echo x > src/a.js" 无 spec → exit 2 deny（短旗标组合 gated）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'bash -cx "echo x > src/a.js"' } },
    dir
  );
  assert.strictEqual(r.status, 2);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(
    out.hookSpecificOutput.permissionDecisionReason.includes('检测到疑似文件写入的命令'),
    'deny 文案须含 Bash 写检测专用文案，实际：' + out.hookSpecificOutput.permissionDecisionReason
  );
});

test('main() e2e（终修）：grep -n "node -e" docs/readme.md → exit 0 放行（命令位锚定不误报）', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'grep -n "node -e" docs/readme.md' } },
    dir
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

test('main() e2e（终修）：echo 句中提及 node -e → exit 0 放行', () => {
  const dir = mkProject(false);
  const r = runHook(
    GATE_JS,
    { tool_name: 'Bash', tool_input: { command: 'echo run node -e code here' } },
    dir
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
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

// ---- v1.9.0 混合栈规格 2.B：test-guard dotnet 测试预算扩展（dotnet test/vstest/mstest）----

function denyReasonOf(r) {
  assert.strictEqual(r.status, 2, '须 deny（exit 2），实际 stdout：' + r.stdout);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  return out.hookSpecificOutput.permissionDecisionReason;
}

test('test-guard dotnet：dotnet test 后台运行 → deny（background 禁令同样适用）', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet test', run_in_background: true } },
    dir
  );
  denyReasonOf(r);
});

test('test-guard dotnet：dotnet test timeout 400000 → deny 且文案含"dotnet test 含构建，预算 5 分钟"', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet test --filter Add', timeout: 400000 } },
    dir
  );
  const reason = denyReasonOf(r);
  assert.ok(reason.includes('dotnet test 含构建，预算 5 分钟'), 'deny 文案须含 dotnet 专用预算说明，实际：' + reason);
});

test('test-guard dotnet：dotnet test timeout 300000（上限内）→ exit 0 放行', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet test', timeout: 300000 } },
    dir
  );
  assert.strictEqual(r.status, 0, '300000ms ≤ DOTNET_TIMEOUT_MS 须放行');
  assert.strictEqual(r.stdout.trim(), '');
});

test('test-guard dotnet：dotnet test timeout 150000（超通用预算、在 dotnet 预算内）→ 放行', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet test -c Release', timeout: 150000 } },
    dir
  );
  assert.strictEqual(r.status, 0, '放宽区间 (120000, 300000] 内须放行');
  assert.strictEqual(r.stdout.trim(), '');
});

test('test-guard dotnet：dotnet vstest 特征命中，预算仍按通用 120000（timeout 200000 → deny）', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet vstest Tests.dll', timeout: 200000 } },
    dir
  );
  const reason = denyReasonOf(r);
  assert.ok(!reason.includes('预算 5 分钟'), 'vstest 非 dotnet test，须用通用文案，实际：' + reason);
});

test('test-guard dotnet：mstest 特征命中（无 test 整词仍识别为测试），timeout 200000 → deny', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'mstest /testcontainer:bin/x.dll', timeout: 200000 } },
    dir
  );
  denyReasonOf(r);
});

test('test-guard 回归：pytest timeout 200000 仍按 120000 deny（既有特征与预算不变）', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'pytest tests/', timeout: 200000 } },
    dir
  );
  const reason = denyReasonOf(r);
  assert.ok(!reason.includes('预算 5 分钟'), '非 dotnet 命令不得出现 dotnet 专用文案，实际：' + reason);
});

test('test-guard 回归：dotnet build（非测试命令）timeout 300000 → 放行，不受 dotnet 扩展影响', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet build Services.csproj', timeout: 300000 } },
    dir
  );
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout.trim(), '');
});

// ---- 修复轮 P1-2/P2#①：dotnet watch 监听形态 deny 与 DOTNET_TEST_RE 大小写不敏感 ----

test('test-guard 修复轮：dotnet watch test（监听+测试）→ deny（WATCH_RE dotnet watch 形态，文案不变）', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet watch test', timeout: 300000 } },
    dir
  );
  const reason = denyReasonOf(r);
  assert.ok(!reason.includes('预算 5 分钟'), 'WATCH deny 沿用通用文案，实际：' + reason);
});

test('test-guard 修复轮：dotnet watch run（无 test 词的监听形态）→ deny', () => {
  const dir = mkProject(false);
  const r = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'dotnet watch run --project App.csproj' } },
    dir
  );
  denyReasonOf(r);
});

test('test-guard 修复轮 P2#①：Dotnet Test 大小写不敏感享 300s（250000 放行；400000 deny 含 dotnet 专用文案）', () => {
  const dir = mkProject(false);
  const ok = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'Dotnet Test --filter Add', timeout: 250000 } },
    dir
  );
  assert.strictEqual(ok.status, 0, '大写形态命中 300000 预算须放行');
  assert.strictEqual(ok.stdout.trim(), '');
  const bad = runHook(
    TEST_GUARD_JS,
    { tool_name: 'Bash', tool_input: { command: 'DOTNET TEST', timeout: 400000 } },
    dir
  );
  const reason = denyReasonOf(bad);
  assert.ok(reason.includes('dotnet test 含构建，预算 5 分钟'), '须用 dotnet 专用文案，实际：' + reason);
});
