#!/usr/bin/env node
// ui-analyzer.mjs — Web UI 量化验收器（纯 Node，零依赖）
// 用法：node ui-analyzer.mjs <geometry.json>  （或通过 stdin 传入 JSON）
// 输入为 hooks/ui-collect.js 在浏览器页面中采集产出的 JSON。
// 输出：JSON {summary, violations}；除解析失败（exit 1）外始终 exit 0，结果由调用方读 JSON。
import fs from 'node:fs';

const TOL = 1;          // 越界容差 1px
const MIN_TOUCH = 44;   // 触控目标最小尺寸
const MIN_FONT = 12;    // 最小字号
const MAX_FONT = 48;    // 最大字号（warning）
const MIN_CONTRAST = 4.5;
const OVERLAP_MIN_AREA = 4; // 交叠面积 >4px² 才报告
const OVERLAP_MIN_THIN = 3; // 交叠最窄边 ≤3px 视为边框共享/取整伪影
const GRID = 4;         // 4px 对齐网格（warning）
const VIEWPORT_AREA_MAX = 0.85; // 单元素面积占视口比（warning）

// 解析命令行：--out <path> 为可选输出路径（只作输出，不作为输入）；
// 其余非 - 开头的第一个参数为输入文件；无位置参数时输入来自 stdin。
function parseArgs() {
  const argv = process.argv.slice(2);
  const positional = [];
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      out = argv[i + 1] || null;
      i++; // 跳过 --out 的值
    } else if (argv[i] && !argv[i].startsWith('-')) {
      positional.push(argv[i]);
    }
  }
  return { input: positional[0] || null, out };
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

function readInput() {
  const { input: arg } = parseArgs();
  if (arg && arg !== '-') {
    return fs.readFileSync(arg, 'utf8');
  }
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function parseColor(str) {
  if (typeof str !== 'string') return null;
  const s = str.trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = s.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/);
  if (m) {
    let a = 1;
    if (m[4] != null) {
      a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), a];
  }
  return null;
}

function channel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relLum(rgb) {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(fg, bg) {
  const l1 = relLum(fg);
  const l2 = relLum(bg);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function contains(a, b) {
  return a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
}

// 判断下标 ancestorIdx 是否是下标 childIdx 的祖先（沿 parentIdx 链向上找）。
function isAncestorByChain(childIdx, ancestorIdx, els) {
  let p = els[childIdx].el.parentIdx;
  let guard = 0;
  while (Number.isInteger(p) && p >= 0 && guard++ < 10000) {
    if (p === ancestorIdx) return true;
    const next = els[p];
    if (!next) return false;
    p = next.el.parentIdx;
  }
  return false;
}

// 返回交叠矩形 {w,h,area}；无交叠时 area=0
function overlapRect(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? { w, h, area: w * h } : { w: 0, h: 0, area: 0 };
}

function overlapArea(a, b) {
  return overlapRect(a, b).area;
}

function label(el) {
  return el.tag + (el.id ? '#' + el.id : '');
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

function main() {
  const raw = readInput();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    process.stderr.write('ui-analyzer: 输入不是合法 JSON：' + e.message + '\n');
    process.exit(1);
  }
  if (!data || typeof data !== 'object' || !data.viewport || !Array.isArray(data.elements)) {
    process.stderr.write('ui-analyzer: 输入缺少 viewport{w,h} 或 elements 数组（应为 ui-collect.js 的输出格式）\n');
    process.exit(1);
  }

  const vw = num(data.viewport.w);
  const vh = num(data.viewport.h);
  const vpArea = vw * vh;
  const violations = [];
  let skippedContrast = 0;

  for (const el of data.elements) {
    const x = num(el.x);
    const y = num(el.y);
    const w = num(el.w);
    const h = num(el.h);
    const id = label(el);

    // 越界：垂直方向仅 fixed 定位元素视作真正越界（正常文档流靠滚动可达）；
    // 水平方向处于横向滚动容器（hScroll）内的元素跳过。
    const isFixed = el.position === 'fixed';
    const hScroll = el.hScroll === true;
    if (isFixed && (y < 0 || y + h > vh + TOL)) {
      violations.push({
        severity: 'error',
        rule: 'out-of-bounds',
        element: id,
        detail: `fixed 元素 rect(${x},${y},${w},${h}) 垂直方向超出视口 ${vw}x${vh}（容差 ${TOL}px）`
      });
    }
    if (!hScroll && (x < 0 || x + w > vw + TOL)) {
      violations.push({
        severity: 'error',
        rule: 'out-of-bounds',
        element: id,
        detail: `rect(${x},${y},${w},${h}) 水平方向超出视口 ${vw}x${vh}（容差 ${TOL}px）`
      });
    }

    // 触控目标
    if (el.interactive && (w < MIN_TOUCH || h < MIN_TOUCH)) {
      violations.push({
        severity: 'error',
        rule: 'touch-target',
        element: id,
        detail: `可交互元素尺寸 ${w}x${h} 小于 ${MIN_TOUCH}px 触控目标`
      });
    }

    // 字号
    const fontSize = num(el.fontSize);
    const text = typeof el.text === 'string' ? el.text.trim() : '';
    if (text && fontSize < MIN_FONT) {
      violations.push({
        severity: 'error',
        rule: 'font-size-min',
        element: id,
        detail: `含文本 "${text.slice(0, 10)}" 字号 ${fontSize}px < ${MIN_FONT}px`
      });
    }
    if (text && fontSize > MAX_FONT) {
      violations.push({
        severity: 'warning',
        rule: 'font-size-max',
        element: id,
        detail: `字号 ${fontSize}px > ${MAX_FONT}px`
      });
    }

    // 对比度（不可解析或含 alpha 通道则跳过）
    if (text) {
      const fg = parseColor(el.fg);
      const bg = parseColor(el.bg);
      if (!fg || !bg) {
        skippedContrast++;
      } else if (fg[3] < 1 || bg[3] < 1) {
        skippedContrast++;
      } else {
        const ratio = contrast(fg, bg);
        if (ratio < MIN_CONTRAST) {
          violations.push({
            severity: 'error',
            rule: 'contrast',
            element: id,
            detail: `文本 "${text.slice(0, 10)}" 对比度 ${ratio.toFixed(2)}:1 < ${MIN_CONTRAST}:1 (fg=${el.fg} bg=${el.bg})`
          });
        }
      }
    }

    // 4px 网格
    if (x % GRID !== 0 || y % GRID !== 0 || w % GRID !== 0 || h % GRID !== 0) {
      violations.push({
        severity: 'warning',
        rule: 'grid-4px',
        element: id,
        detail: `rect(${x},${y},${w},${h}) 未对齐 ${GRID}px 网格`
      });
    }

    // 单元素面积占视口 >85%
    if (vpArea > 0 && (w * h) / vpArea > VIEWPORT_AREA_MAX) {
      violations.push({
        severity: 'warning',
        rule: 'viewport-dominant',
        element: id,
        detail: `元素面积占视口 ${(((w * h) / vpArea) * 100).toFixed(1)}% > ${VIEWPORT_AREA_MAX * 100}%`
      });
    }
  }

  // 页面级横向溢出：viewport.scrollW > w + 1 说明页面自身可横向滚动
  const scrollW = num(data.viewport.scrollW);
  if (scrollW && scrollW > vw + TOL) {
    violations.push({
      severity: 'error',
      rule: 'page-h-overflow',
      element: 'page',
      detail: `页面内容宽度 ${scrollW}px > 视口宽度 ${vw}px，存在页面级横向溢出`
    });
  }

  // 重叠（简化：互不包含且 zIndex 相同即报告）
  // 重叠：优先用 parentIdx 链判断祖先关系（任一元素是另一元素的祖先 → 跳过）；
  // parentIdx 缺失（旧数据）或为 -1 时回退到几何包含判断。
  const els = data.elements.map((el) => ({
    el,
    x: num(el.x),
    y: num(el.y),
    w: num(el.w),
    h: num(el.h),
    z: num(el.zIndex)
  }));
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i];
      const b = els[j];
      // 文档容器（html/body）天然包裹全部内容，且 html 不在 parentIdx 链中、
      // 几何包含会被滚动溢出破坏，与它们配对一律跳过。
      const tagA = (a.el.tag || '').toLowerCase();
      const tagB = (b.el.tag || '').toLowerCase();
      if (tagA === 'html' || tagA === 'body' || tagB === 'html' || tagB === 'body') continue;
      if (a.z !== b.z) continue;
      const rect = overlapRect(a, b);
      // 交叠最窄边 ≤3px 视为 border-collapse 共享边框/取整伪影，非真实重叠
      if (rect.w <= OVERLAP_MIN_THIN || rect.h <= OVERLAP_MIN_THIN) continue;
      const area = rect.area;
      if (area <= OVERLAP_MIN_AREA) continue;
      const pa = a.el.parentIdx;
      const pb = b.el.parentIdx;
      const hasChain = Number.isInteger(pa) && pa >= -1 && Number.isInteger(pb) && pb >= -1;
      if (hasChain) {
        if (isAncestorByChain(i, j, els) || isAncestorByChain(j, i, els)) continue;
        // 某一方 parentIdx 为 -1（无被采集祖先）时回退几何包含判断
        if ((pa === -1 || pb === -1) && (contains(a, b) || contains(b, a))) continue;
      } else if (contains(a, b) || contains(b, a)) {
        continue;
      }
      violations.push({
        severity: 'error',
        rule: 'overlap',
        element: label(a.el),
        detail: `与 ${label(b.el)} 重叠 ${area.toFixed(0)}px²（同 zIndex=${a.z}，互不包含）`
      });
    }
  }

  violations.sort((p, q) => (p.severity === q.severity ? 0 : p.severity === 'error' ? -1 : 1));
  const summary = {
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    skippedContrast
  };
  const result = { summary, violations };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const { out } = parseArgs();
  if (out) {
    try {
      writeReport(out, result);
    } catch (e) {
      process.stderr.write('ui-analyzer: 写入报告文件失败 ' + out + '：' + e.message + '\n');
      process.exit(1);
    }
  }
}

main();
