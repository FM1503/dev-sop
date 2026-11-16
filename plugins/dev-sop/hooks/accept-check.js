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
//    且 changed-files 任一已实现 → 强制要求 docs/changes/<slug>.review-report.json
//    verdict 为 pass 或 pass-with-issues；tier M 另要求 docs/changes/<slug>.test-report.json
//    （records≥1 全 pass）；mtime 最近 5 个变更单全为 tier S 时，放行日志 reason 追加
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
  // stdin 内容不影响判定，读失败也继续
  try {
    await readStdin();
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
    const reportPath = path.join(projectRoot, 'docs', 'specs', spec.slug + '.review-report.json');
    const failure = checkReviewReport(reportPath);
    if (failure) {
      return block(
        'spec "' + spec.slug + '" 已声明 review: required 且量化验收已通过，但独立代码审查未通过（' + failure + '）。' +
        '必须：按 SKILL 阶段 4.5 委派 reviewer 子代理（插件内置，独立上下文、只读）对照任务书做四维审查，' +
        '报告写入 docs/specs/' + spec.slug + '.review-report.json 且 verdict 为 pass 或 pass-with-issues' +
        '（后者须先向用户呈报问题清单并经确认）后方可交付；' +
        '纯文档/微小任务可在 spec frontmatter 显式声明 review: exempt 豁免。'
      );
    }
  }

  // ---- 变更单验收检查（S/M 快速通道，docs/changes/，v1.4.0 分级路由）----
  for (const note of changeNotes) {
    let failure;
    try {
      failure = checkChangeNote(note, projectRoot);
    } catch (e) {
      process.stderr.write('[dev-sop] failed to check change note: ' + (e && e.message) + '\n');
      appendLog('Stop', 'error', 'check change note: ' + (e && e.message));
      return 0;
    }
    if (failure) {
      return block(
        '变更单 docs/changes/' + note.slug + '.md（tier ' + note.tier + '）检测到改动文件已实现但快速通道验收未通过（' + failure + '）。' +
        '必须：委派 reviewer 快审并把报告写入 docs/changes/' + note.slug + '.review-report.json' +
        '（verdict 为 pass 或 pass-with-issues）' +
        (note.tier === 'M'
          ? '，并产出 docs/changes/' + note.slug + '.test-report.json（records≥1 全 pass、summary.failed=0）'
          : '（S 级免 test-report，测试结果记入审查报告 summary.checked）') +
        '后方可交付。'
      );
    }
  }

  appendLog(
    'Stop',
    'allow',
    'ui/code/review acceptance ok or nothing implemented' +
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
  computeVerdictFromIssues,
  effectiveReportVerdict,
  checkReviewReport,
  findReviewSpecs,
  findChangeNotes,
  checkChangeNote,
  isFiveConsecutiveS,
};
