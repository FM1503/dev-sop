'use strict';
// wpf-check.test.js — dev-sop v1.9.0 混合栈规格 2.A：WPF XAML 静态校验器黑盒单测
// 规则来源：docs/specs/mixed-stack.md 2.A / docs/tasks/mixed-stack-core-exec.md 序号 2
// 黑盒方式：spawn `node scripts/wpf-check.mjs <tmp xaml>`，解析 stdout JSON，按 rule 过滤断言。
// 覆盖：error（canvas-overlap 命中/包含豁免/≤4px² 豁免、out-of-bounds Window 帧/1px 容差/Canvas 帧、
//   missing-resource 命中/存在放行）；warning（low-contrast 命中/放行/skippedContrast、
//   hardcoded-px 命中/放行、grid-zindex 命中/放行、window-sizing 两态）；
//   解析容错（注释/自闭合/x: 前缀/闭合乱序）、目录递归+解析失败跳过、CLI 错误 exit 1。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WPF_CHECK = path.join(__dirname, '..', 'scripts', 'wpf-check.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wpf-check-'));
}

function runWpf(args) {
  return spawnSync(process.execPath, [WPF_CHECK].concat(args), {
    timeout: 20000,
    encoding: 'utf8',
  });
}

function runXaml(content) {
  const dir = tmpDir();
  const p = path.join(dir, 't.xaml');
  fs.writeFileSync(p, content, 'utf8');
  const r = runWpf([p]);
  assert.strictEqual(r.status, 0, '期望 exit 0，stderr：' + r.stderr);
  return JSON.parse(r.stdout);
}

function hits(result, rule) {
  return result.violations.filter((v) => v.rule === rule);
}

function doc(winAttrs, inner) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<Window xmlns="https://schemas.microsoft.com/winfx/2006/xaml/presentation"' +
    ' xmlns:x="https://schemas.microsoft.com/winfx/2006/xaml" ' + winAttrs + '>\n' +
    inner + '\n</Window>\n'
  );
}

// ---- error ①：canvas-overlap ----

test('wpf-check：同 Canvas 直接子元素矩形交叠>4px² 且互不包含 → canvas-overlap 命中', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="100" Height="100"/>
    <Rectangle Canvas.Left="50" Canvas.Top="20" Width="100" Height="100"/>
  </Canvas>`)
  );
  const v = hits(result, 'canvas-overlap');
  assert.strictEqual(v.length, 1, '重叠 50x80=4000px² 须命中 1 条');
  assert.strictEqual(v[0].severity, 'error');
  assert.ok(v[0].detail.includes('4000px²'), 'detail 须含交叠面积，实际：' + v[0].detail);
});

test('wpf-check：完整包含豁免（A 包含 B，互不包含条件不满足）→ 无 canvas-overlap', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="100" Height="100"/>
    <Rectangle Canvas.Left="10" Canvas.Top="10" Width="80" Height="80"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(result, 'canvas-overlap').length, 0);
});

test('wpf-check：交叠面积≤4px² 豁免 → 无 canvas-overlap', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="10" Height="10"/>
    <Rectangle Canvas.Left="9" Canvas.Top="9" Width="10" Height="10"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(result, 'canvas-overlap').length, 0, '1px² ≤ 4px² 须豁免');
});

// ---- error ②：out-of-bounds ----

test('wpf-check：子元素超 Window 声明 Width（Canvas 无自身尺寸按 Window 帧）→ out-of-bounds 命中', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Button Canvas.Left="180" Canvas.Top="10" Width="40" Height="20" Content="x"/>
  </Canvas>`)
  );
  const v = hits(result, 'out-of-bounds');
  assert.strictEqual(v.length, 1, '右缘 220 > 200+1 须命中');
  assert.ok(v[0].detail.includes('Window'), 'detail 须指明 Window 帧，实际：' + v[0].detail);
});

test('wpf-check：越界容差 1px（右缘 201 放行、202 命中）', () => {
  const ok = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Button Canvas.Left="161" Canvas.Top="10" Width="40" Height="20" Content="x"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(ok, 'out-of-bounds').length, 0, '201==200+1 容差内须放行');
  const bad = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Button Canvas.Left="162" Canvas.Top="10" Width="40" Height="20" Content="x"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(bad, 'out-of-bounds').length, 1, '202>201 须命中');
});

test('wpf-check：父 Canvas 声明自身 Width/Height 时按 Canvas 帧判定（不再叠加 Window 帧）', () => {
  const result = runXaml(
    doc('Width="800" Height="600" MinWidth="100" MinHeight="50"', `
  <Canvas Width="100" Height="100">
    <Button Canvas.Left="80" Canvas.Top="10" Width="40" Height="20" Content="x"/>
  </Canvas>`)
  );
  const v = hits(result, 'out-of-bounds');
  assert.strictEqual(v.length, 1, '80+40=120 超 Canvas 宽 100+1，且在 Window 内 → 仅 1 条');
  assert.ok(v[0].detail.includes('Canvas'), 'detail 须指明 Canvas 帧，实际：' + v[0].detail);
});

// ---- error ③：missing-resource ----

const RES_DICT = `
  <Window.Resources>
    <ResourceDictionary>
      <SolidColorBrush x:Key="KnownBrush" Color="#111111"/>
    </ResourceDictionary>
  </Window.Resources>`;

test('wpf-check：StaticResource/DynamicResource 引用不存在 Key → missing-resource 命中（两种均计）', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', RES_DICT + `
  <StackPanel>
    <TextBlock Foreground="{StaticResource NoKey1}" Text="a"/>
    <Label Background="{DynamicResource NoKey2}" Content="b"/>
  </StackPanel>`)
  );
  const v = hits(result, 'missing-resource');
  assert.strictEqual(v.length, 2, 'NoKey1/NoKey2 须各命中一条');
  assert.ok(v.every((x) => x.severity === 'error'));
});

test('wpf-check：引用本文件 x:Key 已声明资源 → 无 missing-resource', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', RES_DICT + `
  <StackPanel>
    <TextBlock Foreground="{StaticResource KnownBrush}" Text="a"/>
    <Label Background="{DynamicResource KnownBrush}" Content="b"/>
  </StackPanel>`)
  );
  assert.strictEqual(hits(result, 'missing-resource').length, 0);
});

// ---- warning ③：low-contrast / skippedContrast ----

test('wpf-check：#777777 on #888888 对比度<4.5 → low-contrast 命中', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <StackPanel>
    <TextBlock Foreground="#777777" Background="#888888" Text="灰上灰"/>
  </StackPanel>`)
  );
  const v = hits(result, 'low-contrast');
  assert.strictEqual(v.length, 1);
  assert.strictEqual(result.summary.skippedContrast, 0);
  assert.ok(parseFloat(v[0].detail.match(/对比度 ([\d.]+)/)[1]) < 4.5, 'detail 须给出实测比值');
});

test('wpf-check：#FFFFFF on #000000 高对比 → 无 low-contrast', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <StackPanel>
    <TextBlock Foreground="#FFFFFF" Background="#000000" Text="高对比"/>
  </StackPanel>`)
  );
  assert.strictEqual(hits(result, 'low-contrast').length, 0);
});

test('wpf-check：色值引用资源（非十六进制）→ 跳过计数 skippedContrast，不判对比度', () => {
  const result = runXaml(
    doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', RES_DICT + `
  <StackPanel>
    <TextBlock Foreground="{StaticResource KnownBrush}" Background="#888888" Text="引用色"/>
  </StackPanel>`)
  );
  assert.strictEqual(hits(result, 'low-contrast').length, 0);
  assert.strictEqual(result.summary.skippedContrast, 1);
});

// ---- warning ①：hardcoded-px 占比 ----

test('wpf-check：全数值尺寸占比 100%>70% → hardcoded-px 命中', () => {
  const result = runXaml(
    doc('Width="400" Height="300" MinWidth="100" MinHeight="50"', `
  <StackPanel>
    <Rectangle Width="50" Height="20"/>
    <Rectangle Width="60" Height="20"/>
    <Rectangle Width="70" Height="20"/>
    <Rectangle Width="80" Height="20"/>
    <Rectangle Width="90" Height="20"/>
  </StackPanel>`)
  );
  assert.strictEqual(hits(result, 'hardcoded-px').length, 1);
});

test('wpf-check：Auto/star/Viewbox 充足（占比≤70%）→ 无 hardcoded-px', () => {
  const result = runXaml(
    doc('Width="Auto" Height="Auto" MinWidth="Auto" MinHeight="Auto"', `
  <StackPanel>
    <TextBlock Width="Auto" Height="Auto" Text="a"/>
    <TextBlock Width="Auto" Height="Auto" Text="b"/>
    <Viewbox/>
  </StackPanel>`)
  );
  assert.strictEqual(hits(result, 'hardcoded-px').length, 0);
});

// ---- warning ②：grid-zindex ----

test('wpf-check：同 Grid Cell 多子元素无 Panel.ZIndex → grid-zindex 命中；声明 ZIndex 后放行', () => {
  const inner = `
  <Grid>
    <Grid.ColumnDefinitions><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
    <Border Width="100" Height="80" Background="#FF0000"/>
    <Border Width="120" Height="60" Background="#00FF00"/>
  </Grid>`;
  const bad = runXaml(doc('Width="400" Height="300" MinWidth="100" MinHeight="50"', inner));
  assert.strictEqual(hits(bad, 'grid-zindex').length, 1, '双 Border 同 Cell(0,0) 无 ZIndex 须命中');
  const okInner = inner.replace(
    '<Border Width="120"',
    '<Border Panel.ZIndex="1" Width="120"'
  );
  const ok = runXaml(doc('Width="400" Height="300" MinWidth="100" MinHeight="50"', okInner));
  assert.strictEqual(hits(ok, 'grid-zindex').length, 0, '任一子元素声明 Panel.ZIndex 须放行');
});

// ---- 解析容错：注释/自闭合/x: 前缀/闭合乱序/嵌套归属 ----

test('wpf-check：注释伪元素忽略、闭合乱序回溯容错、嵌套 Canvas 归属正确 → 不崩溃且仅内层重叠命中', () => {
  const result = runXaml(
    doc('Width="400" Height="300" MinWidth="100" MinHeight="50"', `
  <Grid>
    <Canvas>
      <!-- <Rectangle Canvas.Left="0" Canvas.Top="0" Width="500" Height="500"/> 注释内伪重叠 -->
      <StackPanel>
        <Canvas>
          <Rectangle x:Name="inner" Canvas.Left="5" Canvas.Top="5" Width="40" Height="10"/>
          <Rectangle x:Name="inner2" Canvas.Left="20" Canvas.Top="5" Width="40" Height="10"/>
        </Canvas>
      </StackPanel>
      <Rectangle Canvas.Left="0" Canvas.Top="0" Width="20" Height="20"/>
      <Rectangle Canvas.Left="30" Canvas.Top="0" Width="20" Height="20"/>
    </Grid>
    <TextBlock x:Name="afterMismatch" Text="闭合乱序后元素仍归属"/>
  </Grid>`)
  );
  assert.strictEqual(hits(result, 'parse-skipped').length, 0, '乱序闭合须容错而非判解析失败');
  const v = hits(result, 'canvas-overlap');
  assert.strictEqual(v.length, 1, '外 Canvas/注释矩形不重叠，仅内层 25x10=250px² 命中');
  assert.ok(v[0].element.includes('inner'), '命中元素须为内层 inner，实际：' + v[0].element);
});

// ---- 目录递归 + 解析失败单文件跳过 ----

test('wpf-check：目录递归找 *.xaml；解析失败文件记 parse-skipped warning 跳过；非 xaml 忽略', () => {
  const dir = tmpDir();
  const good = doc('Width="200" Height="100" MinWidth="100" MinHeight="50"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="20" Height="20"/>
  </Canvas>`);
  fs.writeFileSync(path.join(dir, 'good.xaml'), good, 'utf8');
  fs.writeFileSync(path.join(dir, 'bad.xaml'), 'this is not < xaml at all', 'utf8');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'note.txt'), '<Rectangle/>', 'utf8');
  const r = runWpf([dir]);
  assert.strictEqual(r.status, 0);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.summary.files, 2, '仅递归收集 2 个 .xaml');
  const v = hits(result, 'parse-skipped');
  assert.strictEqual(v.length, 1, 'bad.xaml 须记 1 条 parse-skipped warning');
  assert.strictEqual(v[0].severity, 'warning');
  assert.strictEqual(result.summary.errors, 0, 'good.xaml 无 error，未因跳过中断');
});

// ---- CLI 错误：fail-fast exit 1 ----

test('wpf-check：无参数 → exit 1 且 stderr 含用法；路径不存在 → exit 1', () => {
  const r1 = runWpf([]);
  assert.strictEqual(r1.status, 1);
  assert.ok(r1.stderr.includes('用法'), 'stderr 须含用法，实际：' + r1.stderr);
  const r2 = runWpf([path.join(tmpDir(), 'nope', 'missing.xaml')]);
  assert.strictEqual(r2.status, 1);
});

// ---- warning ④：window-sizing 两态 ----

test('wpf-check：Window 无 SizeToContent 且 Min 均缺失 → window-sizing 命中；补齐后放行', () => {
  const bad = runXaml(
    doc('Width="200" Height="100"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="20" Height="20"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(bad, 'window-sizing').length, 1);
  const ok = runXaml(
    doc('Width="200" Height="100" SizeToContent="WidthAndHeight"', `
  <Canvas>
    <Rectangle Canvas.Left="0" Canvas.Top="0" Width="20" Height="20"/>
  </Canvas>`)
  );
  assert.strictEqual(hits(ok, 'window-sizing').length, 0);
});
