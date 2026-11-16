#!/usr/bin/env node
'use strict';
// inject.js — UserPromptSubmit 注入 + 会话级闩锁（v1.2.0 token 节流）
// 规则来源：docs/specs/efficiency-optimization.md 2.A + docs/specs/tier-routing.md 2.6（第 11 条）：
//   同 session 首轮输出十一条纪律全文（末尾追加一句提醒句）并写闩锁文件；
//   次轮起仅输出一行提醒；无 session 字段回退现状全量注入（fail-open）；
//   创建闩锁时清理同目录 mtime>48h 的 dev-sop-inject-*.latch。
//   闩锁写失败（catch 分支）时下一轮仍会全文注入，故本轮输出回退纯
//   CONTEXT_TEXT（不带提醒句）——提示句仅在闩锁确认落盘后追加（P2-1）。

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEV_INTENT_RE =
  /(开发|编写|写一个|做一个|做一个|实现|新增|帮我.{0,8}(做|写|开发|实现|建)|build|create|implement|develop|write me)/i;

const CONTEXT_TEXT =
  '检测到开发需求。在编写任何代码前，必须严格遵守 dev-sop 流程：' +
  '1) 用 AskUserQuestion 分至少 2 批（每批≤4问）澄清需求，必须覆盖：核心功能清单、界面外观与交互预期、非功能要求（性能/平台）、边界情况与验收标准——外观和功能未被用户明确描述前禁止臆测；' +
  '2) 用 WebSearch/WebFetch 联网调研成熟案例与最佳实践，关键结论附来源链接；' +
  '3) 产出 docs/specs/<slug>.md（frontmatter status: draft），经用户批准改为 status: approved 后方可编码；' +
  '4) 委派 code-worker 前必须先产出 docs/tasks/<slug>.md 任务书（含目标文件、期望行为、验收标准），且委派 prompt 中必须写明任务书路径；' +
  '5) 编码阶段遵循 TDD 并在完成后对抗性自审；编码实现一律通过 Agent 工具委派 code-worker 执行代理完成（插件内置代理名为 dev-sop:code-worker，禁用思考、只执行不决策；若你已配置同名用户级代理则直接使用之），主会话只做决策与验收；编码实现前主会话必须亲自勘探（Read/Grep）目标文件现状并产出执行书 docs/tasks/<slug>-exec.md（文本级精确 old→new+每步验证命令与预期输出；S 级并入变更单改动清单），委派 prompt 引用执行书路径；code-worker 只机械应用，不匹配即停报不重试；非编码任务或用户明确豁免时在委派 prompt 标 exec-plan: exempt；验收类委派（review/ui/test-report 输出）自动豁免；' +
  '6) 实现完成后进入审查：与量化验收自动闭环同消息并发委派 reviewer 子代理（插件内置，独立上下文、只读、开思考）对照任务书做四维审查：报告写入 docs/specs/<slug>.review-report.json；委派 reviewer 时提供改动文件清单与 diff 获取方式（git 命令或直接附 diff）；verdict 须为 pass 或 pass-with-issues（fail 须修复重审，pass-with-issues 须经用户确认定稿）；fail 时整理问题清单委派 code-worker 修复后重审（最多 2 轮，仍未 pass 如实呈报用户仲裁，禁止推荐跳过）；pass 或 pass-with-issues 均须经 AskUserQuestion 呈报用户、经确认方可定稿；spec 声明 review: required 时 Stop 钩子强制校验报告存在且 verdict 合规；' +
  '7) 若任务涉及界面/UI/LVGL/布局绘制，额外强制：先读插件内置设计规范（references/design-rules.md），spec 中产出 UI 数据表与 ASCII 线框并经用户批准（frontmatter 加 wireframe: approved）后才能写 UI 代码；实现后用 ui-analyzer/lvgl-check 量化校验 error 清零（截图仅备选）；交付时 Stop 钩子强制校验 docs/specs/<slug>.ui-report.json 存在且全部 error=0，未完成量化验收无法结束任务；' +
  '8) 遇到门禁拦截与流程要求冲突（如死锁）时，如实向用户报告冲突详情并等待指示，禁止将"跳过流程"作为推荐选项；.dev-sop-skip 仅在用户明确要求时创建；' +
  '9) 规格文档与线框在请求批准前，必须把全文完整呈现在回复中（长文档可分节完整展示，并附文件路径供用户在编辑器/面板打开核对）；批准必须通过 AskUserQuestion 的选项完成（如 批准/需修改/放弃），禁止让用户手动输入确认消息。线框选项必须用 preview 展示 ASCII 图；' +
  '10) 验收测试遵循测试纪律：金字塔分层（静态→单元→集成→浏览器，后者仅UI项且最少跑）、单命令≤2分钟显式设 timeout、整场≤10分钟、fail-fast 不重跑已绿、迭代只跑受影响测试、禁止后台/监听模式长跑；每条验收标准一个针对性测试，任务书测试计划表之外的测试禁止执行，交付前产出 <slug>.test-report.json；规格批准时 frontmatter 必须声明 code-files（逗号分隔目标代码文件；纯文档任务写 code-files: none），任务书测试计划表必须为五列：验收标准/测试层级/命令/预期输出/预计耗时；' +
  '11) 分级路由：收到开发需求先按判据定级——S（≤2 文件且净变更<30 行且无新建文件且无接口/依赖/配置变更且不涉 UI/LVGL 文件）走单问快速通道（AskUserQuestion 单问批准后写 docs/changes/<slug>.md 变更单，frontmatter status: approved + tier: S，免任务书/调研/线框/量化验收，reviewer 快审产出 docs/changes/<slug>.review-report.json），禁止小改套全流程；M（单项目内功能调整）走精简四步（1 批澄清≤3 问 + 加长变更单含 tier: M + 受影响测试单条 test-report + reviewer 快审）；L（新功能/新项目/任何 UI 或 LVGL 界面变更/跨模块）才走全量流程；判据不含 UI 文件——涉 UI 一律 ≥M 线框或 L 全量。';

// v1.2.0 闩锁常量（导出供单测校验）
const LATCH_HOME_RELATIVE_DIR = path.join('.zcode', 'hooks');
const LATCH_FILE_PREFIX = 'dev-sop-inject-';
const LATCH_FILE_SUFFIX = '.latch';
const LATCH_FILE_RE = new RegExp(
  '^' + LATCH_FILE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.+\\.latch$'
);
const LATCH_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const LATCH_NOTICE = '本会话后续轮次将以一行提醒替代全文。';
const REMINDER_TEXT =
  'dev-sop：十一条流程纪律已于本会话注入，继续严格遵守（关键标记：status/wireframe: approved、docs/changes 变更单与 tier S/M、' +
  '执行书 docs/tasks/<slug>-exec.md 与 exec-plan: exempt、ui/test/review-report.json、单命令≤2min、reviewer 独立审查）；细节遗忘时重读 spec 与任务书。';

// ---- 纯函数（导出供单测；不触碰 stdin/stdout/文件系统副作用） ----

// 兼容 session_id / sessionId；非字符串/空白/缺失 → null（回退全量注入）
function extractSessionId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates =
    typeof payload.session_id === 'string' && payload.session_id.trim() !== ''
      ? [payload.session_id]
      : typeof payload.sessionId === 'string' && payload.sessionId.trim() !== ''
        ? [payload.sessionId]
        : [];
  return candidates.length > 0 ? candidates[0] : null;
}

// sessionId → 文件名安全片段（去路径分隔/穿越/Windows 非法字符，限长）
function sanitizeSessionId(id) {
  const s = String(id)
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return s.length > 0 ? s : 'unknown';
}

function latchFileFor(sessionId, homeDir) {
  const home = homeDir || os.homedir();
  return path.join(
    home,
    LATCH_HOME_RELATIVE_DIR,
    LATCH_FILE_PREFIX + sanitizeSessionId(sessionId) + LATCH_FILE_SUFFIX
  );
}

// 注入决策：无 id → inject（现状全文）；首轮 → inject-full（全文+提醒句，写闩锁）；次轮 → inject-reminder（一行）
function decideInjection(sessionId, latchExists) {
  if (!sessionId) {
    return { decision: 'inject', text: CONTEXT_TEXT, createLatch: false };
  }
  if (!latchExists) {
    return { decision: 'inject-full', text: CONTEXT_TEXT + LATCH_NOTICE, createLatch: true };
  }
  return { decision: 'inject-reminder', text: REMINDER_TEXT, createLatch: false };
}

// 输出文本裁决（P2-1）：inject-full 且闩锁未成功落盘 → 回退纯 CONTEXT_TEXT（不带提示句）。
// 闩锁写失败时下一轮仍会全文注入，提示句与实际行为不符，故仅在写闩锁成功后才保留。
function outputTextFor(plan, latchPersisted) {
  if (plan && plan.decision === 'inject-full' && !latchPersisted) {
    return CONTEXT_TEXT;
  }
  return plan ? plan.text : '';
}

// 扫描 dir 下 mtime > maxAgeMs 的闩锁文件，返回绝对路径列表
function staleLatchFiles(dir, nowMs, maxAgeMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const maxAge = typeof maxAgeMs === 'number' ? maxAgeMs : LATCH_MAX_AGE_MS;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  const stale = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!LATCH_FILE_RE.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const mtime = fs.statSync(full).mtimeMs;
      if (now - mtime > maxAge) stale.push(full);
    } catch (e) {
      // unreadable latch: ignore
    }
  }
  return stale.sort();
}

// 删除过期闩锁，返回删除数（fail-open，任何错误不外抛）
function cleanStaleLatches(dir, nowMs, maxAgeMs) {
  let removed = 0;
  for (const file of staleLatchFiles(dir, nowMs, maxAgeMs)) {
    try {
      fs.unlinkSync(file);
      removed++;
    } catch (e) {
      // already gone: fine
    }
  }
  return removed;
}

// ---- hook 主体 ----

function appendLog(event, tool, target, decision, reason) {
  try {
    const dir = path.join(os.homedir(), '.zcode', 'hooks');
    fs.mkdirSync(dir, { recursive: true });
    const line =
      new Date().toISOString() +
      ' | 事件=' + event +
      ' | tool=' + String(tool || '').replace(/[\r\n|]/g, ' ') +
      ' | target=' + String(target || '').replace(/[\r\n|]/g, ' ') +
      ' | decision=' + decision +
      ' | reason=' + String(reason || '').replace(/[\r\n|]/g, ' ') +
      '\n';
    fs.appendFileSync(path.join(dir, 'dev-sop.log'), line, 'utf8');
  } catch (e) {
    // Logging must never affect the hook.
  }
}

function existsSyncSafe(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    if (stdin.isTTY) {
      resolve('');
      return;
    }
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 5000);
  });
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    appendLog('UserPromptSubmit', '', '', 'pass', 'invalid stdin JSON');
    return 0;
  }

  const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt : '';
  if (!prompt || !DEV_INTENT_RE.test(prompt)) {
    appendLog('UserPromptSubmit', '', '', 'pass', 'no dev intent');
    return 0;
  }

  const sessionId = extractSessionId(payload);
  const latchFile = sessionId ? latchFileFor(sessionId) : null;
  const plan = decideInjection(sessionId, latchFile ? existsSyncSafe(latchFile) : false);

  let latchPersisted = true;
  if (plan.createLatch && latchFile) {
    try {
      fs.mkdirSync(path.dirname(latchFile), { recursive: true });
      cleanStaleLatches(path.dirname(latchFile));
      fs.writeFileSync(latchFile, new Date().toISOString() + '\n', 'utf8');
    } catch (e) {
      // fail-open：闩锁未落盘 → 下一轮仍会全文注入，本轮输出回退纯 CONTEXT_TEXT（不带提示句），不阻断
      latchPersisted = false;
    }
  }

  const reason =
    plan.decision === 'inject-reminder' ? 'latch hit, reminder only'
      : plan.decision === 'inject-full' ? 'dev intent detected, first turn in session'
        : 'dev intent detected, no session id';
  appendLog('UserPromptSubmit', '', '', plan.decision, reason);

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: outputTextFor(plan, latchPersisted),
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

// 直接运行时执行注入；被 require（单测）时仅导出纯函数与常量
if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    () => {
      appendLog('UserPromptSubmit', '', '', 'pass', 'internal error');
      process.exit(0);
    }
  );
}

module.exports = {
  DEV_INTENT_RE,
  CONTEXT_TEXT,
  LATCH_HOME_RELATIVE_DIR,
  LATCH_FILE_PREFIX,
  LATCH_FILE_RE,
  LATCH_MAX_AGE_MS,
  LATCH_NOTICE,
  REMINDER_TEXT,
  extractSessionId,
  sanitizeSessionId,
  latchFileFor,
  decideInjection,
  outputTextFor,
  staleLatchFiles,
  cleanStaleLatches,
};
