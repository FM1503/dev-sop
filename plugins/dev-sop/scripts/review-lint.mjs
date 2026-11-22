#!/usr/bin/env node
'use strict';
// review-lint.mjs — dev-sop v1.8.0 机器预检（纯 Node 零依赖，规格 3）
//
// CLI:
//   node review-lint.mjs <变更单.md|spec.md> [--diff-cmd "git diff"] [--out <lint-report.json>] [--repo <仓库根>] [--project-scan]
//
// 四类检查（命中即 violation；warnings 不阻断）：
//   1. fileset：diff 触及文件集 ⊆ changed-files（解析 `<diff-cmd> --name-only`）
//   2. linecap：净变更行数（+/- 行，不含表头）≤ tier 上限（S:30 / M:120 / L:不查）
//   3. verify  ："## 验证" 字段须含断言特征（assert/expect/exit/&&）；缺 timeout → warning
//   4. placeholder：变更表"新内容"含 TODO/FIXME/XXX → violation
//
// v1.10.0（规格 docs/specs/review-speedup.md 2.A）新增三条机器规则（项目根 = 当前工作目录）：
//   5. exec-missing：docs/specs|changes 中 frontmatter 含 review: required 的条目（或 tier S/M 变更单）
//      既无 docs/tasks/<slug>-exec.md 也无 docs/changes/<slug>.md → violation
//   6. test-cmd-empty：docs/specs|changes/<slug>.test-report.json 存在但 records 中任一 command
//      为空串/缺失 → violation
//   7. lint-stale：docs/specs|changes/<slug>.lint-report.json 的生成时间（报告内 generatedAt，
//      无该字段时回退文件 mtime）早于该条目任一 code-files/ui-files/changed-files 文件 mtime
//      → warning（报告过期需重跑；不阻断，因为本规则判在写盘之前，升格 violation 会使重跑自身
//      必然 exit 1 形成自参照——重跑一次写入新报告即清零）
//   v1.10.1：三规则按目标 slug 作用域；exec-missing 视 test-report 为等价执行证据；新增 --repo（自动向上探测）与 --project-scan（跨 slug 汇总写独立报告）。
//   v1.10.2：--out 改为整体覆盖写 {target,slug,generatedAt,violations,warnings}（不再聚合追加）；
//            规则按目标分域——无 changed-files（spec）只跑 exec-missing/test-cmd-empty/lint-stale，
//            有 changed-files（变更单）另跑 fileset/linecap/verify/placeholder；项目规则扫描异常降级为 warning。
//   v1.10.3：lint-stale 以报告内 generatedAt 为准（消除"代码改动后首次重跑仍报 stale"的自参照，一次重跑即清零），
//            并降为 warning（判在写盘之前，升格 violation 会自锁）；docs/specs 与 docs/changes 均不存在
//            → warning scan-degraded（不再静默 fail-open）；报告新增来源戳 producedBy:"review-lint"
//            （accept-check 校验，缺失视为可疑需重跑）。
//
// 输出：{violations:[{rule,detail}], warnings:[{rule,detail}]}，有 violation exit 1 否则 0。
// 注意：本文件同目录的 review-lint.test.js 使用本脚本作夹具；改动输出结构需同步测试。
// --out：整体覆盖写入本次结果（旧内容不保留），payload =
//        { producedBy:'review-lint', target, slug, generatedAt, violations, warnings }；stdout 只输出本次 {violations,warnings}。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TIER_CAP = { S: 30, M: 120 }; // L / 未知 → 不查

function parseFrontmatter(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const fields = {};
  if (!m) return fields;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return fields;
}

function sectionBody(md, title) {
  const lines = md.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp('^##+\\s+' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n');
}

// P1-1：逐字符扫描，\| 为字面竖线内容、裸 | 为分隔；解析后还原为 |。
// 终修 P2-1（与 compile-change.mjs 同步）：连续反斜杠段后紧跟 "|" 时整段视为转义竖线
// （"\|"、"\\|"、"\\\\|" 同效，输出字面 "|"）；段后无 "|" 时整段坍缩为单个字面反斜杠。
function splitPipeRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  if (line[0] === '|') i = 1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      let n = 1;
      while (i + n < line.length && line[i + n] === '\\') n++;
      if (line[i + n] === '|') {
        cur += '|';
        i += n; // 循环 ++ 共消耗 n 个反斜杠 + 1 个竖线
      } else {
        cur += '\\';
        i += n - 1; // 循环 ++ 共消耗 n 个反斜杠
      }
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '' || cells.length === 0) cells.push(cur.trim());
  return cells;
}

function parseTable(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  const split = (l) => splitPipeRow(l);
  const header = split(lines[0]);
  if (!/^[\s|:-]+$/.test(lines[1])) return null;
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = split(lines[i]);
    const row = {};
    header.forEach((h, idx) => { row[h] = cells[idx] != null ? cells[idx] : ''; });
    rows.push(row);
  }
  return { header, rows };
}

function pick(row, header, kw) {
  const key = header.find((h) => h.includes(kw));
  return key != null ? row[key] : '';
}

// 归一化路径用于比较（去掉 ./ 前缀、统一分隔符）
function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

// P2-6：解析 `git status --porcelain -uall` 输出，返回触及文件路径列表（含未跟踪 ??、staged、已修改）。
// 配合 core.quotepath=false 使用，路径为 UTF-8 原文，无八进制转义。
// 终修 P2-4：-uall 使未跟踪目录展开为成员文件而非 "?? dir/"；此处并对仍以 / 结尾的
// 目录条目直接跳过兜底（目录非文件，无法参与 changed-files 集合比较，避免假阳性）。
function parsePorcelain(out) {
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 格式：XY<space><path>；重命名/复制为 "R  old -> new"，取 new。
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.trim().replace(/^"|"$/g, '');
    if (p.endsWith('/')) continue; // 终修 P2-4：目录条目跳过
    if (p) files.push(p);
  }
  return files;
}

// v1.10.2：按目标分域——未声明 changed-files 视为 spec（只有 code-files/ui-files），
// 仅跑 exec-missing/test-cmd-empty/lint-stale；fileset/linecap/verify/placeholder 只对变更单生效。
// 返回 { hasField, hasFiles }：hasFiles 为 changed-files 是否列了实际文件（空值 = spec 文档示例）。
function changedFilesInfo(md) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(md || '').replace(/^\uFEFF/, ''));
  if (!m) return { hasField: false, hasFiles: false };
  const line = /^changed-files\s*:\s*(\S.*)$/m.exec(m[1]);
  if (!line) return { hasField: false, hasFiles: false };
  const hasFiles = line[1].trim().replace(/^\[|]$/g, '').replace(/[,\s]/g, '') !== '';
  return { hasField: true, hasFiles };
}

// v1.10.3 修复：改为 hasFiles 语义——原 \S 判定会把空值 `changed-files:` 也当变更单，
// 令 spec 文档里的字段示例被误判（且 fileset 对全部 diff 文件报违规）。
function hasChangedFilesField(md) {
  return changedFilesInfo(md).hasFiles;
}

function lint(mdPath, diffCmd, isDefaultCmd, repoRoot) {
  const violations = [];
  const warnings = [];
  const root = repoRoot || process.cwd();
  const mdAbs = path.isAbsolute(mdPath) ? mdPath : path.resolve(root, mdPath);
  const md = fs.readFileSync(mdAbs, 'utf-8');
  const fm = parseFrontmatter(md);
  const isSpec = !changedFilesInfo(md).hasFiles;
  const tier = (fm.tier || 'S').toUpperCase();
  const changedFiles = (fm['changed-files'] || '').split(',').map((s) => normPath(s)).filter(Boolean);

  const changedSet = new Set(changedFiles);

  if (isSpec) {
    // spec 输入：fileset/linecap/verify/placeholder 不适用（无 changed-files、exec 文档章节名为"执行顺序与验证"），
    // 跳过 diff 与四类文档规则，消除 L 级 lint 自锁；项目级三规则仍由 main 执行（按 slug 作用域）。
    return { violations, warnings, domain: 'spec' };
  }

  // ---- 跑 diff：name-only（文件集）+ 全文（行数）----
  let nameOut = null;
  let diffOut = null;
  let diffFailed = false;
  const runDiff = (args) => {
    const r = spawnSync(diffCmd + ' ' + args, { shell: true, encoding: 'utf-8', cwd: root });
    if (r.error || r.status !== 0) return null;
    return r.stdout || '';
  };
  nameOut = runDiff('--name-only');
  diffOut = runDiff('');
  if (nameOut === null || diffOut === null) {
    diffFailed = true;
    warnings.push({ rule: 'diff-failed', detail: 'diff 命令执行失败，跳过 fileset/linecap 检查' });
  }

  // P2-6：默认（git diff HEAD）形态下补充 git status --porcelain，消除对未跟踪/staged 新建文件的盲区。
  // 显式传入 --diff-cmd 时不附加（由调用方完全掌控 diff 来源，保持可注入假 diff 的测试性）。
  // 终修 P2-4：加 -uall，未跟踪目录展开为成员文件（避免 "?? dir/" 目录条目造成 fileset 假阳性）。
  let extraTouched = [];
  if (!diffFailed && isDefaultCmd) {
    const st = spawnSync('git -c core.quotepath=false status --porcelain -uall', { shell: true, encoding: 'utf-8', cwd: root });
    if (!st.error && st.status === 0) extraTouched = parsePorcelain(st.stdout || '');
  }

  // ---- 1. fileset ----
  if (!diffFailed && nameOut != null) {
    const touched = nameOut.split(/\r?\n/).map(normPath).filter(Boolean);
    for (const t of extraTouched.map(normPath)) {
      if (t && touched.indexOf(t) === -1) touched.push(t);
    }
    for (const t of touched) {
      if (!changedSet.has(t)) {
        violations.push({ rule: 'fileset', detail: 'diff 触及文件未声明在 changed-files: ' + t });
      }
    }
  }

  // ---- 2. linecap ----
  if (!diffFailed && diffOut != null) {
    let churn = 0;
    for (const line of diffOut.split(/\r?\n/)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+') || line.startsWith('-')) churn++;
    }
    const cap = TIER_CAP[tier];
    if (cap != null && churn > cap) {
      violations.push({
        rule: 'linecap',
        detail: '净变更行数 ' + churn + ' 超过 ' + tier + ' 级上限 ' + cap,
      });
    }
  }

  // ---- 3. verify 字段 ----
  const verify = sectionBody(md, '验证');
  if (verify == null || verify.trim() === '') {
    violations.push({ rule: 'verify', detail: '变更单缺少 "## 验证" 字段' });
  } else {
    const v = verify.toLowerCase();
    const hasAssert =
      v.includes('assert') || v.includes('expect') || v.includes('exit') ||
      verify.includes('&&') || v.includes('timeout');
    if (!hasAssert) {
      violations.push({ rule: 'verify', detail: '"## 验证" 缺少断言特征（assert/expect/exit/&&）' });
    }
    // P2-8：移除 ms\b（误匹配 params/items/needs）。终修 P2-8：再删死分支
    // (timeout[=:]?\s*\d+)\s*ms——能匹配它的串必先命中前导备选 timeout，属冗余；仅保留有效模式。
    const hasTimeout = /timeout|秒|时限/.test(verify.toLowerCase());
    if (!hasTimeout) {
      warnings.push({ rule: 'verify-timeout', detail: '"## 验证" 未提示 timeout（仅警告）' });
    }
  }

  // ---- 4. placeholder ----
  const tbl = parseTable(sectionBody(md, '变更表'));
  if (tbl) {
    const PLACEHOLDER = /TODO|FIXME|XXX/;
    for (const row of tbl.rows) {
      const file = pick(row, tbl.header, '文件');
      const newCell = pick(row, tbl.header, '新内容');
      const m = PLACEHOLDER.exec(newCell);
      if (m) {
        violations.push({
          rule: 'placeholder',
          detail: '新内容含占位符 ' + m[0] + '（文件 ' + file + '）',
        });
      }
    }
  }

  return { violations, warnings, domain: 'change' };
}

// ---- v1.10.0 项目级机器规则（exec-missing / test-cmd-empty / lint-stale）----

function mtimeOf(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    return null;
  }
}

// v1.10.3：lint-report 的"生成时刻"。优先读报告内 generatedAt（ISO 字符串）；
// 报告缺失该字段 / 非法 JSON / 时间非法时回退文件 mtime（兼容手写或旧报告）。
function lintReportBornAt(reportPath) {
  try {
    const j = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    if (j && typeof j === 'object' && typeof j.generatedAt === 'string') {
      const t = Date.parse(j.generatedAt);
      if (!Number.isNaN(t)) return t;
    }
  } catch (e) {
    // 非法 JSON → 回退 mtime（accept-check 另行判定）
  }
  return mtimeOf(reportPath);
}

// v1.10.3：lint-stale 的实际判定（与目标 slug 无关）——对"声明了文件"的条目，
// 若已有 <slug>.lint-report.json 且其生成时刻早于该条目任一声明文件 mtime → 警告提示重跑。
//
// 为什么不升格为 violation：规则判定发生在 writeReport 之前，若判 violation 则本次重跑自身
// 必然承袭旧报告的过期结论（exit 1），需要第二次重跑才清零——这是审查轮指出的 P2 自参照。
// 改为 warning 后一次重跑即清零（新报告 generatedAt = 本次运行时刻，晚于所有更早的代码改动）；
// 而"报告是在代码之后再改"的场景由 accept-check 侧另有门禁（lint 报告结构/来源戳校验）。
function lintStaleFor(entry, root) {
  let reportPath = null;
  for (const sub of ['specs', 'changes']) {
    const p = path.join(root, 'docs', sub, entry.slug + '.lint-report.json');
    if (fs.existsSync(p)) {
      reportPath = p;
      break;
    }
  }
  if (!reportPath) return null;
  // 优先用报告内 generatedAt（生成时刻）而非文件 mtime——否则本次重跑会与盘上旧报告比较。
  const born = lintReportBornAt(reportPath);
  if (born == null) return null;
  let newest = null;
  let newestFile = null;
  for (const f of entry.files) {
    const m = mtimeOf(path.resolve(root, f));
    if (m != null && (newest == null || m > newest)) {
      newest = m;
      newestFile = f;
    }
  }
  if (newest != null && born < newest) {
    const secs = ((newest - born) / 1000).toFixed(1);
    return {
      rule: 'lint-stale',
      detail:
        'lint-report ' + normPath(path.relative(root, reportPath)) + ' 生成时间（generatedAt ' + new Date(born).toISOString() +
        '）早于声明文件 ' + normPath(newestFile) + ' 的修改时间（' + new Date(newest).toISOString() + '，晚 ' + secs + 's），报告过期需重跑',
    };
  }
  return null;
}

// 扫描 docs 子目录中的条目 frontmatter：返回 [{ slug, review, tier, files }]
// 参数 warnings（可选）：目录不存在/不可读时追加一条 scan-degraded warning（v1.10.3 不再静默 fail-open）。
function scanDocEntries(root, sub, warnings) {
  const dir = path.join(root, 'docs', sub);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (warnings) {
      warnings.push({
        rule: 'scan-degraded',
        detail: 'docs/' + sub + ' 不存在或不可读（' + (e && e.code ? e.code : String(e && e.message ? e.message : e)) + '），该目录扫描降级为 0 条目——请核对 cwd 或用 --repo 指向正确仓库根',
      });
    }
    return [];
  }
  const entries = [];
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    if (/-accept\.md$/i.test(name)) continue; // 验收标记不是待审条目
    let md;
    try {
      md = fs.readFileSync(path.join(dir, name), 'utf-8');
    } catch (e) {
      continue;
    }
    const fm = parseFrontmatter(md);
    if (!fm.slug && name.startsWith('.')) continue;
    const slug = fm.slug || name.replace(/\.md$/i, '');
    const files = []
      .concat((fm['code-files'] || '').split(','), (fm['ui-files'] || '').split(','), (fm['changed-files'] || '').split(','))
      .map(normPath)
      .filter((f) => f && f.toLowerCase() !== 'none');
    entries.push({
      slug,
      review: (fm.review || '').trim().toLowerCase().replace(/^["']|["']$/g, ''),
      tier: (fm.tier || '').trim().toUpperCase().replace(/^["']|["']$/g, ''),
      files,
    });
  }
  return entries;
}

// v1.10.1：按 slug 作用域 + 证据等价（exec 文档 / 变更单 / test-report 任一存在即有执行证据）
function ruleExecMissing(root, slug, warnings) {
  const violations = [];
  const all = scanDocEntries(root, 'specs', warnings).concat(scanDocEntries(root, 'changes', warnings));
  const entries = slug ? all.filter((e) => e.slug === slug) : all;
  for (const e of entries) {
    const needsExec = e.review === 'required' || e.tier === 'S' || e.tier === 'M';
    if (!needsExec) continue;
    const hasExec = fs.existsSync(path.join(root, 'docs', 'tasks', e.slug + '-exec.md'));
    const hasChange = fs.existsSync(path.join(root, 'docs', 'changes', e.slug + '.md'));
    const hasTestReport = ['specs', 'changes'].some((sub) =>
      fs.existsSync(path.join(root, 'docs', sub, e.slug + '.test-report.json'))
    );
    if (!hasExec && !hasChange && !hasTestReport) {
      violations.push({
        rule: 'exec-missing',
        detail:
          '条目 ' + e.slug + ' 无任何执行证据（docs/tasks/' + e.slug + '-exec.md、docs/changes/' + e.slug + '.md、' + e.slug + '.test-report.json 均不存在）',
      });
    }
  }
  return violations;
}

function ruleTestCmdEmpty(root, slug) {
  const violations = [];
  const seen = new Set();
  for (const sub of ['specs', 'changes']) {
    const dir = path.join(root, 'docs', sub);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const name of names) {
      if (!/\.test-report\.json$/i.test(name)) continue;
      if (slug && name.toLowerCase() !== (String(slug).toLowerCase() + '.test-report.json')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      let report;
      try {
        report = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
      } catch (e) {
        continue; // 非法 JSON 由 accept-check 判定，此处不重复
      }
      const records = report && Array.isArray(report.records) ? report.records : [];
      for (let i = 0; i < records.length; i++) {
        const r = records[i];
        const cmd = r && typeof r === 'object' ? r.command : null;
        if (typeof cmd !== 'string' || cmd.trim() === '') {
          violations.push({
            rule: 'test-cmd-empty',
            detail: 'test-report ' + sub + '/' + name + ' 第 ' + (i + 1) + ' 条记录 command 为空或缺失',
          });
        }
      }
    }
  }
  return violations;
}

function ruleLintStale(root, slug, warnings) {
  const violations = [];
  const seen = new Set();
  const all = scanDocEntries(root, 'specs', warnings).concat(scanDocEntries(root, 'changes', warnings));
  for (const e of all) {
    if (seen.has(e.slug)) continue;
    seen.add(e.slug);
    // 作用域：有 slug 时只查目标（与 exec-missing/test-cmd-empty 一致）
    if (slug && e.slug !== slug) continue;
    const v = lintStaleFor(e, root);
    if (v) warnings.push({ rule: 'lint-stale', detail: v.detail + '（不阻断：本次重跑写入新报告即清零；accept-check 侧仍以 lint 报告结构/来源戳为硬门禁）' });
  }
  return violations;
}

// 项目级三规则：扫描异常不误阻断，但不再静默——降级为 warning（rule:'scan-degraded'）
function projectRules(root, slug) {
  const violations = [];
  const warnings = [];
  const names = ['exec-missing', 'test-cmd-empty', 'lint-stale'];
  for (let i = 0; i < names.length; i++) {
    try {
      violations.push(...[ruleExecMissing, ruleTestCmdEmpty, ruleLintStale][i](root, slug, warnings));
    } catch (e) {
      warnings.push({
        rule: 'scan-degraded',
        detail: '规则 ' + names[i] + ' 扫描异常跳过（扫描目录 docs/specs 与 docs/changes）：' + (e && e.message ? e.message : String(e)),
      });
    }
  }
  // scan-degraded 去重（lint-stale 会连带再扫一遍 specs/changes，避免重复告警；detail 含错误码故同因同文）
  const seenWarn = new Set();
  const deduped = warnings.filter((w) => {
    const k = w.rule + '|' + w.detail;
    if (seenWarn.has(k)) return false;
    seenWarn.add(k);
    return true;
  });
  return { violations, warnings: deduped };
}

// v1.10.2 --out 覆盖写盘：整体替换为
//   { target, slug, generatedAt, violations:[], warnings:[] }
// 不读旧文件、不追加（旧聚合结构 {reports,summary} 被直接覆盖；accept-check 对旧结构判"需重跑"）。
function writeReport(outPath, payload) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  let diffCmd = 'git -c core.quotepath=false diff HEAD'; // P2-6：含 staged + 处理非 ASCII 路径
  let isDefaultCmd = true;
  let out = null;
  let file = null;
  let repoOpt = null;
  let projectScan = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff-cmd') { diffCmd = argv[i + 1]; isDefaultCmd = false; i++; }
    else if (argv[i] === '--out') { out = argv[i + 1] || null; i++; }
    else if (argv[i] === '--repo') { repoOpt = argv[i + 1] || null; i++; }
    else if (argv[i] === '--project-scan') { projectScan = true; }
    else if (!file) file = argv[i];
  }
  if (!file && !projectScan) {
    process.stderr.write('用法: node review-lint.mjs <变更单.md> [--diff-cmd "git diff"] [--out <lint-report.json>] [--repo <git仓库路径>] [--project-scan]\n');
    process.exitCode = 2;
    return;
  }
  const root = repoOpt ? path.resolve(repoOpt)
    : (findRepoRoot(path.dirname(path.resolve(file || process.cwd()))) || process.cwd());
  let slug = null;
  if (file) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.isAbsolute(file) ? file : path.resolve(root, file), 'utf-8'));
      slug = fm.slug || path.basename(file, '.md');
    } catch (e) {
      slug = path.basename(String(file), '.md');
    }
  }
  let result;
  try {
    result = file ? lint(file, diffCmd, isDefaultCmd, root) : { violations: [], warnings: [{ rule: 'project-scan', detail: '仅项目级扫描' }], domain: 'project' };
    const pr = projectRules(root, projectScan ? null : slug);
    result.violations.push(...pr.violations);
    result.warnings.push(...pr.warnings);
  } catch (e) {
    process.stderr.write('[review-lint] 失败: ' + e.message + '\n');
    process.exitCode = 1;
    return;
  }
  if (out) {
    try {
      // v1.10.2 覆盖语义：本报告即本次运行结果全量（violations 只反映当前文档+当前项目快照）
      const payload = {
        producedBy: 'review-lint', // v1.10.3 来源戳：accept-check 校验，缺失/错误视为可疑报告
        target: file ? normPath(path.relative(root, path.isAbsolute(file) ? file : path.resolve(root, file))) : 'project-scan',
        slug: projectScan ? (slug || '_project-scan') : slug,
        generatedAt: new Date().toISOString(),
        violations: result.violations,
        warnings: result.warnings,
      };
      if (projectScan) payload.scope = 'project-scan';
      writeReport(path.isAbsolute(out) ? out : path.resolve(root, out), payload);
    } catch (e) {
      process.stderr.write('[review-lint] 写入 --out lint-report 失败 ' + out + '：' + e.message + '\n');
      process.exitCode = 1;
      return;
    }
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.violations.length > 0 ? 1 : 0;
}

main();
