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

// 修复轮2（fail-closed）：Bash 写入痕迹（含 opaque）过门禁链被拒时的拒绝原因
const BASH_WRITE_DENY_REASON =
  '检测到疑似文件写入的命令，已按文件门禁校验；' +
  '合法写入需已批准的变更单/spec，或调整命令避免歧义。' +
  '涉及 UI 文件的写入需 wireframe: approved（见 Write/Edit 门禁）';

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

// ---- v1.8.0 prospector 只读勘探放行（规格 2.E，双条件防伪装）----
// getSubagentType：从 tool_input.subagent_type（或 tool.input.subagent_type）取委派代理类型名。
// isProspectorDelegation：双条件同时满足才判定——①类型名含 'prospector'；②prompt 首行
//（trim 后）精确等于 'PROSPECTOR-READONLY'。只满足其一（仅类型名伪装/仅标记无类型）均不放行，
// 回退常规委派判定链。只读勘探代理无写入风险，放行后由 gate 记日志 reason=prospector-readonly。
function getSubagentType(payload) {
  const inputs = [];
  if (payload && typeof payload.tool_input === 'object' && payload.tool_input) {
    inputs.push(payload.tool_input);
  }
  if (payload && payload.tool && typeof payload.tool === 'object' && payload.tool.input) {
    inputs.push(payload.tool.input);
  }
  for (const input of inputs) {
    if (typeof input.subagent_type === 'string' && input.subagent_type !== '') return input.subagent_type;
  }
  return '';
}

function isProspectorDelegation(payload) {
  const sub = getSubagentType(payload);
  if (!sub.includes('prospector')) return false;
  const firstLine = String(getAgentPrompt(payload) || '')
    .trim()
    .split(/\r?\n/, 1)[0]
    .trim();
  return firstLine === 'PROSPECTOR-READONLY';
}

// ---- v1.7.0 Bash 写模式检测（补丁直改配套，堵 echo>src/a.js / sed -i / tee / git apply 绕过洞）----
// parseBashWriteTargets：解析命令中的显式文件写入模式，返回目标路径数组（去重保序）。
// 目标无法确定（$(...) 替换、heredoc 喂程序、patch 读 stdin 等）时返回 'opaque' 标记项；
// 修复轮2（fail-closed）：main() 的 Bash 分支对非空目标集（含 opaque、含任何未能确证
// 为安全的写入痕迹）执行完整门禁链，放行仅当门禁通过，日志记 bash-write-gated
//（取代 bash-write-opaque 放行语义，opaque 标记保留供日志细节）。
const BASH_WRITE_OPAQUE = 'opaque';

// 引号感知分词（修复轮2：统一 splitCommands 同款扫描器）：' " ` 包裹的 token 记
// quoted（内容去引号）；反斜杠转义保形——双引号/反引号内 \" \` 与引号外 \X（含 \'）
// 均保留两字符原文（Windows 路径兼容，切分层不解释内容）。
function tokenizeBashSegment(seg) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let quote = null;
  let started = false;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      if (c === '\\' && quote !== "'" && i + 1 < seg.length) {
        cur += c + seg[i + 1]; // "/` 内反斜杠转义保形
        i++;
        continue;
      }
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) {
      cur += c + seg[i + 1]; // 引号外反斜杠转义保形（\; \| \> 不构成特殊字符）
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      quoted = true;
      started = true;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (started) tokens.push({ text: cur, quoted: quoted });
      cur = '';
      quoted = false;
      started = false;
      continue;
    }
    cur += c;
    started = true;
  }
  if (started) tokens.push({ text: cur, quoted: quoted });
  return tokens;
}

function pushUnique(arr, value) {
  if (arr.indexOf(value) === -1) arr.push(value);
}

// 修复轮 P2：Windows NUL 空设备（nul / ./nul，大小写归一）豁免同 /dev/null（> NUL / >> NUL）
function normalizeDevNull(p) {
  const norm = String(p).replace(/\\/g, '/').toLowerCase();
  return norm === '/dev/null' || norm === 'nul' || norm === './nul' ? '/dev/null' : p;
}

// 目标 token 分类：kind='target'（确定路径）/ 'opaque'（目标无法确定）/ 'ignore'（>&1 等 fd 复制）；
// 引号目标扫描与 splitCommands 同款（修复轮2：双引号/反引号内反斜杠转义保形）
function readPathTokenAt(seg, pos) {
  let i = pos;
  while (i < seg.length && (seg[i] === ' ' || seg[i] === '\t')) i++;
  if (i >= seg.length) return { value: '', kind: 'opaque' };
  if (seg[i] === "'" || seg[i] === '"') {
    const q = seg[i];
    let j = i + 1;
    while (j < seg.length) {
      if (seg[j] === '\\' && q !== "'" && j + 1 < seg.length) {
        j += 2; // 双引号内反斜杠转义保形（不误认 \" 为闭引号）
        continue;
      }
      if (seg[j] === q) break;
      j += 1;
    }
    if (j >= seg.length) return { value: '', kind: 'opaque' };
    const inner = seg.slice(i + 1, j);
    if (/\$\(|`/.test(inner)) return { value: '', kind: 'opaque' };
    return { value: inner, kind: 'target' };
  }
  let j = i;
  while (j < seg.length && ' \t&|;()<>'.indexOf(seg[j]) === -1) {
    j++;
  }
  const raw = seg.slice(i, j);
  if (raw === '') return { value: '', kind: 'opaque' };
  if (/\$\(|`/.test(raw) || raw[0] === '$') return { value: '', kind: 'opaque' };
  if (/^[&(]/.test(raw)) return { value: '', kind: 'ignore' };
  return { value: raw, kind: 'target' };
}

// 单段重定向扫描（修复轮2：引号态统一 splitCommands 同款扫描器——' " ` 引号 +
// 反斜杠转义，仅引号外字符参与重定向判定）：>> / > / 1> / &> 记写入目标；2> 忽略
// （stderr）；>&N fd 复制（>&2 / 2>&1）忽略，>& 文件名（古式 >&out.log）记 opaque；
// << 记 opaque（heredoc 喂程序，写入目标不可知）；单个 < 的目标仅 patch / git apply 使用。
// 返回引号外最后一个 < 的目标 { value, kind }（无则为 kind='none'）。
function scanSegmentWrites(seg, targets) {
  let input = { value: '', kind: 'none' };
  let quote = null;
  let i = 0;
  while (i < seg.length) {
    const c = seg[i];
    if (quote) {
      if (c === '\\' && quote !== "'" && i + 1 < seg.length) {
        i += 2; // 双引号/反引号内反斜杠转义保形
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '\\' && i + 1 < seg.length) {
      i += 2; // 引号外反斜杠转义下一字符（\> \| 等不构成重定向/分隔符）
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i += 1;
      continue;
    }
    if (c === '<') {
      if (seg[i + 1] === '<') {
        pushUnique(targets, BASH_WRITE_OPAQUE);
        i += 2;
        continue;
      }
      input = readPathTokenAt(seg, i + 1);
      i += 1;
      continue;
    }
    if (c === '>') {
      let fd = '1';
      if (i > 0) {
        const p = seg[i - 1];
        const boundary = i - 2 < 0 || seg[i - 2] === ' ' || seg[i - 2] === '\t';
        if (p === '2' && boundary) fd = '2';
        else if (p === '&' && boundary) fd = '&';
      }
      if (seg[i + 1] === '&') {
        // 修复轮2：>&N fd 复制（>&2 / 2>&1）忽略；>& 文件名（古式 >& out.log）→ opaque
        const t = readPathTokenAt(seg, i + 2);
        if (!(t.kind === 'target' && /^[0-9]$/.test(t.value))) {
          pushUnique(targets, BASH_WRITE_OPAQUE);
        }
        i += 2;
        continue;
      }
      const append = seg[i + 1] === '>';
      const after = i + (append ? 2 : 1);
      const t = readPathTokenAt(seg, after);
      if (fd === '2') {
        // stderr 重定向忽略（2>err / 2>&1 均不视为代码写入目标）
      } else if (t.kind === 'opaque') {
        pushUnique(targets, BASH_WRITE_OPAQUE);
      } else if (t.kind === 'target') {
        pushUnique(targets, normalizeDevNull(t.value));
      }
      i = after;
      continue;
    }
    i += 1;
  }
  return input;
}

// 单段命令级写入（重定向已由 scanSegmentWrites 处理）：tee / sed -i / patch / git apply
function scanCommandWrites(tokens, input, targets) {
  if (tokens.length === 0) return;
  const cmd = tokens[0].text.replace(/^\(+/, ''); // 子壳 ( echo … )
  if (cmd === 'tee') {
    for (const t of tokens.slice(1)) {
      if (t.text.startsWith('-')) continue; // -a / --append 等旗标
      if (/\$\(|`/.test(t.text) || t.text[0] === '$') {
        pushUnique(targets, BASH_WRITE_OPAQUE);
        continue;
      }
      pushUnique(targets, t.text);
    }
    return;
  }
  if (cmd === 'sed') {
    scanSedInPlace(tokens.slice(1), targets);
    return;
  }
  if (cmd === 'patch') {
    scanPatchInput(tokens.slice(1), input, targets);
    return;
  }
  if (cmd === 'git' && tokens.length > 1 && tokens[1].text === 'apply') {
    scanPatchInput(tokens.slice(2), input, targets);
  }
}

// sed -i：有 -i / --in-place 才是写；-e/-f/--expression/--file 连带参数跳过；
// 无 -e/-f 时首个非选项操作数是 sed 脚本，其后为文件；有 -e/-f 时非选项操作数均为文件。
function scanSedInPlace(args, targets) {
  let hasInPlace = false;
  let scriptViaOption = false;
  let i = 0;
  while (i < args.length) {
    const a = args[i].text;
    if (a === '--') {
      i++;
      break;
    }
    if (a === '-i' || a === '--in-place' || /^-i./.test(a) || a.indexOf('--in-place=') === 0) {
      hasInPlace = true;
      i++;
      continue;
    }
    if (a === '-e' || a === '--expression' || a === '-f' || a === '--file' || a === '--regexp-file') {
      scriptViaOption = true;
      i += 2; // 选项 + 其参数（脚本）
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      i++;
      continue;
    }
    break;
  }
  if (!hasInPlace) return;
  const operands = args.slice(i);
  const files = scriptViaOption ? operands : operands.slice(1);
  for (const f of files) {
    if (/\$\(|`/.test(f.text) || f.text[0] === '$') {
      pushUnique(targets, BASH_WRITE_OPAQUE);
      continue;
    }
    pushUnique(targets, f.text);
  }
}

// patch / git apply：<补丁文件>（或 < 重定向喂入）：两者均改写代码文件；
// 读 stdin / heredoc / $(...) 等目标不可知 → opaque
function scanPatchInput(args, input, targets) {
  if (input && input.kind === 'opaque') {
    pushUnique(targets, BASH_WRITE_OPAQUE);
    return;
  }
  if (input && input.kind === 'target') {
    pushUnique(targets, input.value);
    return;
  }
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-') && args[i].text !== '-') {
    const a = args[i].text;
    if (a === '-i' || a === '--input') {
      const nxt = args[i + 1];
      if (nxt) {
        if (/\$\(|`/.test(nxt.text) || nxt.text[0] === '$') pushUnique(targets, BASH_WRITE_OPAQUE);
        else pushUnique(targets, nxt.text);
        return;
      }
    }
    i++;
  }
  const rest = args.slice(i);
  if (rest.length === 0) {
    pushUnique(targets, BASH_WRITE_OPAQUE); // 读 stdin/heredoc：改写目标不可知
    return;
  }
  if (/\$\(|`/.test(rest[0].text) || rest[0].text[0] === '$') {
    pushUnique(targets, BASH_WRITE_OPAQUE);
    return;
  }
  pushUnique(targets, rest[0].text);
}

// 修复轮 P1-1：引号感知命令切分——逐字符扫描，跟踪 '、"、` 引号态与反斜杠转义，
// 仅在引号外切分 &&/||/;/|/换行；未闭合引号时整段视为一条并整体标记 opaque
//（安全侧：目标不可知 → fail-closed 门禁校验，绝不因引号截断漏判写入目标）。
function splitCommands(command) {
  const parts = [];
  let cur = '';
  let quote = null; // 当前引号字符（' " `）或 null
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (quote) {
      if (c === '\\' && quote !== "'" && i + 1 < command.length) {
        cur += c + command[i + 1]; // "/` 内反斜杠转义保形（切分层不解释内容）
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      i += 1;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += c + command[i + 1]; // 引号外反斜杠转义下一字符（\; \| \& 不构成切分点）
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      i += 1;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === '&&' || two === '||' || c === ';' || c === '|' || c === '\n' || c === '\r') {
      if (cur.trim() !== '') parts.push(cur);
      cur = '';
      i += two === '&&' || two === '||' ? 2 : 1;
      continue;
    }
    cur += c;
    i += 1;
  }
  if (cur.trim() !== '') parts.push(cur);
  if (quote !== null) return { parts: [command], opaque: true }; // 未闭合引号：整段一条
  return { parts: parts, opaque: false };
}

// 终修：解释器执行旗标检测（命令位锚定）——解释器名须为段首词（splitCommands 已按
// &&/||/;/|/换行切分，段首即命令位，&&/;/| 之后同此），杜绝 grep -n "node -e"
// docs/readme.md、echo 句中提及 "node -e" 等非命令位字面误报。旗标按解释器类型匹配：
//   bash/sh/zsh/dash：-[a-z]*c（短旗标组合，命中 -c / -cx / -xc / -lfc）；
//   cmd：/c；powershell/pwsh：-Command | --command | -c；python/python3：-c；node：-e。
function interpreterExecFlag(tokens) {
  if (tokens.length === 0) return false;
  const name = tokens[0].text.replace(/^\(+/, '').toLowerCase(); // 子壳 ( bash … )
  const flags = tokens.slice(1);
  if (name === 'bash' || name === 'sh' || name === 'zsh' || name === 'dash') {
    return flags.some((t) => /^-[a-z]*c/.test(t.text));
  }
  if (name === 'cmd') {
    return flags.some((t) => /^\/c$/i.test(t.text));
  }
  if (name === 'powershell' || name === 'pwsh') {
    return flags.some((t) => /^(?:-command|--command|-c)$/i.test(t.text));
  }
  if (name === 'python' || name === 'python3') {
    return flags.some((t) => /^-c$/.test(t.text));
  }
  if (name === 'node') {
    return flags.some((t) => /^-e$/.test(t.text));
  }
  return false;
}

// v1.7.0 纯函数：识别 Bash 命令中的显式文件写入模式，返回目标路径数组（去重保序）。
// 覆盖：重定向 > / >>（2> 忽略、/dev/null 归一保留）、tee（含 -a）、sed -i、
// patch <f / git apply f；多命令（&&、||、;、|、换行分隔）逐一解析；引号路径兼容、
// 反斜杠按字面字符（Windows 兼容）；无法确定目标的写入（$(...)、heredoc 等）返回 'opaque'。
// 修复轮 P1-1：多命令切分改引号感知（splitCommands，未闭合引号→整段 opaque）；
// 终修：解释器执行改命令位锚定（interpreterExecFlag，解释器名须为段首词）——
// bash/sh/zsh/dash 短旗标组合 -[a-z]*c、cmd /c、powershell/pwsh -Command|--command|-c、
// python -c、node -e → opaque（内层不二次解析，fail-closed 下仅影响日志细节）。
function parseBashWriteTargets(command) {
  const targets = [];
  if (typeof command !== 'string' || command === '') return targets;
  const split = splitCommands(command);
  if (split.opaque) {
    pushUnique(targets, BASH_WRITE_OPAQUE); // 修复轮 P1-1：未闭合引号，整段 opaque（安全侧）
    return targets;
  }
  for (const rawSeg of split.parts) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    const tokens = tokenizeBashSegment(seg);
    if (interpreterExecFlag(tokens)) {
      pushUnique(targets, BASH_WRITE_OPAQUE); // 终修：命令位解释器执行（-c/-e//c/-Command）→ opaque
    }
    const input = scanSegmentWrites(seg, targets);
    scanCommandWrites(tokens, input, targets);
  }
  return targets;
}

function getBashCommand(payload) {
  const inputs = [];
  if (payload && typeof payload.tool_input === 'object' && payload.tool_input) {
    inputs.push(payload.tool_input);
  }
  if (payload && typeof payload.tool === 'object' && payload.tool && payload.tool.input) {
    inputs.push(payload.tool.input);
  }
  for (const input of inputs) {
    if (typeof input.command === 'string' && input.command.trim() !== '') return input.command;
  }
  return null;
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

    // ---- v1.8.0 prospector 只读勘探放行（规格 2.E，双条件，置于一切委派门禁之前）----
    // 只读勘探代理不写文件、无写入风险：subagent_type 含 'prospector' 且 prompt 首行
    //（trim）精确等于 'PROSPECTOR-READONLY' → 直接放行并记日志 reason=prospector-readonly。
    // 仅类型名（伪装为 prospector 但无标记）或仅标记（普通 worker 首行写标记）均不放行，
    // 继续走常规 docs/执行书判定链（双条件防伪装）。
    try {
      if (isProspectorDelegation(payload)) {
        appendLog('PreToolUse', toolName, '(agent)', 'allow', 'prospector-readonly');
        return 0;
      }
    } catch (e) {
      // P2-7：fail-closed——prospector 判定解析异常时视为"非 prospector"，
      // 不在此放行（旧实现 return 0 为 fail-open），继续走下方常规委派判定链。
      process.stderr.write('[dev-sop] failed to scan agent subagent_type: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', toolName, '(agent)', 'error', 'scan subagent_type: ' + (e && e.message) + ' (fail-closed)');
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

  // ---- v1.7.0 Bash 写模式检测（修复轮2 fail-closed：写入痕迹一律过门禁链）----
  if (toolName === 'Bash') {
    const command = getBashCommand(payload);
    if (!command) {
      appendLog('PreToolUse', 'Bash', '', 'allow', 'no command');
      return 0;
    }
    let targets = [];
    try {
      targets = parseBashWriteTargets(command);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to parse bash command: ' + (e && e.message) + '\n');
      appendLog('PreToolUse', 'Bash', command.slice(0, 120), 'error', 'parse bash: ' + (e && e.message));
      return 0;
    }
    // 修复轮2（fail-closed）：非空目标集（含 opaque、含任何未能确证为安全的写入痕迹）
    // → 完整门禁链（同 Write/Edit：白名单路径豁免→skip→变更单→approved spec→UI 门禁），
    // 放行仅当门禁通过。显式目标走 gateFileWrite，opaque 走命令级 gateBashWriteCommand，
    // 两者并存（heredoc 混合）逐一校验不短路；纯读/测试命令（无写入痕迹）照旧放行。
    const hasOpaque = targets.indexOf(BASH_WRITE_OPAQUE) !== -1;
    for (const target of targets) {
      if (target === BASH_WRITE_OPAQUE) continue; // opaque 由命令级门禁统一处理
      const normalized = String(target).replace(/\\/g, '/');
      if (normalized === '/dev/null') continue; // >/dev/null 豁免
      if (/\.(md|json)$/i.test(normalized)) continue; // .md/.json 文档豁免
      const rc = gateFileWrite(toolName, target);
      if (rc !== 0) return rc; // 任一目标命中 deny 即输出对应 deny JSON
    }
    if (hasOpaque) {
      const rc = gateBashWriteCommand(toolName, command);
      if (rc !== 0) return rc; // opaque 写入痕迹未过门禁 → deny
    }
    appendLog(
      'PreToolUse',
      'Bash',
      command.slice(0, 120),
      'allow',
      targets.length === 0
        ? 'no explicit bash write target'
        : hasOpaque
          ? 'bash-write-gated:opaque'
          : 'bash-write-gated'
    );
    return 0;
  }

  // ---- Edit / Write / ApplyPatch ----
  const rawFile = pickFilePath(payload);
  if (!rawFile) {
    appendLog('PreToolUse', toolName, '', 'allow', 'no target file');
    return 0;
  }
  return gateFileWrite(toolName, rawFile);
}

// v1.7.0：单文件写入门禁链（Write/Edit 与 Bash 写检测共用，语义与文案完全一致）：
// isWhitelisted → skip 文件 → UI 门禁（wireframe）→ approved spec → approved 变更单 → deny
function gateFileWrite(toolName, rawFile) {
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

// 修复轮2（fail-closed）命令级门禁：opaque 写入痕迹（heredoc / 嵌套解释器 -c/-e /
// $(...) 目标不可知 / >& 文件名等）无法定位具体路径，白名单与 UI 门禁不适用，
// 按 skip → approved 变更单 → approved spec → deny 链校验，放行仅当门禁通过。
function gateBashWriteCommand(toolName, command) {
  let projectRoot;
  try {
    projectRoot = findProjectRoot(path.join(process.cwd(), '__dev_sop_probe__'));
  } catch (e) {
    process.stderr.write('[dev-sop] failed to resolve project root: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'error', 'project root: ' + (e && e.message));
    return 0;
  }

  if (hasSkipMarker(projectRoot)) {
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'allow', 'skip file present');
    return 0;
  }

  // ---- 变更单解锁（v1.4.0 分级路由）：S/M 快速通道的 approved 变更单同级放行 ----
  let approvedChangeNote = null;
  try {
    approvedChangeNote = findApprovedChangeNote(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to check change notes: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'error', 'check change notes: ' + (e && e.message));
    return 0;
  }
  if (approvedChangeNote) {
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'allow', 'approved change note found');
    return 0;
  }

  let approved = false;
  try {
    approved = hasApprovedSpec(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to check specs: ' + (e && e.message) + '\n');
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'error', 'check specs: ' + (e && e.message));
    return 0;
  }
  if (approved) {
    appendLog('PreToolUse', toolName, command.slice(0, 120), 'allow', 'approved spec found');
    return 0;
  }

  appendLog('PreToolUse', toolName, command.slice(0, 120), 'deny', 'bash-write-gated:opaque');
  return deny(BASH_WRITE_DENY_REASON);
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
  isProspectorDelegation,
  EXEC_PLAN_DENY_REASON,
  parseBashWriteTargets,
  BASH_WRITE_OPAQUE,
};
