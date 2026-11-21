#!/usr/bin/env node
// wpf-check.mjs — WPF XAML 静态校验器（纯 Node 零依赖，轻量标签解析）
// 用法：node wpf-check.mjs <.xaml 文件或目录> [more ...]   （目录递归查找 *.xaml）
// 规则来源：docs/specs/mixed-stack.md 2.A
//   error  ：canvas-overlap / out-of-bounds / missing-resource
//   warning：hardcoded-px / grid-zindex / low-contrast / window-sizing / parse-skipped
// 解析容错：XML 注释剥离、自闭合、x: 命名空间前缀属性、闭合标签乱序（栈中回溯）。
// 解析失败的单文件记 warning（parse-skipped）跳过；用法/读取/内部异常 fail-fast exit 1。
// 输出：JSON {summary:{errors,warnings,files,skippedContrast}, violations:[...]}；正常 exit 0。
import fs from 'node:fs';
import path from 'node:path';

const TAG_RE = /<(\/?)([\w:.\-]+)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR_RE = /([\w:.\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const RES_REF_RE = /\{\s*(?:StaticResource|DynamicResource)\s+([^}]+?)\s*\}/g;
const HEX_RE = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})$/;

function num(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : null;
}

// 轻量逐元素抽取：返回 {ok, root, elements}；无根元素时 ok=false + reason。
function parseXaml(text) {
  const src = text.replace(/<!--[\s\S]*?-->/g, ' ');
  const elements = [];
  const stack = [];
  let root = null;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(src))) {
    const closing = m[1] === '/';
    const name = m[2];
    const attrs = {};
    ATTR_RE.lastIndex = 0;
    let a;
    while ((a = ATTR_RE.exec(m[3] || ''))) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3];
    const line = src.slice(0, m.index).split('\n').length;
    if (closing) {
      // 容错：自顶向下找同名开标签回溯；找不到则忽略该闭合标签
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) { idx = i; break; }
      }
      if (idx !== -1) stack.length = idx;
      continue;
    }
    const parent = stack.length ? stack[stack.length - 1] : null;
    const el = { name, attrs, children: [], parent, line };
    if (parent) parent.children.push(el);
    if (!root) root = el;
    elements.push(el);
    if (m[4] !== '/') stack.push(el);
  }
  if (!root) return { ok: false, reason: '未解析到根元素（非 XAML/XML 内容）', elements };
  return { ok: true, root, elements };
}

function tagBase(name) {
  const i = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
  return i === -1 ? name : name.slice(i + 1);
}
const isWindow = (n) => tagBase(n).toLowerCase() === 'window';
const isCanvas = (n) => tagBase(n) === 'Canvas';
const isGrid = (n) => tagBase(n) === 'Grid';
const isViewbox = (n) => tagBase(n) === 'Viewbox';

function elLabel(el) {
  const xName = el.attrs['x:Name'] || el.attrs['Name'];
  return el.name + (xName ? '#' + xName : '');
}

// Canvas 直接子元素的绝对矩形（Canvas.Left/Top + Width/Height 全为数值才有）
function rectOf(el) {
  const x = num(el.attrs['Canvas.Left']);
  const y = num(el.attrs['Canvas.Top']);
  const w = num(el.attrs.Width);
  const h = num(el.attrs.Height);
  if (x == null || y == null || w == null || h == null) return null;
  return { x, y, w, h };
}

function hexToRgb(v) {
  const m = HEX_RE.exec(v.trim());
  if (!m) return null;
  const s = m[1];
  const hex = s.length === 8 ? s.slice(2) : s; // #AARRGGBB 取 RGB
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16)
  ];
}

// WCAG 2.x 相对亮度与对比度
function relLum(rgb) {
  const ch = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(rgb[0]) + 0.7152 * ch(rgb[1]) + 0.0722 * ch(rgb[2]);
}
function contrastRatio(fg, bg) {
  const l1 = relLum(fg);
  const l2 = relLum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function checkFile(file, violations, state) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write('wpf-check: 无法读取 ' + file + '：' + e.message + '\n');
    process.exit(1);
  }
  const parsed = parseXaml(text);
  if (!parsed.ok) {
    violations.push({
      severity: 'warning',
      rule: 'parse-skipped',
      element: '(file)',
      file,
      detail: '解析失败，跳过该文件：' + parsed.reason
    });
    return;
  }
  const els = parsed.elements;
  const win = els.find((el) => isWindow(el.name)) || null;

  // —— error ①：同一 Canvas 直接子元素矩形重叠（互不完整包含，交叠 >4px²）
  for (const canvas of els.filter((el) => isCanvas(el.name))) {
    const rects = [];
    for (const child of canvas.children) {
      const r = rectOf(child);
      if (r) rects.push({ el: child, r });
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r;
        const b = rects[j].r;
        const ow = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oh = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ow > 0 && oh > 0 && ow * oh > 4) {
          const aInB = a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
          const bInA = b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
          if (!aInB && !bInA) {
            violations.push({
              severity: 'error',
              rule: 'canvas-overlap',
              element: elLabel(rects[i].el),
              file,
              detail: '与 ' + elLabel(rects[j].el) + ' 在 Canvas 内矩形重叠 ' + (ow * oh) +
                'px²（互不完整包含），建议改用 Grid/StackPanel 布局'
            });
          }
        }
      }
    }

    // —— error ②：越界（父 Canvas 自身声明 Width/Height 时按其判定，否则按 Window 声明值；容差 1px）
    const frameW = num(canvas.attrs.Width) ?? (win ? num(win.attrs.Width) : null);
    const frameH = num(canvas.attrs.Height) ?? (win ? num(win.attrs.Height) : null);
    const frameBy = num(canvas.attrs.Width) != null || num(canvas.attrs.Height) != null ? 'Canvas ' + elLabel(canvas) : (win ? 'Window ' + win.attrs.Width + 'x' + win.attrs.Height : null);
    if (!win && frameW == null && frameH == null) continue;
    for (const child of canvas.children) {
      const r = rectOf(child);
      if (!r) continue;
      if (frameW != null && (r.x < 0 || r.x + r.w > frameW + 1)) {
        violations.push({
          severity: 'error',
          rule: 'out-of-bounds',
          element: elLabel(child),
          file,
          detail: 'Canvas.Left+Width 右缘 ' + (r.x + r.w) + ' 超出 ' + frameBy + ' 声明宽 ' + frameW + '（容差 1px）'
        });
      }
      if (frameH != null && (r.y < 0 || r.y + r.h > frameH + 1)) {
        violations.push({
          severity: 'error',
          rule: 'out-of-bounds',
          element: elLabel(child),
          file,
          detail: 'Canvas.Top+Height 底缘 ' + (r.y + r.h) + ' 超出 ' + frameBy + ' 声明高 ' + frameH + '（容差 1px）'
        });
      }
    }
  }

  // —— error ③：Static/DynamicResource Key 在本文件 x:Key 集合中不存在
  const keys = new Set();
  for (const el of els) {
    if (typeof el.attrs['x:Key'] === 'string') keys.add(el.attrs['x:Key'].trim());
  }
  for (const el of els) {
    for (const [k, v] of Object.entries(el.attrs)) {
      if (typeof v !== 'string' || v.indexOf('Resource') === -1) continue;
      RES_REF_RE.lastIndex = 0;
      let m;
      while ((m = RES_REF_RE.exec(v))) {
        const key = m[1].trim();
        if (!keys.has(key)) {
          violations.push({
            severity: 'error',
            rule: 'missing-resource',
            element: elLabel(el),
            file,
            detail: '属性 ' + k + ' 引用资源 Key "' + key + '" 在本文件 ResourceDictionary（x:Key 集合）中不存在'
          });
        }
      }
    }
  }

  // —— warning ①：硬编码像素尺寸占比 >70%
  let px = 0;
  let adaptive = 0;
  for (const el of els) {
    if (isViewbox(el.name)) adaptive++;
    if (typeof el.attrs['SizeToContent'] === 'string') adaptive++;
    for (const prop of ['Width', 'Height', 'MinWidth', 'MinHeight']) {
      const v = el.attrs[prop];
      if (typeof v !== 'string') continue;
      if (num(v) != null) px++;
      else if (v.trim() === 'Auto' || v.indexOf('*') !== -1) adaptive++;
    }
  }
  if (px + adaptive > 0 && px / (px + adaptive) > 0.7) {
    violations.push({
      severity: 'warning',
      rule: 'hardcoded-px',
      element: '(file)',
      file,
      detail: '硬编码像素尺寸占比 ' + Math.round((px / (px + adaptive)) * 100) +
        '% > 70%（' + px + '/' + (px + adaptive) + '），建议改用 Auto/*/star 或 Viewbox 提升适配性'
    });
  }

  // —— warning ②：同一 Grid Cell 多直接子元素且无 Panel.ZIndex
  for (const grid of els.filter((el) => isGrid(el.name))) {
    const cells = new Map();
    for (const child of grid.children) {
      if (tagBase(child.name).endsWith('Definitions')) continue; // ColumnDefinitions/RowDefinitions 不算内容
      const row = child.attrs['Grid.Row'] || '0';
      const col = child.attrs['Grid.Column'] || '0';
      const cellKey = row + ',' + col;
      if (!cells.has(cellKey)) cells.set(cellKey, []);
      cells.get(cellKey).push(child);
    }
    for (const [cellKey, kids] of cells) {
      if (kids.length >= 2 && !kids.some((k) => typeof k.attrs['Panel.ZIndex'] === 'string')) {
        violations.push({
          severity: 'warning',
          rule: 'grid-zindex',
          element: elLabel(grid),
          file,
          detail: 'Cell(Row=' + cellKey.split(',')[0] + ',Column=' + cellKey.split(',')[1] + ') 有 ' +
            kids.length + ' 个直接子元素（' + kids.map(elLabel).join('、') + '）且均未声明 Panel.ZIndex，层叠顺序隐式依赖声明次序'
        });
      }
    }
  }

  // —— warning ③：Foreground/Background 均十六进制色时对比度 <4.5；引用资源色跳过计数
  for (const el of els) {
    const fg = el.attrs.Foreground;
    const bg = el.attrs.Background;
    if (typeof fg !== 'string' || typeof bg !== 'string') continue;
    const fgHex = HEX_RE.test(fg.trim());
    const bgHex = HEX_RE.test(bg.trim());
    if (fgHex && bgHex) {
      const ratio = contrastRatio(hexToRgb(fg), hexToRgb(bg));
      if (ratio < 4.5) {
        violations.push({
          severity: 'warning',
          rule: 'low-contrast',
          element: elLabel(el),
          file,
          detail: 'Foreground ' + fg.trim() + ' 对 Background ' + bg.trim() + ' 亮度对比度 ' +
            ratio.toFixed(2) + ' < 4.5（WCAG AA）'
        });
      }
    } else if (/^\{\s*(?:StaticResource|DynamicResource)/.test(fg.trim()) ||
               /^\{\s*(?:StaticResource|DynamicResource)/.test(bg.trim())) {
      state.skippedContrast++;
    }
  }

  // —— warning ④：Window 无 SizeToContent 且 MinWidth/MinHeight 均缺失
  if (win && typeof win.attrs['SizeToContent'] !== 'string' &&
      typeof win.attrs.MinWidth !== 'string' && typeof win.attrs.MinHeight !== 'string') {
    violations.push({
      severity: 'warning',
      rule: 'window-sizing',
      element: elLabel(win),
      file,
      detail: 'Window 未声明 SizeToContent 且 MinWidth/MinHeight 均缺失，窗口自适应尺寸无下限约束'
    });
  }
}

function collectXaml(p, acc) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p).sort()) {
      const fp = path.join(p, e);
      const es = fs.statSync(fp);
      if (es.isDirectory()) collectXaml(fp, acc);
      else if (/\.xaml$/i.test(e)) acc.push(fp);
    }
  } else {
    acc.push(p); // 显式传入的单个文件按 XAML 处理（不校验扩展名）
  }
  return acc;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('wpf-check: 用法 node wpf-check.mjs <.xaml 文件或目录> [more ...]\n');
    process.exit(1);
  }
  const files = [];
  for (const a of args) {
    try {
      collectXaml(a, files);
    } catch (e) {
      process.stderr.write('wpf-check: 无法访问 ' + a + '：' + e.message + '\n');
      process.exit(1);
    }
  }
  const violations = [];
  const state = { skippedContrast: 0 };
  for (const f of files) checkFile(f, violations, state);

  violations.sort((p, q) => (p.severity === q.severity ? 0 : p.severity === 'error' ? -1 : 1));
  const summary = {
    errors: violations.filter((v) => v.severity === 'error').length,
    warnings: violations.filter((v) => v.severity === 'warning').length,
    files: files.length,
    skippedContrast: state.skippedContrast
  };
  process.stdout.write(JSON.stringify({ summary, violations }, null, 2) + '\n');
}

try {
  main();
} catch (e) {
  process.stderr.write('wpf-check: 内部异常：' + (e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
}
