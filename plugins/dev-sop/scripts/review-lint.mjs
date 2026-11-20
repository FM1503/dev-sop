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

function parseTable(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  const split = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
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

function lint(mdPath, diffCmd) {
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

  // ---- 1. fileset ----
  if (!diffFailed && nameOut != null) {
    const touched = nameOut.split(/\r?\n/).map(normPath).filter(Boolean);
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
    const hasTimeout = /timeout|ms\b|秒|时限/.test(verify.toLowerCase()) || v.includes('timeout');
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
  let diffCmd = 'git diff';
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--diff-cmd') { diffCmd = argv[i + 1]; i++; }
    else if (!file) file = argv[i];
  }
  if (!file) {
    process.stderr.write('用法: node review-lint.mjs <变更单.md> [--diff-cmd "git diff"]\n');
    process.exitCode = 2;
    return;
  }
  let result;
  try {
    result = lint(file, diffCmd);
  } catch (e) {
    process.stderr.write('[review-lint] 失败: ' + e.message + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.violations.length > 0 ? 1 : 0;
}

main();
