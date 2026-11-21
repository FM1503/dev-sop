#!/usr/bin/env node
'use strict';
// test-guard.js — PreToolUse on Bash 门禁：验收测试预算纪律
// 拦截：后台测试、监听模式测试、超 2 分钟预算的测试命令。
// 项目根存在 .dev-sop-skip（或旧名 .spec-gate-skip）、.dev-sop-approve-longtest
// （或旧名 .spec-gate-approve-longtest）时放行（新名优先，旧名回退兼容）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DENY_REASON =
  '测试预算纪律：单命令≤2分钟、禁止后台/监听模式长跑测试。' +
  '请缩小测试范围（只跑受影响用例）并显式设置≤120000ms 的 timeout；' +
  '确需长跑须征得用户批准并在项目根创建 .dev-sop-approve-longtest。';

const TEST_FEATURE_RE =
  /\b(test|spec|pytest|jest|vitest|mocha|karma|playwright|cypress|unittest|ctest|rspec)\b/i;

// v1.9.0 混合栈规格 2.B：dotnet 系测试特征
const DOTNET_TEST_RE = /\bdotnet\s+test\b/;
const DOTNET_VSTEST_RE = /\bvstest(\.console)?\b/i;
const DOTNET_MSTEST_RE = /\bmstest\b/i;

// dotnet test 含 restore+build（首跑慢）：预算单独放宽至 5 分钟；其余测试命令仍 120000ms。
const DOTNET_TIMEOUT_MS = 300000;
const DENY_REASON_DOTNET =
  DENY_REASON + ' dotnet test 含构建，预算 5 分钟（超时上限 300000ms）。';

const RUNNER_COMBINATION_RE = /\b(npm|npx|uv)\s+(run\s+)?\S*\btest/i;

const WATCH_RE = /--watch[a-z]*($|=|\s)|nodemon|-w\s+\//i;

function appendLog(event, tool, target, decision, reason) {
  try {
    const dir = path.join(os.homedir(), '.zcode', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const line =
      new Date().toISOString() +
      ' | 事件=' + event +
      ' | tool=' + String(tool || '').replace(/[\r\n|]/g, ' ') +
      ' | target=' + String(target || '').replace(/[\r\n|]/g, ' ') +
      ' | decision=' + decision +
      ' | reason=' + String(reason || '').replace(/[\r\n|]/g, ' ') +
      '\n';
    fs.appendFileSync(path.join(dir, 'dev-sop.log'), line, 'utf8');
  } catch (e) {
    // Logging must never affect the gate.
  }
}

function existsSyncSafe(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

// 与 gate.js 相同的项目根探测逻辑
function findProjectRoot(probeFile) {
  if (process.env.ZCODE_PROJECT_DIR) {
    return path.resolve(process.env.ZCODE_PROJECT_DIR);
  }
  const cwd = path.resolve(process.cwd());
  let dir = path.dirname(path.resolve(probeFile));
  while (true) {
    if (dir === cwd) return cwd;
    if (
      existsSyncSafe(path.join(dir, '.git')) ||
      existsSyncSafe(path.join(dir, 'package.json')) ||
      existsSyncSafe(path.join(dir, 'docs', 'specs')) ||
      existsSyncSafe(path.join(dir, '.dev-sop-skip')) ||
      existsSyncSafe(path.join(dir, '.spec-gate-skip')) // 旧名回退兼容
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}

function isTestCommand(command) {
  if (typeof command !== 'string' || command === '') return false;
  // v1.9.0：vstest/mstest 单词不含 \btest\b（vstest 为整词），须单独命中特征正则
  if (DOTNET_VSTEST_RE.test(command) || DOTNET_MSTEST_RE.test(command)) return true;
  if (TEST_FEATURE_RE.test(command)) {
    // 排除 cargo/go 等非测试词误报：单独处理
    if (/\b(cargo|go)\s+test\b/i.test(command)) return true;
    return true;
  }
  if (RUNNER_COMBINATION_RE.test(command)) return true;
  if (/\bcargo\s+test\b|\bgo\s+test\b/i.test(command)) return true;
  return false;
}

function deny(reason) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  return 2;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    appendLog('PreToolUse-Bash', 'Bash', '', 'pass', 'invalid stdin JSON');
    return 0;
  }

  const toolName = payload && typeof payload.tool_name === 'string' ? payload.tool_name : 'Bash';
  const toolInput = payload && typeof payload.tool_input === 'object' && payload.tool_input ? payload.tool_input : {};
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const runInBackground = toolInput.run_in_background === true;
  const timeout = typeof toolInput.timeout === 'number' ? toolInput.timeout : null;

  const target = command.slice(0, 120);

  let projectRoot;
  try {
    projectRoot = findProjectRoot(path.join(process.cwd(), '__dev_sop_probe__'));
  } catch (e) {
    appendLog('PreToolUse-Bash', toolName, target, 'error', 'project root: ' + (e && e.message));
    return 0;
  }

  if (
    existsSyncSafe(path.join(projectRoot, '.dev-sop-skip')) ||
    existsSyncSafe(path.join(projectRoot, '.spec-gate-skip')) || // 旧名回退兼容
    existsSyncSafe(path.join(projectRoot, '.dev-sop-approve-longtest')) ||
    existsSyncSafe(path.join(projectRoot, '.spec-gate-approve-longtest')) // 旧名回退兼容
  ) {
    appendLog('PreToolUse-Bash', toolName, target, 'allow', 'skip or longtest-approve file present');
    return 0;
  }

  let isTest = false;
  try {
    isTest = isTestCommand(command);
  } catch (e) {
    appendLog('PreToolUse-Bash', toolName, target, 'error', 'classify command: ' + (e && e.message));
    return 0;
  }

  if (!isTest) {
    appendLog('PreToolUse-Bash', toolName, target, 'allow', 'not a test command');
    return 0;
  }

  if (runInBackground) {
    appendLog('PreToolUse-Bash', toolName, target, 'deny', 'test command in background');
    return deny(DENY_REASON);
  }
  if (WATCH_RE.test(command)) {
    appendLog('PreToolUse-Bash', toolName, target, 'deny', 'test command in watch mode');
    return deny(DENY_REASON);
  }
  // v1.9.0 混合栈规格 2.B：dotnet test 预算放宽至 DOTNET_TIMEOUT_MS，其余维持 120000ms
  const isDotnetTest = DOTNET_TEST_RE.test(command);
  const budgetMs = isDotnetTest ? DOTNET_TIMEOUT_MS : 120000;
  if (timeout !== null && timeout > budgetMs) {
    appendLog('PreToolUse-Bash', toolName, target, 'deny', 'test command timeout ' + timeout + 'ms > ' + budgetMs + 'ms');
    return deny(isDotnetTest ? DENY_REASON_DOTNET : DENY_REASON);
  }

  appendLog('PreToolUse-Bash', toolName, target, 'allow', 'test command within budget');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write('[dev-sop] internal error: ' + (err && err.stack ? err.stack : err) + '\n');
    appendLog('PreToolUse-Bash', '', '', 'error', 'internal error: ' + (err && err.message ? err.message : err));
    process.exit(0);
  }
);
