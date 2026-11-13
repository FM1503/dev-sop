// UI 几何信息采集脚本（浏览器端执行，插件：dev-sop）
//
// 用法：通过 ZCode 内置浏览器自动化打开目标页面后，在该页面上下文中 eval 本文件的
// 全部内容（IIFE），它会在页面里执行并返回一个 JSON 字符串。把返回的 JSON 保存为
// 文件（如 geometry.json），再运行 `node ui-analyzer.mjs geometry.json` 做量化验收。
// 注意：本文件必须在浏览器页面上下文中运行（依赖 document/getComputedStyle），
// 不能在 Node.js 中直接执行。
(function () {
  function trunc(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n) : s;
  }
  var viewport = {
    w: window.innerWidth,
    h: window.innerHeight,
    scrollW: document.documentElement.scrollWidth,
    scrollH: document.documentElement.scrollHeight
  };
  var nodes = document.querySelectorAll('*');
  var collected = [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var r = el.getBoundingClientRect();
    if (r.width * r.height === 0) continue;
    var cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    // 只采集视口内的元素（完全出屏跳过：right/bottom <= 0 或 left/top 已越过视口边界）
    if (r.right <= 0 || r.bottom <= 0 || r.left >= viewport.w || r.top >= viewport.h) continue;
    var interactive =
      /^(a|button|input|select|textarea)$/i.test(el.tagName) ||
      typeof el.onclick === 'function' ||
      el.getAttribute('role') === 'button';
    // 最近祖先或自身 overflow-x 为 auto/scroll → 合法横向滚动容器内容
    var hScroll = false;
    for (var p = el; p && p.nodeType === 1; p = p.parentElement) {
      var pcs = p === el ? cs : getComputedStyle(p);
      if (/^(auto|scroll)$/.test(pcs.overflowX)) { hScroll = true; break; }
    }
    collected.push({
      el: el,
      record: {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        className: trunc(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className, 120),
        text: trunc(el.textContent, 20),
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
        zIndex: cs.zIndex === 'auto' ? 0 : parseInt(cs.zIndex, 10) || 0,
        fontSize: parseFloat(cs.fontSize) || 0,
        fg: cs.color,
        bg: cs.backgroundColor,
        interactive: !!interactive,
        position: cs.position,
        hScroll: hScroll
      }
    });
  }
  // 编号并用 WeakMap 建立 element → index，parentIdx = 最近的也被采集的祖先的 index
  var indexByEl = new WeakMap();
  for (var k = 0; k < collected.length; k++) indexByEl.set(collected[k].el, k);
  var elements = [];
  for (var m = 0; m < collected.length; m++) {
    var entry = collected[m];
    var parentIdx = -1;
    for (var anc = entry.el.parentElement; anc && anc.nodeType === 1; anc = anc.parentElement) {
      if (anc === document.documentElement) break; // html 根不算
      if (indexByEl.has(anc)) { parentIdx = indexByEl.get(anc); break; }
    }
    entry.record.parentIdx = parentIdx;
    elements.push(entry.record);
  }
  return JSON.stringify({ viewport: viewport, elements: elements });
})();
