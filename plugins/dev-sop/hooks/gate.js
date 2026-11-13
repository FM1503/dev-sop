#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DENY_REASON =
  '当前项目没有已批准的规格文档（docs/specs/ 下缺少 status: approved 的 spec），' +
  '请先运行 /spec 完成需求澄清访谈→联网调研→方案审批，' +
  '或在项目根创建 .dev-sop-skip 文件临时跳过门禁。';

const AGENT_DENY_REASON =
  '委派任务前请先走 /spec 流程：产出规格文档（docs/specs/）与任务书（docs/tasks/）并在委派 prompt 中引用其路径。' +
  '注意：实际写入代码文件仍受 Write/Edit 层门禁约束（需 status: approved；UI 文件另需 wireframe: approved）。';

const UI_DENY_REASON =
  'UI 文件的编写需要规格文档中线框图已获用户批准（spec frontmatter 需含 wireframe: approved）。' +
  '请先在 spec 中产出 UI 数据表与 ASCII 线框图，经用户批准后添加标记，或创建 .dev-sop-skip。';

const AGENT_TOOLS = new Set(['Agent', 'Task']);

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

function findProjectRoot(targetFile) {
  if (process.env.ZCODE_PROJECT_DIR) {
    return path.resolve(process.env.ZCODE_PROJECT_DIR);
  }
  // Walk up from the target file: prefer the nearest ancestor that looks like a
  // project root, and fall back to the working directory.
  const cwd = path.resolve(process.cwd());
  let dir = path.dirname(path.resolve(targetFile));
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

function existsSyncSafe(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

// 新名 .dev-sop-skip 优先，回退兼容旧名 .spec-gate-skip
function hasSkipMarker(projectRoot) {
  return (
    existsSyncSafe(path.join(projectRoot, '.dev-sop-skip')) ||
    existsSyncSafe(path.join(projectRoot, '.spec-gate-skip'))
  );
}

function isWhitelisted(absFile, projectRoot, originalPath) {
  const normalized = originalPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  const base = path.basename(normalized);

  // docs/specs/ at any level
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'docs' && segments[i + 1] === 'specs') return true;
  }

  // any path segment containing test / tests / __tests__
  for (const seg of segments.slice(0, -1)) {
    const lower = seg.toLowerCase();
    if (lower === '__tests__') return true;
    if (lower.includes('test')) return true;
  }

  if (/\.(test|spec)\.[^./\\]+$/i.test(base)) return true;
  if (base === 'package.json' || base === '.gitignore' || base === 'README.md') return true;

  return false;
}

function scanSpecFrontmatter(projectRoot, markerRe) {
  const specsDir = path.join(projectRoot, 'docs', 'specs');
  if (!existsSyncSafe(specsDir)) return false;
  let entries;
  try {
    const stat = fs.statSync(specsDir);
    if (!stat.isDirectory()) return false;
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    process.stderr.write('[dev-sop] cannot read docs/specs: ' + e.message + '\n');
    return false;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    let content;
    try {
      content = fs.readFileSync(path.join(specsDir, entry.name), 'utf8');
    } catch (e) {
      continue;
    }
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    const head = lines.slice(0, 10);
    let start = -1;
    for (let i = 0; i < head.length; i++) {
      if (/^---\s*$/.test(head[i])) {
        start = i;
        break;
      }
    }
    if (start === -1) continue;
    let end = -1;
    for (let i = start + 1; i < head.length; i++) {
      if (/^---\s*$/.test(head[i])) {
        end = i;
        break;
      }
    }
    if (end === -1) continue;
    const frontmatter = head.slice(start + 1, end).join('\n');
    if (markerRe.test(frontmatter)) return true;
  }
  return false;
}

function hasApprovedSpec(projectRoot) {
  return scanSpecFrontmatter(projectRoot, /status\s*:\s*["']?approved["']?/i);
}

function hasWireframeApprovedSpec(projectRoot) {
  return scanSpecFrontmatter(projectRoot, /wireframe\s*:\s*["']?approved["']?/i);
}

const UI_FILE_EXT_RE = /\.(html?|css|scss|vue|jsx|tsx)$/i;

function isUiFilePath(p) {
  const normalized = String(p).replace(/\\/g, '/');
  if (UI_FILE_EXT_RE.test(normalized)) return true;
  if (/\.js$/i.test(normalized) && /(^|\/)ui\//i.test(normalized)) return true;
  return false;
}

function readStdin() {
  return new Promise((resolve, reject) => {
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
    stdin.on('error', reject);
    setTimeout(() => resolve(data), 5000);
  });
}

function pickFilePath(input) {
  const candidates = [];
  if (input && typeof input === 'object') {
    if (typeof input.file_path === 'string') candidates.push(input.file_path);
    if (typeof input.path === 'string') candidates.push(input.path);
    if (typeof input.filePath === 'string') candidates.push(input.filePath);
    if (input.tool_input && typeof input.tool_input === 'object') {
      const ti = input.tool_input;
      if (typeof ti.file_path === 'string') candidates.push(ti.file_path);
      if (typeof ti.path === 'string') candidates.push(ti.path);
      if (typeof ti.filePath === 'string') candidates.push(ti.filePath);
    }
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c;
  }
  return null;
}

function getToolName(payload) {
  const name = payload && typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!name && payload && payload.tool && typeof payload.tool === 'object') {
    return typeof payload.tool.name === 'string' ? payload.tool.name : '';
  }
  return name;
}

function getAgentPrompt(payload) {
  const inputs = [];
  if (payload && typeof payload.tool_input === 'object' && payload.tool_input) {
    inputs.push(payload.tool_input);
  }
  if (payload && payload.tool && typeof payload.tool === 'object' && payload.tool.input) {
    inputs.push(payload.tool.input);
  }
  for (const input of inputs) {
    if (typeof input.prompt === 'string') return input.prompt;
  }
  for (const input of inputs) {
    if (typeof input.description === 'string') return input.description;
  }
  return '';
}

function referencesDocsPath(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false;
  const re = /docs[\/\\](specs|tasks)[\/\\][\w\-\/\\\u4e00-\u9fa5]+\.md/g;
  return re.test(prompt);
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

async function main() {
  let raw = '';
  try {
    raw = await readStdin();
  } catch (e) {
    process.stderr.write('[dev-sop] failed to read stdin: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', '', '', 'error', 'failed to read stdin: ' + (e && e.message));
    return 0;
  }

  let payload;
  try {
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    process.stderr.write('[dev-sop] failed to parse stdin JSON: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', '', '', 'error', 'failed to parse stdin JSON: ' + (e && e.message));
    return 0;
  }

  const toolName = getToolName(payload);

  // ---- Agent / Task delegation ----
  if (AGENT_TOOLS.has(toolName)) {
    let projectRoot;
    try {
      projectRoot = findProjectRoot(path.join(process.cwd(), '__dev_sop_probe__'));
    } catch (e) {
      process.stderr.write('[dev-sop] failed to resolve project root: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'project root: ' + (e && e.message));
      return 0;
    }

    if (hasSkipMarker(projectRoot)) {
      appendLog('PreToolUse', toolName, '(agent)', 'allow', 'skip file present');
      return 0;
    }

    let promptText = '';
    try {
      promptText = getAgentPrompt(payload);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to scan agent prompt: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan prompt: ' + (e && e.message));
      return 0;
    }

    let allow = false;
    try {
      allow = referencesDocsPath(promptText);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to scan agent prompt: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan prompt: ' + (e && e.message));
      return 0;
    }

    if (allow) {
      appendLog('PreToolUse', toolName, '(agent)', 'allow', 'references docs/specs or docs/tasks path');
      return 0;
    }
    appendLog('PreToolUse', toolName, '(agent)', 'deny', 'no docs/specs or docs/tasks path referenced');
    return deny(AGENT_DENY_REASON);
  }

  // ---- Edit / Write / ApplyPatch ----
  const rawFile = pickFilePath(payload);
  if (!rawFile) {
    appendLog('PreToolUse', toolName, '', 'allow', 'no target file');
    return 0;
  }

  let absFile;
  let projectRoot;
  try {
    absFile = path.resolve(rawFile);
    projectRoot = findProjectRoot(absFile);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to resolve project root: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, rawFile, 'error', 'project root: ' + (e && e.message));
    return 0;
  }

  if (isWhitelisted(absFile, projectRoot, rawFile)) {
    appendLog('PreToolUse', toolName, rawFile, 'allow', 'whitelisted path');
    return 0;
  }

  let skip = false;
  try {
    skip = hasSkipMarker(projectRoot);
  } catch (e) {
    skip = false;
  }
  if (skip) {
    appendLog('PreToolUse', toolName, rawFile, 'allow', 'skip file present');
    return 0;
  }

  // ---- UI hard gate ----
  if (isUiFilePath(rawFile)) {
    let wireframe = false;
    try {
      wireframe = hasWireframeApprovedSpec(projectRoot);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to check wireframe spec: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, rawFile, 'error', 'check wireframe spec: ' + (e && e.message));
      return 0;
    }
    if (wireframe) {
      appendLog('PreToolUse', toolName, rawFile, 'allow', 'ui wireframe approved');
      return 0;
    }
    appendLog('PreToolUse', toolName, rawFile, 'deny', 'UI file without wireframe-approved spec');
    return deny(UI_DENY_REASON);
  }

  let approved = false;
  try {
    approved = hasApprovedSpec(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to check specs: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, rawFile, 'error', 'check specs: ' + (e && e.message));
    return 0;
  }
  if (approved) {
    appendLog('PreToolUse', toolName, rawFile, 'allow', 'approved spec found');
    return 0;
  }

  appendLog('PreToolUse', toolName, rawFile, 'deny', 'no approved spec');
  return deny(DENY_REASON);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write('[dev-sop] internal error: ' + (err && err.stack ? err.stack : err) + '\n');
    appendLog('PreToolUse', '', '', 'error', 'internal error: ' + (err && err.message ? err.message : err));
    process.exit(0);
  }
);
