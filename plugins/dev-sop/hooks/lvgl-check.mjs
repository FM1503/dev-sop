#!/usr/bin/env node
// lvgl-check.mjs — LVGL UI 静态校验器（纯 Node，零依赖，正则近似解析）
// 用法：node lvgl-check.mjs <ui.c> [more.c|h ...]
// 注意：父子关系为按代码顺序的近似归属（flex 设置之后到下一个容器创建之前的
// set_pos 调用视为该 flex 容器的子对象），不解析真实对象树。
// 输出：JSON {summary, violations}；始终 exit 0（结果由调用方读 JSON）。
import fs from 'node:fs';

function label(v) {
  return v + '(lv_obj)';
}

// 解析命令行：非 - 开头的参数为输入文件；--out <path> 为可选输出路径
function parseArgs() {
  const argv = process.argv.slice(2);
  const files = argv.filter((a) => a && !a.startsWith('-'));
  const outIdx = argv.indexOf('--out');
  const out = outIdx !== -1 && argv[outIdx + 1] ? argv[outIdx + 1] : null;
  return { files, out };
}

// 写入报告文件：统一结构 {"reports":[...], "summary":{errors,warnings}}
// 文件已存在且为数组结构则追加并重算 summary；首次创建则初始化结构。
function writeReport(outPath, result) {
  let report = null;
  if (fs.existsSync(outPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.reports)) {
        report = parsed;
      }
    } catch (e) {
      report = null;
    }
  }
  if (!report) report = { reports: [], summary: { errors: 0, warnings: 0 } };
  report.reports.push(result);
  report.summary = {
    errors: report.reports.reduce((s, r) => s + ((r && r.summary && Number(r.summary.errors)) || 0), 0),
    warnings: report.reports.reduce((s, r) => s + ((r && r.summary && Number(r.summary.warnings)) || 0), 0)
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

function main() {
  const { files, out } = parseArgs();
  if (files.length === 0) {
    process.stderr.write('lvgl-check: 用法 node lvgl-check.mjs <ui.c> [more.c|h ...]\n');
    process.exit(1);
  }

  const violations = [];
  let screenW = null;
  let screenH = null;
  const objects = new Map(); // var -> {pos:{x,y}|null, size:{w,h}|null, pctCount, pxCount, flex, hasPos}
  const flexMixTargets = new Set(); // flex 容器中被 set_pos 的（容器名）
  let sizeCalls = 0;
  let pctCalls = 0;
  let anyLvCall = false;

  function obj(name) {
    if (!objects.has(name)) {
      objects.set(name, { pos: null, size: null, pctCount: 0, pxCount: 0, flex: false, file: '' });
    }
    return objects.get(name);
  }

  let createSeen = false;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      process.stderr.write('lvgl-check: 无法读取 ' + file + '：' + e.message + '\n');
      process.exit(1);
    }
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const code = line.replace(/\/\/.*$/, '');
      let m;

      // 屏幕尺寸 #define
      m = code.match(/#\s*define\s+\w*(?:HOR|WIDTH)\w*\s+(\d+)/i);
      if (m) screenW = parseInt(m[1], 10);
      m = code.match(/#\s*define\s+\w*(?:VER|HEIGHT)\w*\s+(\d+)/i);
      if (m) screenH = parseInt(m[1], 10);

      // 近似归属：flex 设置之后的 set_pos 调用视为该 flex 容器的子对象
      if (/lv_obj_create\s*\(/.test(code)) {
        createSeen = true;
      }

      // 位置
      m = code.match(/lv_obj_set_pos\s*\(\s*(\w+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/);
      if (m) {
        anyLvCall = true;
        const o = obj(m[1]);
        o.pos = { x: parseInt(m[2], 10), y: parseInt(m[3], 10) };
        if (activeFlexContainer && m[1] !== activeFlexContainer) {
          flexMixTargets.add(activeFlexContainer);
        }
      }

      // 尺寸
      m = code.match(/lv_obj_set_size\s*\(\s*(\w+)\s*,\s*(\S+?)\s*,\s*(\S+?)\s*\)/);
      if (m) {
        anyLvCall = true;
        const o = obj(m[1]);
        o.size = { w: m[2], h: m[3] };
        sizeCalls++;
        if (/lv_pct\s*\(/.test(m[2] + m[3])) pctCalls += 2; else o.pxCount += 2;
      }
      m = code.match(/lv_obj_set_width\s*\(\s*(\w+)\s*,\s*(\S+?)\s*\)/);
      if (m) {
        anyLvCall = true;
        const o = obj(m[1]);
        o.size = o.size || { w: null, h: null };
        o.size.w = m[2];
        sizeCalls++;
        if (/lv_pct\s*\(/.test(m[2])) pctCalls++; else o.pxCount++;
      }
      m = code.match(/lv_obj_set_height\s*\(\s*(\w+)\s*,\s*(\S+?)\s*\)/);
      if (m) {
        anyLvCall = true;
        const o = obj(m[1]);
        o.size = o.size || { w: null, h: null };
        o.size.h = m[2];
        sizeCalls++;
        if (/lv_pct\s*\(/.test(m[2])) pctCalls++; else o.pxCount++;
      }

      // flex 布局
      if (/lv_obj_set_flex_\w*\s*\(/.test(code)) {
        anyLvCall = true;
        const fm = code.match(/lv_obj_set_flex_\w*\s*\(\s*(\w+)/);
        if (fm) {
          const o = obj(fm[1]);
          o.flex = true;
          activeFlexContainer = fm[1];
        }
      }

      if (/lv_obj_add_flag\s*\(/.test(code) && /LV_OBJ_FLAG_/.test(code)) {
        anyLvCall = true; // 忽略
      }
      if (/lv_obj_\w+\s*\(/.test(code)) anyLvCall = true;
    }
  }

  if (!anyLvCall) {
    violations.push({
      severity: 'warning',
      rule: 'no-lvgl-calls',
      element: '(file)',
      detail: '未解析到任何 lv_obj_ 调用，请确认输入是 LVGL UI 源码'
    });
  }

  // 屏幕尺寸声明
  if (screenW == null || screenH == null) {
    violations.push({
      severity: 'warning',
      rule: 'screen-size-undeclared',
      element: '(screen)',
      detail: '未找到含 HOR/WIDTH 或 VER/HEIGHT 的 #define 屏幕尺寸声明，跳过越界校验'
    });
  }

  function pxVal(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    return null; // lv_pct(...) 或表达式 → 非固定 px
  }

  const absRects = [];
  for (const [name, o] of objects) {
    const x = o.pos ? o.pos.x : null;
    const y = o.pos ? o.pos.y : null;
    const w = pxVal(o.size ? o.size.w : null);
    const h = pxVal(o.size ? o.size.h : null);

    // 奇数坐标
    if (o.pos && ((Math.abs(x) % 2) !== 0 || (Math.abs(y) % 2) !== 0)) {
      violations.push({
        severity: 'warning',
        rule: 'odd-position',
        element: label(name),
        detail: `set_pos(${x}, ${y}) 使用了奇数像素，建议偶数对齐`
      });
    }

    // 越界（绝对定位且固定 px 尺寸）
    if (o.pos && w != null && h != null && screenW != null && screenH != null) {
      if (x < 0 || y < 0 || x + w > screenW || y + h > screenH) {
        violations.push({
          severity: 'error',
          rule: 'out-of-bounds',
          element: label(name),
          detail: `pos(${x},${y}) size(${w}x${h}) 超出屏幕 ${screenW}x${screenH}`
        });
      }
      absRects.push({ name, x, y, w, h });
    }
  }

  // 绝对定位矩形重叠
  for (let i = 0; i < absRects.length; i++) {
    for (let j = i + 1; j < absRects.length; j++) {
      const a = absRects[i];
      const b = absRects[j];
      const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ow > 0 && oh > 0 && ow * oh > 4) {
        const aInB = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
        const bInA = b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
        if (!aInB && !bInA) {
          violations.push({
            severity: 'error',
            rule: 'overlap',
            element: label(a.name),
            detail: `与 ${label(b.name)} 矩形重叠 ${ow * oh}px²（互不包含）`
          });
        }
      }
    }
  }

  // flex 容器内混用 set_pos
  for (const c of flexMixTargets) {
    violations.push({
      severity: 'warning',
      rule: 'flex-mixed-position',
      element: label(c),
      detail: '容器已启用 flex 布局，但其（近似归属的）子对象仍使用 lv_obj_set_pos 绝对定位，布局混用'
    });
  }

  // 硬编码 px 比例
  if (sizeCalls > 0) {
    const totalDim = pctCalls + Array.from(objects.values()).reduce((s, o) => s + o.pxCount, 0);
    if (totalDim > 0) {
      const pxRatio = (totalDim - pctCalls) / totalDim;
      if (pxRatio > 0.7) {
        violations.push({
          severity: 'warning',
          rule: 'hardcoded-px',
          element: '(file)',
          detail: `硬编码 px 尺寸占比 ${(pxRatio * 100).toFixed(0)}% > 70%，建议改用 lv_pct() 提升分辨率适配性`
        });
      }
    }
  }

  violations.sort((p, q) => (p.severity === q.severity ? 0 : p.severity === 'error' ? -1 : 1));
  const summary = {
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    skippedContrast: 0
  };
  const result = { summary, violations };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (out) {
    try {
      writeReport(out, result);
    } catch (e) {
      process.stderr.write('lvgl-check: 写入报告文件失败 ' + out + '：' + e.message + '\n');
      process.exit(1);
    }
  }
}

let activeFlexContainer = null;
main();
