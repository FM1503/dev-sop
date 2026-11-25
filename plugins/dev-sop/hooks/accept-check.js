#!/usr/bin/env node
'use strict';
// accept-check.js — Stop 事件门禁：声明完整性检查 + UI 量化验收 + 代码验收测试报告硬化
// 0) 检测 docs/specs/*.md 中 status: approved 但既未声明 code-files 也未声明 ui-files 的
//    spec → block（code-files: none 视为已声明但无代码产出，跳过 test-report 检查）。
// 1) 检测 docs/specs/*.md 中 wireframe: approved 且声明 ui-files 的 spec，
//    若任一 UI 文件已实现，则强制要求 docs/specs/<slug>.ui-report.json
//    存在、结构完整且全部 error=0，否则 block。
// 2) 检测 docs/specs/*.md 中 status: approved 且声明 code-files 的 spec，
//    若任一代码文件已实现，则强制要求 docs/specs/<slug>.test-report.json
//    存在、结构完整（records 非空、每条 result=pass、summary.failed=0），
//    否则 block。
// 3) 检测 docs/specs/*.md frontmatter 含 review: required 的 spec（exempt/none/缺省
//    均不触发）：若 code-files/ui-files 任一文件已实现且 test-report/ui-report 已合规，
//    则强制要求 docs/specs/<slug>.review-report.json 存在、JSON 合法且 verdict 为
//    pass 或 pass-with-issues（fail/未知取值/缺失/非法 JSON 均 block；
//    pass-with-issues 须主会话已向用户呈报问题清单并经确认定稿，见 SKILL 阶段 4.5）
//    （第五把钥匙）。
// 4) 检测 docs/changes/*.md 变更单（v1.4.0 分级路由）：tier S/M 且 status: approved
//    且 changed-files 任一已实现 → 分级审查链（lint 硬前置 → S 结案 / M review-report 或 accept）；
//    tier M 另要求 docs/changes/<slug>.test-report.json（records≥1 全 pass，accept 不豁免，v1.10.2 恢复）；
//    mtime 最近 5 个变更单全为 tier S 时，放行日志 reason 追加
//    5-consecutive-S-hint、block reason 附合并提醒。

const fs = require('fs');
const os = require('os');
const path = require('path');

function appendLog(event, decision, reason) {
  try {
    const dir = path.join(os.homedir(), '.zcode', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const line =
      new Date().toISOString() +
      ' | 事件=' + event +
      ' | tool=' +
      ' | target=' +
      ' | decision=' + decision +
      ' | reason=' + String(reason || '').replace(/[\r\n|]/g, ' ') +
      '\n';
    fs.appendFileSync(path.join(dir, 'dev-sop.log'), line, 'utf8');
  } catch (e) {
    // Logging must never affect the hook.
  }
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

// ---- v1.11.0 账本软门禁（规格 docs/specs/context-ledger.md 2.4）----
const CTX_TOUCH_PREFIX = 'dev-sop-ctx-touch-';
const CTX_NAG_PREFIX = 'dev-sop-ctx-nag-';

function ctxFileFor(prefix, sessionId) {
  return path.join(
    os.homedir(),
    '.zcode',
    'hooks',
    prefix + String(sessionId).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 128)
  );
}

function extractSessionIdLoose(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.session_id === 'string' && payload.session_id.trim() !== '') return payload.session_id.trim();
  if (typeof payload.sessionId === 'string' && payload.sessionId.trim() !== '') return payload.sessionId.trim();
  return null;
}

// 纯函数判定：'block' | 'pass'。账本存在且本会话有代码写入 touch 且 ACTIVE.md 不新于
// touch（含 ACTIVE.md 缺失）→ block；无账本/无 session/已拦过一次（nag）→ pass。
function decideLedgerNag({ ledgerExists, sessionId, touchMs, activeMs, nagExists }) {
  if (!ledgerExists || !sessionId || nagExists) return 'pass';
  if (typeof touchMs !== 'number') return 'pass';
  const active = typeof activeMs === 'number' ? activeMs : -Infinity;
  return touchMs > active ? 'block' : 'pass';
}

function mtimeMsSafe(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    return null;
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

// 与 gate.js 相同的 10 行容错 frontmatter 解析，返回 frontmatter 文本或 null
function readFrontmatter(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
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
  if (start === -1) return null;
  let end = -1;
  for (let i = start + 1; i < head.length; i++) {
    if (/^---\s*$/.test(head[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return head.slice(start + 1, end).join('\n');
}

function frontmatterField(fm, key) {
  const m = fm.match(new RegExp('^' + key + '\\s*:\\s*(.+?)\\s*$', 'mi'));
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, '');
}

// 找出所有 wireframe: approved 且含 ui-files 的 spec
function findUiSpecs(projectRoot) {
  return findSpecsWithFiles(projectRoot, 'wireframe', 'ui-files');
}

// 通用：找出 marker 已 approved 且含 filesField 的 spec；noneAsEmpty=true 时，
// 字段值恰为 none（不区分大小写）视为已声明但无文件产出，跳过该 spec
function findSpecsWithFiles(projectRoot, marker, filesField, noneAsEmpty) {
  const specsDir = path.join(projectRoot, 'docs', 'specs');
  if (!existsSyncSafe(specsDir)) return [];
  let entries;
  try {
    const stat = fs.statSync(specsDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const specs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    const fm = readFrontmatter(path.join(specsDir, entry.name));
    if (!fm) continue;
    if (!new RegExp("^" + marker + "\\s*:\\s*[\"']?approved[\"']?$", 'mi').test(fm)) continue;
    const filesRaw = fm.match(new RegExp('^' + filesField + '\\s*:\\s*(.+)$', 'mi'));
    if (!filesRaw) continue;
    const slugField = frontmatterField(fm, 'slug');
    const slug = slugField || entry.name.replace(/\.md$/i, '');
    const files = filesRaw[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (noneAsEmpty && files.length === 1 && files[0].toLowerCase() === 'none') continue;
    if (files.length === 0) continue;
    specs.push({ slug, files });
  }
  return specs;
}

// 找出所有 status: approved 且含 code-files 的 spec（code-files: none 视为无代码产出，跳过）
function findCodeSpecs(projectRoot) {
  return findSpecsWithFiles(projectRoot, 'status', 'code-files', true);
}

// 找出所有 status: approved 但既未声明 code-files 也未声明 ui-files 的 spec（声明缺失）
function findUndeclaredSpecs(projectRoot) {
  const specsDir = path.join(projectRoot, 'docs', 'specs');
  if (!existsSyncSafe(specsDir)) return [];
  let entries;
  try {
    const stat = fs.statSync(specsDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const specs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    const fm = readFrontmatter(path.join(specsDir, entry.name));
    if (!fm) continue;
    if (!new RegExp("^status\\s*:\\s*[\"']?approved[\"']?$", 'mi').test(fm)) continue;
    const hasCodeFiles = new RegExp('^code-files\\s*:', 'mi').test(fm);
    const hasUiFiles = new RegExp('^ui-files\\s*:', 'mi').test(fm);
    if (hasCodeFiles || hasUiFiles) continue;
    const slugField = frontmatterField(fm, 'slug');
    const slug = slugField || entry.name.replace(/\.md$/i, '');
    specs.push({ slug });
  }
  return specs;
}

function checkReport(reportPath) {
  // 返回 null 表示通过，否则返回中文失败原因
  if (!existsSyncSafe(reportPath)) {
    return '缺少量化验收报告 ' + reportPath;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return '量化验收报告不是合法 JSON：' + reportPath;
  }
  if (!report || typeof report !== 'object' || !report.summary || typeof report.summary !== 'object' || typeof report.summary.errors !== 'number') {
    return '量化验收报告缺少 summary.errors 字段：' + reportPath;
  }
  if (report.summary.errors > 0) {
    return '量化验收报告仍有 ' + report.summary.errors + ' 个未清零 error：' + reportPath;
  }
  if (Array.isArray(report.reports)) {
    for (let i = 0; i < report.reports.length; i++) {
      const r = report.reports[i];
      if (r && r.summary && typeof r.summary.errors === 'number' && r.summary.errors > 0) {
        return '量化验收报告第 ' + (i + 1) + ' 份（多视口/多文件）仍有 ' + r.summary.errors + ' 个 error：' + reportPath;
      }
    }
  }
  return null;
}

// 校验 test-report.json，返回 null 表示通过，否则返回中文失败原因
function checkTestReport(reportPath) {
  if (!existsSyncSafe(reportPath)) {
    return '缺少验收测试报告 ' + reportPath;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return '验收测试报告不是合法 JSON：' + reportPath;
  }
  if (!report || typeof report !== 'object' || !Array.isArray(report.records)) {
    return '验收测试报告缺少 records 数组：' + reportPath;
  }
  if (report.records.length === 0) {
    return '验收测试报告 records 为空：' + reportPath;
  }
  if (!report.summary || typeof report.summary !== 'object' ||
      typeof report.summary.passed !== 'number' || typeof report.summary.failed !== 'number') {
    return '验收测试报告缺少 summary.passed/failed 字段：' + reportPath;
  }
  for (let i = 0; i < report.records.length; i++) {
    const r = report.records[i];
    if (!r || typeof r !== 'object' || !r.item || !r.command || r.result !== 'pass') {
      return '验收测试报告第 ' + (i + 1) + ' 条记录不完整或未通过（需 item/command/durationMs 且 result=pass）：' + reportPath;
    }
  }
  if (report.summary.failed !== 0) {
    return '验收测试报告 summary.failed=' + report.summary.failed + '（必须为 0）：' + reportPath;
  }
  return null;
}

// 解析 frontmatter 逗号分隔文件列表（去成对引号与空白，过滤空串）
function parseFileList(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

// 找出 frontmatter 含 review: required 的 spec（review: exempt/none/缺省均不触发）。
// noneAsEmpty 语义同 findSpecsWithFiles：code-files 值恰为 none（不区分大小写）视为
// 已声明但无代码产出，过滤为空。返回 { slug, codeFiles, uiFiles, files }（files 为并集）。
function findReviewSpecs(projectRoot) {
  const specsDir = path.join(projectRoot, 'docs', 'specs');
  if (!existsSyncSafe(specsDir)) return [];
  let entries;
  try {
    const stat = fs.statSync(specsDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(specsDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const specs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    const fm = readFrontmatter(path.join(specsDir, entry.name));
    if (!fm) continue;
    if (!new RegExp('^review\\s*:\\s*["\']?required["\']?\\s*$', 'mi').test(fm)) continue;
    const slugField = frontmatterField(fm, 'slug');
    const slug = slugField || entry.name.replace(/\.md$/i, '');
    const codeFiles = parseFileList((fm.match(/^code-files\s*:\s*(.+)$/mi) || [])[1])
      .filter((f) => f.toLowerCase() !== 'none');
    const uiFiles = parseFileList((fm.match(/^ui-files\s*:\s*(.+)$/mi) || [])[1]);
    specs.push({ slug, codeFiles, uiFiles, files: codeFiles.concat(uiFiles) });
  }
  return specs;
}

// ---- 变更单判定纯函数（v1.4.0 分级路由，规格 docs/specs/tier-routing.md 2.5）----

// 扫描 docs/changes/*.md，解析 frontmatter 的 tier/changed-files/status/slug，
// 返回 [{ file, slug, tier, status, changedFiles, mtimeMs }]（tier/status 归一大写/小写）。
function findChangeNotes(projectRoot) {
  const changesDir = path.join(projectRoot, 'docs', 'changes');
  if (!existsSyncSafe(changesDir)) return [];
  let entries;
  try {
    const stat = fs.statSync(changesDir);
    if (!stat.isDirectory()) return [];
    entries = fs.readdirSync(changesDir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const notes = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== '.md') continue;
    if (/-accept\.md$/i.test(entry.name)) continue; // v1.10.3：验收标记不是变更单（与 review-lint scanDocEntries 同规则）
    const file = path.join(changesDir, entry.name);
    const fm = readFrontmatter(file);
    if (!fm) continue;
    const slugField = frontmatterField(fm, 'slug');
    const slug = slugField || entry.name.replace(/\.md$/i, '');
    const tier = String(frontmatterField(fm, 'tier') || '').trim().toUpperCase();
    const status = String(frontmatterField(fm, 'status') || '').trim().toLowerCase();
    const changedFiles = parseFileList((fm.match(/^changed-files\s*:\s*(.+)$/mi) || [])[1]);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch (e) {
      // unreadable mtime: 保留 0，不阻断扫描
    }
    notes.push({ file, slug, tier, status, changedFiles, mtimeMs });
  }
  return notes;
}

// 单个变更单的验收要求校验：tier S/M 且 status approved 且 changed-files 任一已实现 →
// 要求 docs/changes/<slug>.review-report.json 存在且 verdict∈{pass,pass-with-issues}；
// tier M 另要求 docs/changes/<slug>.test-report.json（records≥1 全 pass）。
// 返回 null 表示通过或不适用（tier L / draft / 未实现）。
function checkChangeNote(note, projectRoot) {
  if (!note || typeof note !== 'object') return null;
  if (note.tier !== 'S' && note.tier !== 'M') return null; // L 走 docs/specs 全量流程
  if (note.status !== 'approved') return null;
  const files = Array.isArray(note.changedFiles) ? note.changedFiles : [];
  const existing = files.filter((f) => existsSyncSafe(path.resolve(projectRoot, f)));
  if (existing.length === 0) return null; // 改动未实现，不拦
  const changesDir = path.join(projectRoot, 'docs', 'changes');
  const failure = checkReviewReport(path.join(changesDir, note.slug + '.review-report.json'));
  if (failure) return failure;
  if (note.tier === 'M') {
    return checkTestReport(path.join(changesDir, note.slug + '.test-report.json'));
  }
  return null; // S 免 test-report（测试结果记入 review 报告 summary.checked）
}

// mtime 最近 5 个变更单全为 tier: S → true（连续 S 提醒，防 S 级滥用）
function isFiveConsecutiveS(notes) {
  const list = (Array.isArray(notes) ? notes : [])
    .slice()
    .sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))
    .slice(0, 5);
  if (list.length < 5) return false;
  return list.every((n) => n && typeof n === 'object' && n.tier === 'S');
}

// ---- Reviewer 判定规则纯函数（规格 docs/specs/code-review.md 2.1）----

// 按 issues 判定 verdict：任一 P0 → fail；P1 ≥ 3 → fail；
// 仅 P2 或 P1 ≤ 2 → pass-with-issues；全清（无任何问题）→ pass。
// severity 大小写不敏感；null/非对象条目忽略；issues 非数组视为无问题。
function computeVerdictFromIssues(issues) {
  const list = Array.isArray(issues) ? issues : [];
  let p0 = 0;
  let p1 = 0;
  let p2 = 0;
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const sev = String(it.severity || '').trim().toUpperCase();
    if (sev === 'P0') p0++;
    else if (sev === 'P1') p1++;
    else if (sev === 'P2') p2++;
  }
  if (p0 > 0) return 'fail';
  if (p1 >= 3) return 'fail';
  if (p0 + p1 + p2 > 0) return 'pass-with-issues';
  return 'pass';
}

// 报告对象 → 生效 verdict：缺 verdict 字段、非字符串取值、未知取值或非法输入
// （null/非对象/数组）一律按 'fail' 处理（第五把钥匙据此阻断）。
function effectiveReportVerdict(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'fail';
  if (typeof report.verdict !== 'string') return 'fail';
  const v = report.verdict.trim();
  if (v === 'pass' || v === 'pass-with-issues' || v === 'fail') return v;
  return 'fail';
}

// 校验 <slug>.review-report.json，返回 null 表示通过，否则返回中文失败原因。
// 放行：verdict 为 pass 或 pass-with-issues（pass-with-issues 需主会话已向用户
// 呈报问题清单并经用户确认定稿，见 SKILL 阶段 4.5）；
// 阻断：verdict 为 fail、未知取值/缺 verdict 字段、报告缺失或非法 JSON。
function checkReviewReport(reportPath) {
  if (!existsSyncSafe(reportPath)) {
    return '缺少代码审查报告 ' + reportPath;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return '代码审查报告不是合法 JSON：' + reportPath;
  }
  const verdict = effectiveReportVerdict(report);
  if (verdict !== 'pass' && verdict !== 'pass-with-issues') {
    const raw =
      report && typeof report === 'object' && !Array.isArray(report) && typeof report.verdict === 'string'
        ? report.verdict
        : '缺失';
    return '代码审查报告 verdict=' + raw + '（必须为 pass 或 pass-with-issues，pass-with-issues 需用户确认定稿）：' + reportPath;
  }
  return null;
}

// 连续 S 提醒后缀（v1.4.0 分级路由防滥用）：main() 扫描变更单后按需设置；
// 有 block 时附于 reason，放行时日志 reason 追加 5-consecutive-S-hint。
let consecutiveSSuffix = '';

// ---- v1.10.0 分级审查链纯函数（规格 docs/specs/review-speedup.md 2.A/2.C）----
//
// REVIEW_CHAIN_REASONS 为放行日志的四态之一（lite-reviewed-by-lint / fast-review /
// full-review / user-accepted）。lint 为硬前置（所有级别、accept 标记不可豁免）。

const REVIEW_CHAIN_REASONS = ['lite-reviewed-by-lint', 'fast-review', 'full-review', 'user-accepted'];

// 日志 reason 归一：仅四态原样返回，其余（含 block）返回空串
function reviewChainReason(reason) {
  return REVIEW_CHAIN_REASONS.indexOf(reason) === -1 ? '' : reason;
}

// 校验 lint-report（v1.10.2 新结构 {producedBy,slug,generatedAt,violations,warnings}）：返回
//   { missing, clean, violations, stale?, invalid? }
// violations 取当前报告数组长度；旧聚合结构（{reports:[...],summary}）、缺 generatedAt、
// producedBy 缺失或不为 'review-lint'（v1.10.3 来源戳）一律视为格式过期 → stale（需重跑 lint）。
function isLintReportCurrent(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  if (Array.isArray(report.reports)) return false; // v1.10.1 及更早的聚合结构
  if (!Array.isArray(report.violations)) return false;
  if (typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) return false;
  if (report.producedBy !== 'review-lint') return false; // v1.10.3 来源戳：手写报告无法证明机器生成
  return true;
}

function checkLintReport(reportPath) {
  if (!reportPath || !existsSyncSafe(reportPath)) {
    return { missing: true, clean: false, violations: 0 };
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch (e) {
    return { missing: false, clean: false, violations: 0, invalid: true };
  }
  if (!isLintReportCurrent(report)) {
    return { missing: false, clean: false, violations: 0, stale: true };
  }
  const n = report.violations.length;
  return { missing: false, clean: n === 0, violations: n };
}

// 解析 accept 标记 frontmatter：accepted: true + slug 一致 + quoted 非空 → { ok, quoted }。
// 任一缺失/不符 → { ok:false, reason }（无效标记不得作为结案路径）。
function parseAcceptMarker(md, slug) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || '').replace(/^\uFEFF/, ''));
  if (!m) return { ok: false, reason: '缺少 frontmatter' };
  const field = (key) => {
    const hit = m[1].match(new RegExp('^' + key + '\\s*:\\s*(.+?)\\s*$', 'mi'));
    return hit ? hit[1].replace(/^["']|["']$/g, '').trim() : null;
  };
  const accepted = field('accepted');
  const mSlug = field('slug');
  const date = field('date');
  const quoted = field('quoted');
  if (!accepted || accepted.toLowerCase() !== 'true') return { ok: false, reason: 'accepted 不为 true' };
  if (mSlug && slug && mSlug !== slug) return { ok: false, reason: 'slug 不一致' };
  if (!quoted) return { ok: false, reason: 'quoted 为空（须摘录用户验收原话）' };
  // P2：date 缺失/格式非法视为标记无效并提示（不 block；调用方据此回退 review-report 路径）
  let warning = '';
  if (!date) {
    warning = 'accept 标记缺少 date 字段（应为 YYYY-MM-DD）';
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) {
    warning = 'accept 标记 date 非法（' + date + '，应为合法 YYYY-MM-DD）';
  }
  return { ok: true, quoted, date: date || null, warning };
}

// 查找 <slug>-accept.md（docs/specs 或 docs/changes 任一）：返回 { ok, path, quoted, reason }
function findAcceptMarker(projectRoot, slug) {
  const candidates = [
    path.join(projectRoot, 'docs', 'specs', slug + '-accept.md'),
    path.join(projectRoot, 'docs', 'changes', slug + '-accept.md'),
  ];
  const reasons = [];
  for (const p of candidates) {
    if (!existsSyncSafe(p)) continue;
    let md;
    try {
      md = fs.readFileSync(p, 'utf8');
    } catch (e) {
      continue;
    }
    const parsed = parseAcceptMarker(md, slug);
    if (parsed.ok) {
      return { ok: true, path: p, quoted: parsed.quoted, date: parsed.date || null, warning: parsed.warning || '' };
    }
    reasons.push(path.basename(p) + ' 无效：' + parsed.reason);
  }
  return { ok: false, present: reasons.length > 0, reason: reasons.join('；') };
}

// 分级审查链判定（纯函数，便于单测与 e2e）：
//   input = { slug, kind: 'spec'|'change', tier, implemented, lintReportPath, lintClean,
//             lintViolations, lintStale, testReportFailure,
//             reviewReportPath, reviewVerdict, acceptMarker:{ok,quoted,date,warning} }
// 返回 { allow, reason }：allow 时 reason ∈ 四态；block 时 reason 为中文说明。
//   ① lint 硬前置：报告缺失 / 非法 / 旧结构（lintStale）/ violations>0 → block（accept 不可豁免）
//   ② M 级变更单 test-report 未通过（testReportFailure 非空）→ block（accept 不可豁免）
//   ③ change + tier S → 放行 lite-reviewed-by-lint（免 AI 审）
//   ④ change + tier M / spec → review-report verdict∈{pass,pass-with-issues}（fast/full-review）
//      或有效 accept 标记（user-accepted）；都缺 → block（说明两条路径）
function assessReviewRequirement(input) {
  const x = input || {};
  const slug = x.slug || '<slug>';
  const kind = x.kind === 'change' ? 'change' : 'spec';
  const tier = String(x.tier || '').toUpperCase();
  const dirHint = kind === 'change' ? 'docs/changes/' : 'docs/specs/';
  const reportPath = x.lintReportPath || dirHint + slug + '.lint-report.json';

  // ① lint 硬前置
  if (!x.lintReportPath) {
    return {
      allow: false,
      reason:
        'lint 机器项未清零：缺少 lint 报告 ' + reportPath +
        '（先修机器项：运行 node scripts/review-lint.mjs <变更单/spec> --out ' + reportPath + '，violations 必须为 0）',
      lintState: 'blocked',
    };
  }
  if (!x.lintClean) {
    const n = typeof x.lintViolations === 'number' ? x.lintViolations : 0;
    if (x.lintStale) {
      return {
        allow: false,
        reason:
          'lint 报告格式过期或不可信（旧聚合结构 / 缺 generatedAt / 缺 review-lint 来源戳）：' + reportPath + ' 需重跑 lint——' +
          '运行 node scripts/review-lint.mjs <变更单/spec> --out ' + reportPath +
          '（v1.10.2 起覆盖写 {producedBy,slug,generatedAt,violations,warnings}；v1.10.3 起另写入 producedBy:"review-lint" 来源戳；lint 为硬门禁，accept 标记与人工审查均不可豁免）',
        lintState: 'blocked',
      };
    }
    return {
      allow: false,
      reason:
        'lint 机器项未清零：' + reportPath + ' 仍有 ' + n + ' 个 violation（先修机器项后重跑 review-lint --out；' +
        'lint 为硬门禁，accept 标记与人工审查均不可豁免）',
      lintState: 'blocked',
    };
  }

  // 证据链：M 级变更单另须 docs/changes/<slug>.test-report.json（records≥1 全 pass、failed=0；
  // S 级免，测试结果记入 review 报告）。缺失/不合规 → block，accept 标记亦不豁免。
  if (x.testReportFailure !== undefined && x.testReportFailure !== null) {
    return {
      allow: false,
      reason:
        'tier M 变更单验收测试报告未通过：' + String(x.testReportFailure) +
        '（必须产出 docs/' + (kind === 'change' ? 'changes/' : 'specs/') + slug +
        '.test-report.json：records≥1 全 pass、summary.failed=0；S 级免此项）',
      lintState: 'clean',
      blockKind: 'test-report',
    };
  }

  // ② S 级：lint 干净即结案
  if (kind === 'change' && tier === 'S') {
    return { allow: true, reason: 'lite-reviewed-by-lint' };
  }

  // ③ M 级变更单 / spec（L）：review-report 或 accept 标记二者其一
  if (x.reviewReportPath && (x.reviewVerdict === 'pass' || x.reviewVerdict === 'pass-with-issues')) {
    return { allow: true, reason: kind === 'change' ? 'fast-review' : 'full-review' };
  }
  if (x.acceptMarker && x.acceptMarker.ok) {
    return { allow: true, reason: 'user-accepted' };
  }
  const target = kind === 'change' ? 'docs/changes/' + slug : 'docs/specs/' + slug;
  return {
    allow: false,
    reason:
      (kind === 'change' ? '变更单 ' : 'spec ') + 'docs/' + (kind === 'change' ? 'changes/' : 'specs/') + slug +
      '.md lint 已干净，但两条结案路径均未满足：' +
      '①审查报告 ' + target + '.review-report.json 不存在或 verdict 非 pass/pass-with-issues（' +
      (kind === 'change' ? '委派 reviewer 快审' : '委派 reviewer 全审') + '）；' +
      '②用户验收标记 ' + target + '-accept.md 不存在或无效（frontmatter accepted: true + slug + date + quoted 非空）。' +
      '二者满足其一即可交付。',
    lintState: 'clean',
    blockKind: 'review-or-accept',
  };
}

// v1.10.3：block 文案的两段式装配——lint 段与路径段按真实状态拼接，不再做字符串匹配分流：
//   lintState='clean'（lint 已干净、只缺 review/accept 路径）→ 不出现任何 lint 指引；
//   lintState='blocked'（lint 缺失/过期/违规）→ 先给 lint 计数与"重跑 review-lint"，再列仍需满足的路径项。
// 返回 { text, lintPart, pathPart }；lintPart 第一句即标注是否含 lint 段（供日志与断言）。
function composeBlockMessage(verdict, slug, kind) {
  const v = verdict || {};
  const isChange = kind === 'change';
  const dir = isChange ? 'docs/changes/' : 'docs/specs/';
  const target = dir + slug;
  const lintState = v.lintState === 'clean' ? 'clean' : (v.blockKind === 'test-report' ? 'clean' : 'blocked');
  const blockKind = v.blockKind || (lintState === 'blocked' ? 'lint' : 'review-or-accept');

  let lintPart = '';
  if (lintState === 'blocked') {
    const raw = String(v.reason || '');
    // 违规计数来自 reason 明面（violations>0 或 stale 分支的 0 计数）
    const n = typeof v.lintViolations === 'number' && v.lintViolations > 0
      ? v.lintViolations
      : (function () {
          const m = /仍有\s*(\d+)\s*个/.exec(raw);
          return m && Number(m[1]) > 0 ? Number(m[1]) : 0;
        })();
    const cause = /格式过期/.test(raw)
      ? 'lint 报告格式过期或不可信（旧聚合结构 / 缺 generatedAt / 缺 review-lint 来源戳），需先重跑 review-lint 覆盖'
      : (n > 0 ? 'lint 仍有 ' + n + ' 个违规，需先清零（' + raw + '）' : raw);
    lintPart =
      cause + '\n重跑：node scripts/review-lint.mjs ' + target + '.md --out ' + target + '.lint-report.json' +
      '（lint 为硬门禁，须把上面机器项清零后重跑 review-lint --out）。';
  }

  let pathPart = '';
  if (blockKind === 'test-report') {
    pathPart =
      '验收测试报告未通过，需先产出合规 docs/changes/' + slug + '.test-report.json' +
      '（records≥1 全 pass、summary.failed=0；M 级硬要求，accept 标记不豁免）。' + String(v.reason || '');
  } else if (blockKind === 'review-or-accept' || lintState === 'blocked') {
    pathPart =
      '需满足：①审查报告 ' + target + '.review-report.json 不存在或 verdict 非 pass/pass-with-issues 时，' +
      (isChange ? '按 SKILL 阶段 4.5 委派 reviewer 快审，报告写入 ' : '按 SKILL 阶段 4.5 委派 reviewer 全审，报告写入 ') +
      target + '.review-report.json 且 verdict 为 pass 或 pass-with-issues（后者须先向用户呈报问题清单并经确认）；' +
      '或②用户已明确验收通过，写验收标记 ' + target + '-accept.md' +
      '（frontmatter accepted: true / slug / date / quoted 用户原话）。二者满足其一即可交付。';
  }

  const text = [lintPart, pathPart].filter(Boolean).join('\n');
  return { text, lintPart, pathPart, lintState, blockKind, hasLintPart: lintPart !== '' };
}

// 单条 review: required 目标的链判定（读真实报告/标记后调用纯函数）
function assessSpecReview(projectRoot, spec) {
  const slug = spec.slug;
  let lintReportPath = null;
  for (const sub of ['specs', 'changes']) {
    const p = path.join(projectRoot, 'docs', sub, slug + '.lint-report.json');
    if (existsSyncSafe(p)) {
      lintReportPath = p;
      break;
    }
  }
  const lint = checkLintReport(lintReportPath);
  const reviewPath = path.join(projectRoot, 'docs', 'specs', slug + '.review-report.json');
  let reviewVerdict = null;
  if (existsSyncSafe(reviewPath)) {
    try {
      reviewVerdict = effectiveReportVerdict(JSON.parse(fs.readFileSync(reviewPath, 'utf8')));
    } catch (e) {
      reviewVerdict = 'fail';
    }
  }
  return assessReviewRequirement({
    slug,
    kind: 'spec',
    tier: '',
    implemented: true,
    lintReportPath,
    lintClean: lint.clean,
    lintViolations: lint.violations,
    lintStale: !!lint.stale,
    reviewReportPath: existsSyncSafe(reviewPath) ? reviewPath : null,
    reviewVerdict,
    acceptMarker: findAcceptMarker(projectRoot, slug),
  });
}

// 单条变更单的链判定：返回 { allow, reason, chain }（chain 为四态之一供日志）
function assessChangeReview(projectRoot, note) {
  const slug = note.slug;
  let lintReportPath = null;
  for (const sub of ['changes', 'specs']) {
    const p = path.join(projectRoot, 'docs', sub, slug + '.lint-report.json');
    if (existsSyncSafe(p)) {
      lintReportPath = p;
      break;
    }
  }
  const lint = checkLintReport(lintReportPath);
  const reviewPath = path.join(projectRoot, 'docs', 'changes', slug + '.review-report.json');
  let reviewVerdict = null;
  if (existsSyncSafe(reviewPath)) {
    try {
      reviewVerdict = effectiveReportVerdict(JSON.parse(fs.readFileSync(reviewPath, 'utf8')));
    } catch (e) {
      reviewVerdict = 'fail';
    }
  }
  const marker = findAcceptMarker(projectRoot, slug);
  const out = assessReviewRequirement({
    slug,
    kind: 'change',
    tier: note.tier,
    implemented: true,
    lintReportPath,
    lintClean: lint.clean,
    lintViolations: lint.violations,
    lintStale: !!lint.stale,
    // v1.10.2 恢复 M 级 test-report 硬校验（S 级仍免）：accept 标记不可豁免
    testReportFailure:
      String(note.tier || '').toUpperCase() === 'M'
        ? checkTestReport(path.join(projectRoot, 'docs', 'changes', slug + '.test-report.json'))
        : null,
    reviewReportPath: existsSyncSafe(reviewPath) ? reviewPath : null,
    reviewVerdict,
    acceptMarker: marker,
  });
  out.chain = reviewChainReason(out.reason);
  if (out.chain === 'user-accepted' && marker.ok && marker.warning) {
    process.stderr.write('[dev-sop] warning: ' + marker.warning + '（' + path.basename(marker.path) + '）\n');
    out.warning = marker.warning;
  }
  return out;
}

// 日志中已记录的结案路径（main 逐条放行时收集；多 slug 以逗号拼接；'multi' 表示尚无记录）
let reviewChainLog = 'multi';

function block(reason) {
  const finalReason = consecutiveSSuffix ? reason + consecutiveSSuffix : reason;
  process.stdout.write(JSON.stringify({ decision: 'block', reason: finalReason }) + '\n');
  appendLog('Stop', 'block', finalReason);
  return 0;
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
  // v1.11.0：stdin 仅取 session（账本软门禁）；读取/解析失败 → null，不影响既有判定
  let stdinSessionId = null;
  try {
    const rawStdin = await readStdin();
    if (rawStdin && rawStdin.trim()) {
      stdinSessionId = extractSessionIdLoose(JSON.parse(rawStdin));
    }
  } catch (e) {
    // ignore
  }

  let projectRoot;
  try {
    projectRoot = findProjectRoot(path.join(process.cwd(), '__dev_sop_probe__'));
  } catch (e) {
    process.stderr.write('[dev-sop] failed to resolve project root: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'project root: ' + (e && e.message));
    return 0;
  }

  if (hasSkipMarker(projectRoot)) {
    appendLog('Stop', 'allow', 'skip file present');
    return 0;
  }

  // ---- 变更单扫描 + 连续 S 提醒后缀（v1.4.0 分级路由）----
  let changeNotes;
  try {
    changeNotes = findChangeNotes(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to scan change notes: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'scan change notes: ' + (e && e.message));
    return 0;
  }
  if (isFiveConsecutiveS(changeNotes)) {
    consecutiveSSuffix = '提醒：连续 5 个 S 级变更，建议评估是否合并为 M/L。';
  }

  // ---- 声明缺失检查（现有 ui/code 检查之前）----
  let undeclaredSpecs;
  try {
    undeclaredSpecs = findUndeclaredSpecs(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to scan specs: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'scan undeclared specs: ' + (e && e.message));
    return 0;
  }

  for (const spec of undeclaredSpecs) {
    return block(
      '规格 docs/specs/' + spec.slug + '.md 已批准但未声明产出文件（code-files/ui-files）。' +
      '请在 frontmatter 补充 code-files: <逗号分隔目标代码文件>（纯文档/调研任务显式写 code-files: none），' +
      '并按任务书测试计划表执行验收、产出 docs/specs/' + spec.slug + '.test-report.json。'
    );
  }

  let specs;
  try {
    specs = findUiSpecs(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to scan specs: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'scan specs: ' + (e && e.message));
    return 0;
  }

  for (const spec of specs) {
    const existing = spec.files.filter((f) => existsSyncSafe(path.resolve(projectRoot, f)));
    if (existing.length === 0) continue; // 还没实现，不拦
    const reportPath = path.join(projectRoot, 'docs', 'specs', spec.slug + '.ui-report.json');
    const failure = checkReport(reportPath);
    if (failure) {
      return block(
        'spec "' + spec.slug + '" 检测到 UI 文件已实现但量化验收未通过（' + failure + '）。' +
        '必须：用内置浏览器在至少两个视口（默认宽度+一个非默认宽度）执行 hooks/ui-collect.js 采集几何 JSON，' +
        '逐个运行 node hooks/ui-analyzer.mjs <json> --out docs/specs/' + spec.slug + '.ui-report.json' +
        '（LVGL 项目改用 lvgl-check.mjs），修复全部 error 后方可交付。'
      );
    }
  }

  // ---- 代码验收检查（test-report.json）----
  let codeSpecs;
  try {
    codeSpecs = findCodeSpecs(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to scan specs: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'scan specs: ' + (e && e.message));
    return 0;
  }

  for (const spec of codeSpecs) {
    const existing = spec.files.filter((f) => existsSyncSafe(path.resolve(projectRoot, f)));
    if (existing.length === 0) continue; // 代码未实现，不拦
    const reportPath = path.join(projectRoot, 'docs', 'specs', spec.slug + '.test-report.json');
    const failure = checkTestReport(reportPath);
    if (failure) {
      return block(
        'spec "' + spec.slug + '" 检测到代码文件已实现但验收测试报告未通过（' + failure + '）。' +
        '必须：按任务书的验收测试计划表逐条执行测试（遵守 references/testing-rules.md 纪律：' +
        '单命令≤2分钟显式 timeout、fail-fast、禁止后台/监听模式），' +
        '并把每条记录（验收标准 item、命令 command、耗时 durationMs、结果 result）' +
        '写入 docs/specs/' + spec.slug + '.test-report.json，结构为 ' +
        '{records:[{item,command,durationMs,result}], summary:{passed,failed}}，' +
        'records 非空、每条 result=pass 且 summary.failed=0。'
      );
    }
  }

  // ---- 代码审查检查（review: required 的 spec，第五把钥匙）----
  let reviewSpecs;
  try {
    reviewSpecs = findReviewSpecs(projectRoot);
  } catch (e) {
    process.stderr.write('[dev-sop] failed to scan specs: ' + (e && e.message) + '\n');
    appendLog('Stop', 'error', 'scan review specs: ' + (e && e.message));
    return 0;
  }

  for (const spec of reviewSpecs) {
    const existingCode = spec.codeFiles.filter((f) => existsSyncSafe(path.resolve(projectRoot, f)));
    const existingUi = spec.uiFiles.filter((f) => existsSyncSafe(path.resolve(projectRoot, f)));
    if (existingCode.length === 0 && existingUi.length === 0) continue; // 尚未实现，不因 review 阻断
    // 前置：test-report/ui-report 未合规时由前面的 ui/code 检查负责拦截，不在 review 维度重复报
    if (existingCode.length > 0 &&
        checkTestReport(path.join(projectRoot, 'docs', 'specs', spec.slug + '.test-report.json')) !== null) continue;
    if (existingUi.length > 0 &&
        checkReport(path.join(projectRoot, 'docs', 'specs', spec.slug + '.ui-report.json')) !== null) continue;
    // v1.10.0 分级链（规格 review-speedup 2.A/2.C）：lint 硬前置 → 审查报告或用户验收标记
    const verdict = assessSpecReview(projectRoot, spec);
    if (!verdict.allow) {
      // v1.10.3：文案按 lint 真实状态装配（lint 干净时不再出现任何 lint 指引）
      const msg = composeBlockMessage(verdict, spec.slug, 'spec');
      return block(
        'spec "' + spec.slug + '" 已声明 review: required 且量化验收已通过，但分级审查链未通过。必须：\n' + msg.text +
        '纯文档/微小任务可在 spec frontmatter 显式声明 review: exempt 豁免。'
      );
    }
    if (verdict.reason) {
      reviewChainLog = reviewChainLog === 'multi' ? verdict.reason + '@' + spec.slug : reviewChainLog + ',' + verdict.reason + '@' + spec.slug;
    }
  }

  // ---- 变更单验收检查（v1.10.0 分级审查链：lint 硬前置 → S 结案 / M review-report 或 accept）----
  for (const note of changeNotes) {
    if (note.tier !== 'S' && note.tier !== 'M') continue; // L 走 docs/specs 全量流程
    if (note.status !== 'approved') continue;
    const files = Array.isArray(note.changedFiles) ? note.changedFiles : [];
    if (!files.some((f) => existsSyncSafe(path.resolve(projectRoot, f)))) continue; // 改动未实现，不拦
    let verdict;
    try {
      verdict = assessChangeReview(projectRoot, note);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to check change note: ' + (e && e.message) + '\n');
      appendLog('Stop', 'error', 'check change note: ' + (e && e.message));
      return 0;
    }
    if (!verdict.allow) {
      // v1.10.3：文案按 lint 真实状态装配（lint 干净时不再出现任何 lint 指引）
      const msg = composeBlockMessage(verdict, note.slug, 'change');
      return block(
        '变更单 docs/changes/' + note.slug + '.md（tier ' + note.tier + '）检测到改动文件已实现但分级审查链未通过。必须：\n' + msg.text
      );
    }
    if (verdict.chain) {
      reviewChainLog = reviewChainLog === 'multi' ? verdict.chain + '@' + note.slug : reviewChainLog + ',' + verdict.chain + '@' + note.slug;
    }
  }

  // ---- v1.11.0 账本软门禁：本会话改过代码但 ACTIVE.md 未跟上 → 只拦一次（nag 闩锁）----
  try {
    const ledgerDir = path.join(projectRoot, 'docs', 'context');
    if (existsSyncSafe(ledgerDir) && stdinSessionId) {
      const nagFile = ctxFileFor(CTX_NAG_PREFIX, stdinSessionId);
      const decision = decideLedgerNag({
        ledgerExists: true,
        sessionId: stdinSessionId,
        touchMs: mtimeMsSafe(ctxFileFor(CTX_TOUCH_PREFIX, stdinSessionId)),
        activeMs: mtimeMsSafe(path.join(ledgerDir, 'ACTIVE.md')),
        nagExists: existsSyncSafe(nagFile),
      });
      if (decision === 'block') {
        try {
          fs.mkdirSync(path.dirname(nagFile), { recursive: true });
          fs.writeFileSync(nagFile, new Date().toISOString() + '\n', 'utf8');
        } catch (e) {
          // fail-open：nag 未写 → 下次 Stop 可能再拦一次，不阻断判定
        }
        return block(
          '上下文账本未落盘：本会话改过代码但 docs/context/ACTIVE.md 未更新（mtime 早于最近一次代码写入）。' +
          '请更新 ACTIVE.md（当前阶段/下一步/定稿项；定稿则清除对应节并把结论压入 DECISIONS.md）后再次结束。' +
          '（软门禁已触发一次，本会话不会重复拦截）'
        );
      }
    }
  } catch (e) {
    // fail-open：账本门禁任何异常不阻断
  }

  appendLog(
    'Stop',
    'allow',
    (reviewChainLog && reviewChainLog !== 'multi' ? reviewChainLog + '@review-chain' : 'ui/code/review acceptance ok or nothing implemented') +
      (consecutiveSSuffix ? ' + 5-consecutive-S-hint' : '')
  );
  return 0;
}

// 直接运行时执行门禁；被 require（单测）时仅导出纯函数与检查器
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write('[dev-sop] internal error: ' + (err && err.stack ? err.stack : err) + '\n');
      appendLog('Stop', 'error', 'internal error: ' + (err && err.message ? err.message : err));
      process.exit(0);
    }
  );
}

module.exports = {
  CTX_TOUCH_PREFIX,
  CTX_NAG_PREFIX,
  ctxFileFor,
  decideLedgerNag,
  extractSessionIdLoose,
  computeVerdictFromIssues,
  effectiveReportVerdict,
  checkReviewReport,
  findReviewSpecs,
  findChangeNotes,
  checkChangeNote,
  isFiveConsecutiveS,
  // v1.10.0 分级审查链（规格 docs/specs/review-speedup.md 2.A/2.C）
  REVIEW_CHAIN_REASONS,
  reviewChainReason,
  checkLintReport,
  parseAcceptMarker,
  findAcceptMarker,
  assessReviewRequirement,
  assessSpecReview,
  assessChangeReview,
  // v1.10.3：block 文案两段式装配（lint 段 / 路径段按真实状态拼接）
  composeBlockMessage,
};
