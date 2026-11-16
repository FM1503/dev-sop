#!/usr/bin/env node
'use strict';

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
  '5) 编码阶段遵循 TDD 并在完成后对抗性自审；编码实现一律通过 Agent 工具委派 code-worker 执行代理完成（插件内置代理名为 dev-sop:code-worker，禁用思考、只执行不决策；若你已配置同名用户级代理则直接使用之），主会话只做决策与验收；' +
  '6) 实现与量化验收完成后，必须委派 reviewer 子代理（插件内置，独立上下文、只读、开思考）对照任务书做四维审查：报告写入 docs/specs/<slug>.review-report.json；fail/pass-with-issues 时整理问题清单委派 code-worker 修复后重审（最多 2 轮，仍未 pass 如实呈报用户仲裁，禁止推荐跳过）；pass 后经用户确认方可定稿；spec 声明 review: required 时 Stop 钩子强制校验报告存在且 verdict=pass；' +
  '7) 若任务涉及界面/UI/LVGL/布局绘制，额外强制：先读插件内置设计规范（references/design-rules.md），spec 中产出 UI 数据表与 ASCII 线框并经用户批准（frontmatter 加 wireframe: approved）后才能写 UI 代码；实现后用 ui-analyzer/lvgl-check 量化校验 error 清零（截图仅备选）；交付时 Stop 钩子强制校验 docs/specs/<slug>.ui-report.json 存在且全部 error=0，未完成量化验收无法结束任务；' +
  '8) 遇到门禁拦截与流程要求冲突（如死锁）时，如实向用户报告冲突详情并等待指示，禁止将"跳过流程"作为推荐选项；.dev-sop-skip 仅在用户明确要求时创建；' +
  '9) 规格文档与线框在请求批准前，必须把全文完整呈现在回复中（长文档可分节完整展示，并附文件路径供用户在编辑器/面板打开核对）；批准必须通过 AskUserQuestion 的选项完成（如 批准/需修改/放弃），禁止让用户手动输入确认消息。线框选项必须用 preview 展示 ASCII 图；' +
  '10) 验收测试遵循测试纪律：金字塔分层（静态→单元→集成→浏览器，后者仅UI项且最少跑）、单命令≤2分钟显式设 timeout、整场≤10分钟、fail-fast 不重跑已绿、迭代只跑受影响测试、禁止后台/监听模式长跑；每条验收标准一个针对性测试，任务书测试计划表之外的测试禁止执行，交付前产出 <slug>.test-report.json；规格批准时 frontmatter 必须声明 code-files（逗号分隔目标代码文件；纯文档任务写 code-files: none），任务书测试计划表必须为五列：验收标准/测试层级/命令/预期输出/预计耗时。';

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

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: CONTEXT_TEXT,
    },
  };
  appendLog('UserPromptSubmit', '', '', 'inject', 'dev intent detected');
  process.stdout.write(JSON.stringify(out) + '\n');
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => {
    appendLog('UserPromptSubmit', '', '', 'pass', 'internal error');
    process.exit(0);
  }
);
