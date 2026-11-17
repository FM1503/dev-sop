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

// v1.5.0 执行书硬门禁：编码类委派缺执行书引用时的拒绝原因（规格 2.3 原文；
// v1.5.1 审查修复 P1-1/P1-2：补验收类委派自动豁免说明句）
const EXEC_PLAN_DENY_REASON =
  '编码委派必须附执行书（docs/tasks/<slug>-exec.md，含精确 old→new 与验证步骤）' +
  '或声明 exec-plan: exempt（仅限非编码任务或用户明确豁免）；勘探由主会话亲自完成（Read/Grep）。' +
  '验收类委派（输出 review/ui/test-report）自动豁免。纯文档/调研类委派可加独立成行的 exec-plan: exempt。';

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
      existsSyncSafe(path.join(dir, 'docs', 'changes')) || // v1.4.0：变更单项目根锚点
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

  // docs/specs/ 与 docs/changes/（变更单）at any level：仅 .md/.json 文档文件放行
  // （审查修复 P2-1：其他扩展名如 .html 不再白名单放行，继续走后续门禁判定）
  const docsExt = path.extname(base).toLowerCase();
  if (docsExt === '.md' || docsExt === '.json') {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i] === 'docs' && (segments[i + 1] === 'specs' || segments[i + 1] === 'changes')) return true;
    }
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

// 通用目录扫描：dir 下任一 .md 的 frontmatter（10 行容错）命中 markerRe（或满足
// predicate 函数）→ 返回该文件绝对路径，否则返回 null。供 docs/specs 与
// docs/changes（变更单）共用。
function scanFrontmatterDir(dirPath, markerReOrPredicate) {
  const matchFrontmatter = typeof markerReOrPredicate === 'function'
    ? markerReOrPredicate
    : (fm) => markerReOrPredicate.test(fm);
  if (!existsSyncSafe(dirPath)) return null;
  let entries;
  try {
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) return null;
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (e) {
    process.stderr.write('[dev-sop] cannot read ' + dirPath + ': ' + e.message + '\n');
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    let content;
    try {
      content = fs.readFileSync(path.join(dirPath, entry.name), 'utf8');
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
    if (matchFrontmatter(frontmatter)) return path.join(dirPath, entry.name);
  }
  return null;
}

function scanSpecFrontmatter(projectRoot, markerRe) {
  return scanFrontmatterDir(path.join(projectRoot, 'docs', 'specs'), markerRe) !== null;
}

// 行首锚定（审查修复 P2-2）：与 accept-check.js 侧 frontmatterField 解析宽松度一致，
// 防 "review-status: approved"、"status: approved-pending" 等子串误识别。
function hasApprovedSpec(projectRoot) {
  return scanSpecFrontmatter(projectRoot, /^status\s*:\s*["']?approved["']?\s*$/mi);
}

// 行首锚定（增量快审遗留 P2）：与上方 status / tier 一致的 mi 锚定风格，
// 防 "xwireframe: approved"、"wireframe: approved-pending" 等子串/取值边界误识别。
function hasWireframeApprovedSpec(projectRoot) {
  return scanSpecFrontmatter(projectRoot, /^wireframe\s*:\s*["']?approved["']?\s*$/mi);
}

// frontmatter 逗号分隔文件列表（去成对引号与空白，过滤空串），与 accept-check.js
// parseFileList 同语义
function splitFileListValue(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// 变更单解锁（v1.4.0 分级路由，审查修复 P1/P2-2 收紧）：docs/changes/*.md 任一
// frontmatter（10 行容错）须同时满足 status: approved、tier∈{S,M}（大小写不敏感，
// 均行首锚定）且 changed-files 字段存在、值非空 → 返回该变更单路径，否则 null；
// tier: L / 缺 tier / 缺 changed-files 的变更单不解锁（引导走 docs/specs 全量流程）。
function findApprovedChangeNote(projectRoot) {
  return scanFrontmatterDir(path.join(projectRoot, 'docs', 'changes'), (fm) => {
    if (!/^status\s*:\s*["']?approved["']?\s*$/mi.test(fm)) return false;
    if (!/^tier\s*:\s*["']?[sm]["']?\s*$/mi.test(fm)) return false;
    const filesRaw = fm.match(/^changed-files\s*:\s*(.+)$/mi);
    if (!filesRaw) return false;
    return splitFileListValue(filesRaw[1]).length > 0;
  });
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
  const re = /docs[\/\\](specs|tasks|changes)[\/\\][\w\-\/\\\u4e00-\u9fa5]+\.md/g;
  return re.test(prompt);
}

// v1.5.0 执行书硬门禁纯函数（规格 docs/specs/exec-plan.md 2.3）：
//   isCodingDelegation：prompt 提及代码扩展名文件或 lvgl+.c（.c 已在扩展名表内，
//     "lvgl 相关 .c" 天然覆盖），大小写不敏感。纯文档（.md）与报告类 .json 不算
//     编码。
//   hasExecPlanReference：prompt 引用执行书 docs/tasks/<...>-exec.md、变更单
//     docs/changes/<...>.md（S 级执行书并入其改动清单表），或显式标记
//     exec-plan: exempt（v1.5.1 第二轮修复 P2-1 根治：行首锚定整行精确匹配
//     /^exec-plan:\s*exempt$/m，标记须独立成行，deny 原文引用/句中讨论不再
//     误触发）。正则无 g 标志（stateless，可重复调用）。
//   isAcceptanceDelegation（v1.5.1 审查修复 P1-1/P1-2）：prompt 引用验收报告
//     输出路径 docs/(specs|changes)/<...>.(review|ui|test)-report.json → 判定为
//     验收类委派（reviewer 审查、UI 量化闭环、test-report 产出），豁免执行书
//     要求——置于编码判定之前。slug 字符类含 \u4e00-\u9fa5（中文 slug 报告
//     路径，v1.5.1 第二轮修复 P2-2）。
const CODE_FILE_EXT_RE =
  /\.(?:mjs|cjs|tsx|jsx|cpp|cxx|cc|hpp|hxx|scss|sass|html?|css|less|styl|svelte|vue|yaml|yml|toml|ini|conf|xml|sql|lua|dart|swift|scala|kts|kt|php|java|bash|zsh|fish|ps1|bat|cmd|py|rb|go|rs|cs|ts|js|c|h)(?!\w)/i;

const EXEC_PLAN_DOC_RE =
  /docs[\/\\]tasks[\/\\][\w\-\/\\\u4e00-\u9fa5]+-exec\.md(?!\w)/i;
const CHANGE_NOTE_DOC_RE =
  /docs[\/\\]changes[\/\\][\w\-\/\\\u4e00-\u9fa5]+\.md(?!\w)/i;
// v1.5.1 第二轮修复 P2-1（根治）：行首锚定整行精确匹配（多行模式）——标记必须
// 独立成行，deny 原文引用（该串嵌在句中）与句中讨论性文本不再误触发。
const EXEC_PLAN_EXEMPT_RE = /^exec-plan:\s*exempt$/m;
const ACCEPTANCE_REPORT_RE =
  /docs[\/\\](?:specs|changes)[\/\\][\w\-\/\\\u4e00-\u9fa5]+\.(?:review|ui|test)-report\.json(?!\w)/i;

function isCodingDelegation(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false;
  // v1.6.0：先剔除 docs/ 前缀路径子串（docs/ 下文件均为文档/报告，不属编码目标），
  // 减少纯文档委派因提及 docs 内 .js 报告名或清单被误判为编码类；正则兼容中文标点边界。
  prompt = prompt.replace(/(^|[\s，,；;。:：()（）\[【"'])docs[\/\\][^\s，,；;。:：()（）\[】\]"']*/g, '$1');
  return CODE_FILE_EXT_RE.test(prompt);
}

function hasExecPlanReference(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false;
  return (
    EXEC_PLAN_DOC_RE.test(prompt) ||
    CHANGE_NOTE_DOC_RE.test(prompt) ||
    EXEC_PLAN_EXEMPT_RE.test(prompt)
  );
}

// 验收类委派：引用验收报告输出路径（review/ui/test-report.json）→ 自动豁免执行书
function isAcceptanceDelegation(prompt) {
  if (typeof prompt !== 'string' || prompt === '') return false;
  return ACCEPTANCE_REPORT_RE.test(prompt);
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

    if (!allow) {
      appendLog('PreToolUse', toolName, '(agent)', 'deny', 'no docs/specs|tasks|changes path referenced');
      return deny(AGENT_DENY_REASON);
    }

    // ---- v1.5.0 执行书硬门禁（docs 引用前提下）----
    // 放行条件链：引用执行书（docs/tasks/<slug>-exec.md）/ 变更单（docs/changes/*.md）
    // / 显式豁免标记 exec-plan: exempt → 放行；验收类委派（引用 review/ui/test-report
    // 输出路径，v1.5.1）→ 自动豁免放行（置于编码判定之前）；否则编码类 → deny
    // （编码委派必须附执行书）；非编码类 → 维持现状放行。
    let execPlanOk = false;
    try {
      execPlanOk = hasExecPlanReference(promptText);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to scan agent prompt: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan prompt: ' + (e && e.message));
      return 0;
    }
    if (execPlanOk) {
      appendLog('PreToolUse', toolName, '(agent)', 'allow', 'exec-plan reference or exempt marker');
      return 0;
    }

    let acceptance = false;
    try {
      acceptance = isAcceptanceDelegation(promptText);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to scan agent prompt: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan prompt: ' + (e && e.message));
      return 0;
    }
    if (acceptance) {
      appendLog('PreToolUse', toolName, '(agent)', 'allow', 'acceptance delegation, exec-plan exempt');
      return 0;
    }

    let coding = false;
    try {
      coding = isCodingDelegation(promptText);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to scan agent prompt: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan prompt: ' + (e && e.message));
      return 0;
    }
    if (coding) {
      appendLog('PreToolUse', toolName, '(agent)', 'deny', 'coding delegation without exec-plan');
      return deny(EXEC_PLAN_DENY_REASON);
    }

    appendLog('PreToolUse', toolName, '(agent)', 'allow', 'non-coding delegation, docs path referenced');
    return 0;
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

  // ---- 变更单解锁（v1.4.0 分级路由）：S/M 快速通道的 approved 变更单同级放行 ----
  let approvedChangeNote = null;
  try {
    approvedChangeNote = findApprovedChangeNote(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to check change notes: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, rawFile, 'error', 'check change notes: ' + (e && e.message));
    return 0;
  }
  if (approvedChangeNote) {
    appendLog('PreToolUse', toolName, rawFile, 'allow', 'approved change note found');
    return 0;
  }

  appendLog('PreToolUse', toolName, rawFile, 'deny', 'no approved spec');
  return deny(DENY_REASON);
}

// 直接运行时执行门禁；被 require（单测）时仅导出纯函数
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write('[dev-sop] internal error: ' + (err && err.stack ? err.stack : err) + '\n');
      appendLog('PreToolUse', '', '', 'error', 'internal error: ' + (err && err.message ? err.message : err));
      process.exit(0);
    }
  );
}

module.exports = {
  hasApprovedSpec,
  hasWireframeApprovedSpec,
  findApprovedChangeNote,
  referencesDocsPath,
  isWhitelisted,
  isCodingDelegation,
  hasExecPlanReference,
  isAcceptanceDelegation,
  EXEC_PLAN_DENY_REASON,
};
