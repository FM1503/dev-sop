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
import path from 'node:path';

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

// ---- 解析：markdown 表格行 → 单元格数组（P1-1：识别 \| 转义；终修 P2-1：明确双转义语义）----
// 逐字符扫描：连续反斜杠段（≥1 个）后紧跟 "|" 时，整段视为转义竖线——"\|"、"\\|"、"\\\\|"
// 均输出字面 "|" 并消耗整段与竖线（"\\| 与 \| 同效"）；反斜杠段后无 "|" 时，该段坍缩为单个
// 字面反斜杠输出（"\\\\" → "\"，孤立 "\" 亦原样保留）。裸 "|" 为分隔符。
// 行首/行尾的分隔竖线不计入单元格；单元格内容 trim。
function splitPipeRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  if (line[0] === '|') i = 1; // 跳过行首分隔竖线
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\') {
      let n = 1;
      while (i + n < line.length && line[i + n] === '\\') n++; // 最大反斜杠段长度
      if (line[i + n] === '|') {
        cur += '|'; // 段后紧跟竖线：整段为转义竖线，输出字面 |
        i += n; // 循环 ++ 共消耗 n 个反斜杠 + 1 个竖线
      } else {
        cur += '\\'; // 段后无竖线：整段坍缩为单个字面反斜杠
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
  // 行尾若以分隔竖线结束，cur 为 ''；仅当确有意义内容（或无分隔的退化行）才追加尾单元格
  if (cur.trim() !== '' || cells.length === 0) cells.push(cur.trim());
  return cells;
}

// ---- 解析：markdown 表格 → 行对象数组（按表头列名取值）----
// 列名可含子串匹配（如 "新内容" / "新内容（...）"）。返回每行 {列名: 单元格}。
function parseTable(text) {
  if (text == null) return null;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('|'));
  if (lines.length < 2) return null;
  // 单元格内 \| 为转义竖线（字面 | 内容），裸 | 为分隔；解析后 \| 还原为 |。
  const split = (l) => splitPipeRow(l);
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
  if (!slug) { const e = new Error('frontmatter 缺少 slug'); e.badarg = true; throw e; }
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
    if (!file) continue;
    const newCell = pick(row, tbl.header, '新内容');
    if (newCell.startsWith('<NEWFILE>')) {
      patches.push({
        file,
        newfile: true,
        new: unescapeNewlines(newCell.slice('<NEWFILE>'.length)),
      });
      continue;
    }
    // 编辑/删除行：行号与旧行数必须为正整数（P2-8），否则清晰报错（badarg → exit 2）
    const linenoRaw = pick(row, tbl.header, '行号');
    const oldRaw = pick(row, tbl.header, '旧行数');
    const lineno = Number(linenoRaw);
    const old_count = Number(oldRaw);
    if (!Number.isInteger(lineno) || lineno <= 0) {
      const e = new Error('编辑行行号须为正整数: ' + JSON.stringify(linenoRaw) + '（文件 ' + file + '）');
      e.badarg = true; throw e;
    }
    if (!Number.isInteger(old_count) || old_count <= 0) {
      const e = new Error('编辑行旧行数须为正整数: ' + JSON.stringify(oldRaw) + '（文件 ' + file + '）');
      e.badarg = true; throw e;
    }
    // P1-2：空"新内容"单元格 = 删除 old_count 行（new 置空串，Python 端 del 区间）
    patches.push({
      file,
      newfile: false,
      lineno,
      anchor: pick(row, tbl.header, '锚点'),
      old_count,
      new: unescapeNewlines(newCell),
    });
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
    'import sys, os, json, base64, re',
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
    '    # 终修 P2-2：弃用 splitlines(True)（其把 \\f \\v \\x1c-\\x1e \\x85 \\u2028 \\u2029 也当行界，',
    '    # 致行号漂移）；改用 re.split 捕获 (\\r\\n|\\r|\\n) 重组，仅按这三种分隔符分行且保留原行尾。',
    '    _segs = re.split("(\\\\r\\\\n|\\\\r|\\\\n)", text)',
    '    ke = []',
    '    for _j in range(0, len(_segs) - 1, 2): ke.append(_segs[_j] + _segs[_j + 1])',
    '    if len(_segs) % 2 == 1 and _segs[-1] != "": ke.append(_segs[-1])  # 末行无行尾（P2-3）',
    '    def _strip(l):',
    '        if l.endswith("\\r\\n"): return l[:-2]',
    '        if l.endswith("\\n") or l.endswith("\\r"): return l[:-1]',
    '        return l',
    '    lines = [_strip(l) for l in ke]',
    '    idx = p["lineno"] - 1; oc = p["old_count"]; anchor = p["anchor"]',
    '    if idx < 0 or idx >= len(ke): fail(f, "行号越界 %d" % p["lineno"], lines, max(idx, 0))',
    '    if anchor and anchor not in lines[idx]: fail(f, "锚点不匹配: 期望该行含 %r" % anchor, lines, idx)',
    '    end = idx + oc',
    '    if oc > 0 and end > len(ke): fail(f, "旧行数越界: 行 %d 起 %d 行超出文件" % (p["lineno"], oc), lines, idx)',
    '    _f = ke[idx]',
    '    eol = "\\r\\n" if _f.endswith("\\r\\n") else ("\\n" if _f.endswith("\\n") else ("\\r" if _f.endswith("\\r") else "\\n"))',
    '    if p["new"] == "":',
    '        repl = []  # P1-2：空新内容=删除区间（del lines[idx:end]）',
    '    else:',
    '        repl = [c + eol for c in p["new"].replace("\\r\\n", "\\n").replace("\\r", "\\n").split("\\n")]',
    '        # 终修 P2-3：替换区间含文件末行且原末行无 EOL → 新内容末行同样不补尾 EOL（保持无尾换行）',
    '        if repl and end == len(ke) and not (ke[-1].endswith("\\n") or ke[-1].endswith("\\r")):',
    '            repl[-1] = _strip(repl[-1])',
    '    ke[idx:end] = repl  # 未触碰行保持原始字节行尾',
    '    open(f, "wb").write("".join(ke).encode("utf-8"))',
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

// ---- P1-5：把编译产物渲染为执行书 markdown（变更表 + Python 脚本 + 执行命令 + 回滚说明）----
// 变更表重新编码时单元格内字面 | 转义为 \|、换行还原为 <NL>，保证可被 parseTable 往返。
function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, '<NL>');
}

function genExecDoc(compiled, mdPath) {
  const header = ['序号', '文件', '行号', '锚点', '旧行数', '新内容'];
  const rows = ['| ' + header.join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |'];
  compiled.patches.forEach((p, i) => {
    if (p.newfile) {
      rows.push('| ' + [i + 1, escapeCell(p.file), '-', '-', '-', escapeCell('<NEWFILE>' + p.new)].join(' | ') + ' |');
    } else {
      rows.push(
        '| ' +
          [i + 1, escapeCell(p.file), p.lineno, escapeCell(p.anchor), p.old_count, escapeCell(p.new)].join(' | ') +
          ' |'
      );
    }
  });

  const py = genForwardPython(compiled);
  const rbPy = genRollbackPython(compiled.slug);
  const parts = [];
  parts.push('# 执行书：' + compiled.slug + '（compile-change 编译产物）');
  parts.push('');
  parts.push('> 由 scripts/compile-change.mjs 编译 docs 变更单生成；勿手改，改变更单后重新编译。');
  parts.push('');
  parts.push('## 变更表');
  parts.push('');
  parts.push(rows.join('\n'));
  parts.push('');
  parts.push('## 补丁脚本');
  parts.push('');
  parts.push('```python');
  parts.push(py.trimEnd());
  parts.push('```');
  parts.push('');
  parts.push('## 执行命令');
  parts.push('');
  parts.push('```bash');
  parts.push('node scripts/compile-change.mjs ' + mdPath + ' | python - && ' + compiled.verify);
  parts.push('```');
  parts.push('');
  parts.push('## 回滚说明');
  parts.push('');
  parts.push('执行正向补丁时已快照 docs/changes/' + compiled.slug + '.rollback.json。回滚（还原编辑、删除新建文件）：');
  parts.push('');
  parts.push('```bash');
  parts.push('node scripts/compile-change.mjs ' + mdPath + ' --rollback | python -');
  parts.push('```');
  parts.push('');
  parts.push('回滚脚本：');
  parts.push('');
  parts.push('```python');
  parts.push(rbPy.trimEnd());
  parts.push('```');
  parts.push('');
  return parts.join('\n');
}

// P1-5：写执行书到 docs/tasks/<slug>-exec.md（默认开启；仅编译成功时调用）
function emitExecDoc(compiled, mdPath) {
  const out = path.join('docs', 'tasks', compiled.slug + '-exec.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, genExecDoc(compiled, mdPath), 'utf-8');
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const rollback = argv.includes('--rollback');
  const emitExec = !argv.includes('--no-emit-exec');
  const FLAGS = new Set(['--rollback', '--emit-exec', '--no-emit-exec']);
  const file = argv.find((a) => !FLAGS.has(a));
  if (!file) {
    process.stderr.write('用法: node compile-change.mjs <变更单.md> [--rollback] [--emit-exec|--no-emit-exec]\n');
    process.exitCode = 2;
    return;
  }

  let compiled;
  try {
    compiled = compileChangeDoc(file);
  } catch (e) {
    process.stderr.write('[compile-change] ' + e.message + '\n');
    // P2-8：行号/slug 等参数非法 → 清晰报错 exit 2；其余解析失败 → exit 1
    process.exitCode = e.badarg ? 2 : 1;
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

  // P1-5：编译成功后落盘执行书产物（失败不在此路径，已 return）
  if (emitExec) {
    try {
      const out = emitExecDoc(compiled, file);
      process.stderr.write('[compile-change] 执行书已写入 ' + out + '\n');
    } catch (e) {
      process.stderr.write('[compile-change] 执行书写入失败: ' + e.message + '\n');
    }
  }
}

main();
