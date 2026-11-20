#!/usr/bin/env node
'use strict';
// flow-status.mjs — dev-sop v1.8.0 断点续作状态扫描（纯 Node 零依赖，规格 B）
//
// CLI:
//   node flow-status.mjs [--root <项目根>]   默认 root = cwd
//
// 扫描 docs/specs/*.md 与 docs/changes/*.md + 各类 report（<slug>.test-report.json /
// <slug>.review-report.json / <slug>.ui-report.json，位于 specs/ 或 changes/ 任一目录），
// 对每个活跃 slug 输出一行：slug | 来源(spec/change) | 状态 | 下一步。Markdown 表格，exit 0。
//
// 状态判定（approved 源按产物推进，first match wins）：
//   wireframe 已声明且未批               → 待批准（线框）      → 呈报批准（终修 P2-6 规则 0）
//   status:draft                       → draft             → 呈报批准
//   无实现标记 / spec 声明文件均未存在    → approved待实现     → 进入实现（终修 P2-6 未实现期）
//   !test-report                        → 已实现缺test-report → 补 test-report
//   !review-report                      → 缺review-report    → 委派 reviewer
//   needs_ui && !ui-report             → 已实现缺ui-report   → 补 ui-report
//   其余                                → 合规               → 可定稿
// 实现标记 = docs/tasks/<slug>.md 或 docs/tasks/<slug>-exec.md 存在，或已有 test/review report。
// review:/tier: 值剥首尾引号（终修 P2-5，与 accept-check 一致）。

import fs from 'node:fs';
import path from 'node:path';

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

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  } catch (e) {
    return [];
  }
}

function hasReport(reportDirs, slug, kind) {
  const name = slug + '.' + kind + '-report.json';
  return reportDirs.some((d) => fs.existsSync(path.join(d, name)));
}

// 终修 P2-5：标量值剥首尾引号（与 accept-check frontmatterField 的 code-files 处理一致），
// 避免 frontmatter 写 review: "required" / tier: "M" 时判定与门禁脱节。
function stripQuotes(s) {
  return String(s == null ? '' : s).trim().replace(/^["']|["']$/g, '').trim();
}

// 终修 P2-6（未实现期）：spec 声明的 code-files/ui-files（排除 none 项）文件清单。
function declaredSpecFiles(info) {
  const toks = [];
  for (const raw of [info.codeFilesRaw, info.uiFilesRaw]) {
    if (raw == null) continue;
    for (const t of String(raw).split(',')) {
      const v = t.trim().replace(/^["']|["']$/g, '');
      if (v && v.toLowerCase() !== 'none') toks.push(v);
    }
  }
  return toks;
}

// 收集 slug → {source, status, needsUi}
function collectSlugs(root) {
  const specsDir = path.join(root, 'docs', 'specs');
  const changesDir = path.join(root, 'docs', 'changes');
  const reportDirs = [specsDir, changesDir];
  const bySlug = new Map();

  const add = (file, source) => {
    const md = fs.readFileSync(file, 'utf-8');
    const fm = parseFrontmatter(md);
    const slug = fm.slug || path.basename(file).replace(/\.md$/, '');
    const cur = {
      slug,
      source,
      status: (fm.status || 'draft').toLowerCase(),
      needsUi: /^(true|yes|1)$/i.test(fm['needs-ui'] || ''),
      // P1-4：采集与 accept-check 对齐所需的判定字段
      // 终修 P2-5：tier/review 值剥首尾引号；终修 P2-6：补采 wireframe/ui-files
      tier: stripQuotes(fm.tier).toUpperCase(),
      codeFilesRaw: fm['code-files'], // 可能为 undefined（spec 无 code-files 字段）
      uiFilesRaw: fm['ui-files'],
      reviewRaw: stripQuotes(fm.review).toLowerCase(),
      wireframeRaw: (fm.wireframe || '').trim().toLowerCase(),
    };
    // spec 优先于 change：若已存在 spec，change 不覆盖来源
    const prev = bySlug.get(slug);
    if (!prev || (prev.source === 'change' && source === 'spec')) {
      bySlug.set(slug, cur);
    }
  };

  for (const f of listMd(specsDir)) {
    if (/\.(test|review|ui)-report\.json$/.test(f)) continue; // 仅 .md，已过滤
    add(f, 'spec');
  }
  for (const f of listMd(changesDir)) add(f, 'change');

  return { bySlug, reportDirs, root };
}

function classify(info, reportDirs, root) {
  const { slug, status, needsUi, source, tier } = info;
  const hasTest = hasReport(reportDirs, slug, 'test');
  const hasReview = hasReport(reportDirs, slug, 'review');
  const hasUI = hasReport(reportDirs, slug, 'ui');

  // 终修 P2-6（规则 0，与 inject 同步）：wireframe 已声明且未批（draft 或 approved 皆适用）
  // → 待批准（线框），不得进入实现/报告判定。
  if (info.wireframeRaw && info.wireframeRaw !== 'approved') {
    return { state: '待批准（线框）', next: '呈报批准' };
  }

  if (status === 'draft') return { state: 'draft', next: '呈报批准' };

  // 终修 P2-6（未实现期）：spec 声明的 code-files/ui-files 非 none 文件均不存在 → 尚未实现，
  // 显示"待实现"而非"缺报告"（与 accept-check "文件未实现则不拦" 谓词一致）。
  if (source === 'spec') {
    const declared = declaredSpecFiles(info);
    if (declared.length > 0 && !declared.some((f) => fs.existsSync(path.resolve(root, f)))) {
      return { state: 'approved待实现', next: '进入实现' };
    }
  }

  const implemented =
    hasTest || hasReview ||
    fs.existsSync(path.join(root, 'docs', 'tasks', slug + '.md')) ||
    fs.existsSync(path.join(root, 'docs', 'tasks', slug + '-exec.md'));

  if (!implemented) return { state: 'approved待实现', next: '进入实现' };

  // P1-4：requireTest / requireReview 逐条对齐 accept-check 实际门禁谓词
  //  spec：code-files 声明且非 none 才要求 test-report；review 仅 review: required 才要求 review-report。
  //  change：tier M 才要求 test-report（S 免）；tier S/M 一律要求 review-report（不认 review: exempt）。
  const specNeedTest = (() => {
    const raw = info.codeFilesRaw;
    if (raw == null) return false;
    const toks = String(raw)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    if (toks.length === 0) return false;
    if (toks.length === 1 && toks[0].toLowerCase() === 'none') return false;
    return true;
  })();
  const requireTest = source === 'change' ? tier === 'M' : specNeedTest;
  const requireReview = source === 'change' ? (tier === 'S' || tier === 'M') : info.reviewRaw === 'required';

  if (requireTest && !hasTest) return { state: '已实现缺test-report', next: '补 test-report' };
  if (requireReview && !hasReview) return { state: '缺review-report', next: '委派 reviewer' };
  if (needsUi && !hasUI) return { state: '已实现缺ui-report', next: '补 ui-report' };
  return { state: '合规', next: '可定稿' };
}

function render(rows) {
  const out = [
    '| slug | 来源 | 状态 | 下一步 |',
    '| --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    out.push('| ' + r.slug + ' | ' + r.source + ' | ' + r.state + ' | ' + r.next + ' |');
  }
  return out.join('\n') + '\n';
}

function flowStatus(root) {
  const { bySlug, reportDirs } = collectSlugs(root);
  const rows = [];
  for (const info of bySlug.values()) {
    const c = classify(info, reportDirs, root);
    rows.push({ slug: info.slug, source: info.source, state: c.state, next: c.next });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));
  return rows;
}

function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') { root = argv[i + 1]; i++; }
  }
  try {
    const rows = flowStatus(root);
    process.stdout.write(render(rows));
    process.exitCode = 0;
  } catch (e) {
    // 无 docs 目录容错：readdir 已 try/catch，这里兜底输出空表
    process.stdout.write(render([]));
    process.exitCode = 0;
  }
}

main();
