#!/usr/bin/env node
'use strict';
// compile-change.mjs — dev-sop v1.8.0 变更单编译器（纯 Node 零依赖，规格 2.A）
//
// CLI:
//   node compile-change.mjs <变更单.md>            默认：向 stdout 输出可执行 Python 补丁脚本
//   node compile-change.mjs <变更单.md> --rollback  向 stdout 输出回滚 Python 脚本（读 rollback.json 还原）
//
// 变更单结构（v1.8 表格驱动）：
//   frontmatter：slug / tier / changed-files（逗号分隔）
//   ## 变更表   列：| 序号 | 文件 | 行号 | 锚点 | 旧行数 | 新内容 |
//     - 编辑行：行号=旧块首行（1 基）；锚点=该行应含的子串；旧行数=被替换行数；新内容=替换文本（多行用 <NL> 转义）
//     - 新文件：新内容以 <NEWFILE> 前缀开头，其后为全文（多行用 <NL> 转义）；行号/锚点/旧行数置 - 忽略
//   ## expect_after  列：| 文件 | 包含子串 |
//   ## 验证          自由文本（编译器校验存在并原样透传到 stderr 执行提示）
//
// 生成的补丁脚本能力：rb 读/EOL 检测(\r\n)归一/wb 写、行号+锚点断言、旧行数校验、
// 新文件全文写+目录创建、expect_after 后置断言、执行前快照 docs/changes/<slug>.rollback.json、
// 失败 exit 1 打印 ±3 行上下文。

import fs from 'node:fs';

// ---- 解析：frontmatter ----
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

// ---- 解析：抓取某标题（## X）到下一个 ## 之间的正文 ----
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
    if (/^##\s/.test(lines[i])) break; // 仅二级标题为边界
    body.push(lines[i]);
  }
  return body.join('\n');
}

// ---- 解析：markdown 表格 → 行对象数组（按表头列名取值）----
// 列名可含子串匹配（如 "新内容" / "新内容（...）"）。返回每行 {列名: 单元格}。
function parseTable(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  const split = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = split(lines[0]);
  // 第二行须为分隔行（--- 形式），否则不是表格
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

// 按"列名包含关键字"取单元格（容忍表头带括号注释）
function pick(row, header, kw) {
  const key = header.find((h) => h.includes(kw));
  return key != null ? row[key] : '';
}

function unescapeNewlines(cell) {
  return cell.replace(/<NL>/g, '\n');
}

// 编译产物：解析变更单 → {slug, tier, changedFiles, patches[], expect[], verify}
function compileChangeDoc(mdPath) {
  const md = fs.readFileSync(mdPath, 'utf-8');
  const fm = parseFrontmatter(md);
  const slug = fm.slug;
  if (!slug) throw new Error('frontmatter 缺少 slug');
  const tier = (fm.tier || 'S').toUpperCase();
  const changedFiles = (fm['changed-files'] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const tbl = parseTable(sectionBody(md, '变更表'));
  if (!tbl) throw new Error('未找到 "## 变更表" 表格');

  const patches = [];
  for (const row of tbl.rows) {
    const file = pick(row, tbl.header, '文件');
    const newCell = pick(row, tbl.header, '新内容');
    if (!file || !newCell) continue;
    if (newCell.startsWith('<NEWFILE>')) {
      patches.push({
        file,
        newfile: true,
        new: unescapeNewlines(newCell.slice('<NEWFILE>'.length)),
      });
    } else {
      patches.push({
        file,
        newfile: false,
        lineno: parseInt(pick(row, tbl.header, '行号'), 10),
        anchor: pick(row, tbl.header, '锚点'),
        old_count: parseInt(pick(row, tbl.header, '旧行数'), 10) || 0,
        new: unescapeNewlines(newCell),
      });
    }
  }

  const expectTable = parseTable(sectionBody(md, 'expect_after'));
  const expect = [];
  if (expectTable) {
    for (const row of expectTable.rows) {
      const file = pick(row, expectTable.header, '文件');
      const contains = pick(row, expectTable.header, '包含');
      if (file) expect.push({ file, contains });
    }
  }

  const verify = sectionBody(md, '验证');
  if (verify == null || verify.trim() === '') throw new Error('变更单缺少 "## 验证" 字段');

  return { slug, tier, changedFiles, patches, expect, verify: verify.trim() };
}

// ---- 生成：正向补丁 Python 脚本 ----
function genForwardPython(compiled) {
  const payload = Buffer.from(
    JSON.stringify({ slug: compiled.slug, patches: compiled.patches, expect: compiled.expect }),
    'utf-8'
  ).toString('base64');
  return [
    'import sys, os, json, base64',
    'DATA = json.loads(base64.b64decode("' + payload + '").decode("utf-8"))',
    'SLUG = DATA["slug"]; PATCHES = DATA["patches"]; EXPECT = DATA["expect"]',
    'RB = os.path.join("docs", "changes", SLUG + ".rollback.json")',
    '',
    'def fail(file, msg, lines, hit):',
    '    ctx = "\\n".join("%4d %s" % (i + 1, l) for i, l in enumerate(lines) if abs(i - hit) <= 3)',
    '    sys.stderr.buffer.write(("[compile-change] FAIL %s: %s\\n%s\\n" % (file, msg, ctx)).encode("utf-8"))',
    '    sys.exit(1)',
    '',
    '# 执行前快照：编辑文件存原始字节，新文件存"已存在"或"created"标记',
    'snap = {}; created = []',
    'for p in PATCHES:',
    '    f = p["file"]',
    '    if p["newfile"]:',
    '        if os.path.exists(f): snap[f] = base64.b64encode(open(f, "rb").read()).decode()',
    '        else: created.append(f)',
    '        continue',
    '    if not os.path.exists(f): fail(f, "文件不存在", [], 0)',
    '    if f not in snap: snap[f] = base64.b64encode(open(f, "rb").read()).decode()',
    'os.makedirs(os.path.dirname(RB), exist_ok=True)',
    'json.dump({"snapshot": snap, "created": created}, open(RB, "w"))',
    '',
    '# 逐条应用',
    'for p in PATCHES:',
    '    f = p["file"]',
    '    if p["newfile"]:',
    '        d = os.path.dirname(f)',
    '        if d: os.makedirs(d, exist_ok=True)',
    '        open(f, "wb").write(p["new"].encode("utf-8"))',
    '        continue',
    '    raw = open(f, "rb").read(); text = raw.decode("utf-8")',
    '    crlf = "\\r\\n" in text; norm = text.replace("\\r\\n", "\\n")',
    '    lines = norm.split("\\n")',
    '    idx = p["lineno"] - 1; oc = p["old_count"]; anchor = p["anchor"]',
    '    if idx < 0 or idx >= len(lines): fail(f, "行号越界 %d" % p["lineno"], lines, max(idx, 0))',
    '    if anchor and anchor not in lines[idx]: fail(f, "锚点不匹配: 期望该行含 %r" % anchor, lines, idx)',
    '    end = idx + oc',
    '    if oc > 0 and end > len(lines): fail(f, "旧行数越界: 行 %d 起 %d 行超出文件" % (p["lineno"], oc), lines, idx)',
    '    newlines = p["new"].replace("\\r\\n", "\\n").split("\\n")',
    '    lines[idx:end] = newlines',
    '    body = "\\n".join(lines)',
    '    if crlf: body = body.replace("\\n", "\\r\\n")',
    '    open(f, "wb").write(body.encode("utf-8"))',
    '',
    '# expect_after 后置断言',
    'for e in EXPECT:',
    '    f = e["file"]',
    '    if not os.path.exists(f): fail(f, "expect_after 文件不存在", [], 0)',
    '    d = open(f, "rb").read().decode("utf-8")',
    '    if e["contains"] not in d:',
    '        fail(f, "expect_after 缺少子串 %r" % e["contains"], d.replace("\\r\\n", "\\n").split("\\n"), 0)',
    '',
    'print("[compile-change] OK: %d patches applied" % len(PATCHES))',
    '',
  ].join('\n');
}

// ---- 生成：回滚 Python 脚本 ----
function genRollbackPython(slug) {
  return [
    'import sys, os, json, base64',
    'SLUG = ' + JSON.stringify(slug),
    'RB = os.path.join("docs", "changes", SLUG + ".rollback.json")',
    'if not os.path.exists(RB):',
    '    sys.stderr.buffer.write(("[compile-change] 回滚失败：缺少 %s\\n" % RB).encode("utf-8")); sys.exit(1)',
    'data = json.load(open(RB))',
    'for f, b64 in data.get("snapshot", {}).items():',
    '    d = os.path.dirname(f)',
    '    if d: os.makedirs(d, exist_ok=True)',
    '    open(f, "wb").write(base64.b64decode(b64))',
    'for f in data.get("created", []):',
    '    if os.path.exists(f): os.remove(f)',
    'print("[compile-change] rollback ok: %d restored, %d removed" % (len(data.get("snapshot", {})), len(data.get("created", []))))',
    '',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const rollback = argv.includes('--rollback');
  const file = argv.find((a) => a !== '--rollback');
  if (!file) {
    process.stderr.write('用法: node compile-change.mjs <变更单.md> [--rollback]\n');
    process.exitCode = 2;
    return;
  }

  let compiled;
  try {
    compiled = compileChangeDoc(file);
  } catch (e) {
    process.stderr.write('[compile-change] 解析失败: ' + e.message + '\n');
    process.exitCode = 1;
    return;
  }

  if (rollback) {
    process.stdout.write(genRollbackPython(compiled.slug));
    return;
  }

  process.stdout.write(genForwardPython(compiled));
  // 验证字段原样透传：拼到执行命令提示（stderr，保持 stdout 仅含可管道执行的脚本）
  process.stderr.write(
    '[compile-change] 执行提示: node compile-change.mjs ' + file + ' | python - && ' + compiled.verify + '\n'
  );
}

main();
