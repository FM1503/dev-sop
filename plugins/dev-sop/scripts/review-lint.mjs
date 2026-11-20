#!/usr/bin/env node
'use strict';
// review-lint.mjs — dev-sop v1.8.0 机器预检（纯 Node 零依赖，规格 3）
//
// CLI:
//   node review-lint.mjs <变更单.md> [--diff-cmd "git diff"]   默认 diff-cmd = "git diff"
//
// 四类检查（命中即 violation；warnings 不阻断）：
//   1. fileset：diff 触及文件集 ⊆ changed-files（解析 `<diff-cmd> --name-only`）
//   2. linecap：净变更行数（+/- 行，不含表头）≤ tier 上限（S:30 / M:120 / L:不查）
//   3. verify  ："## 验证" 字段须含断言特征（assert/expect/exit/&&）；缺 timeout → warning
//   4. placeholder：变更表"新内容"含 TODO/FIXME/XXX → violation
//
// 输出：{violations:[{rule,detail}], warnings:[{rule,detail}]}，有 violation exit 1 否则 0。

import fs from 'node:fs';
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

function lint(mdPath, diffCmd, isDefaultCmd) {
  const violations = [];
  const warnings = [];
  const md = fs.readFileSync(mdPath, 'utf-8');
  const fm = parseFrontmatter(md);
  const tier = (fm.tier || 'S').toUpperCase();
  const changedFiles = (fm['changed-files'] || '').split(',').map((s) => normPath(s)).filter(Boolean);

  const changedSet = new Set(changedFiles);

  // ---- 跑 diff：name-only（文件集）+ 全文（行数）----
  let nameOut = null;
  let diffOut = null;
  let diffFailed = false;
  const runDiff = (args) => {
    const r = spawnSync(diffCmd + ' ' + args, { shell: true, encoding: 'utf-8' });
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
    const st = spawnSync('git -c core.quotepath=false status --porcelain -uall', { shell: true, encoding: 'utf-8' });
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

  return { violations, warnings };
}

function main() {
  const argv = process.argv.slice(2);
  let diffCmd = 'git -c core.quotepath=false diff HEAD'; // P2-6：含 staged + 处理非 ASCII 路径
  let isDefaultCmd = true;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff-cmd') { diffCmd = argv[i + 1]; isDefaultCmd = false; i++; }
    else if (!file) file = argv[i];
  }
  if (!file) {
    process.stderr.write('用法: node review-lint.mjs <变更单.md> [--diff-cmd "git diff"]\n');
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = lint(file, diffCmd, isDefaultCmd);
  } catch (e) {
    process.stderr.write('[review-lint] 失败: ' + e.message + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.violations.length > 0 ? 1 : 0;
}

main();
