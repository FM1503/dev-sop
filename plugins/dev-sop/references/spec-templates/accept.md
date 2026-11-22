---
accepted: true
slug: <slug>
date: <YYYY-MM-DD>
quoted: "<用户验收原话摘录，如：确认定稿 v1.9.0>"
---

# 用户验收标记：<slug>

> v1.10.0 产物约定。放置位置：`docs/specs/<slug>-accept.md`（spec 任务）或
> `docs/changes/<slug>-accept.md`（变更单任务），同 slug 任一即可。
>
> 用途：主会话在 AskUserQuestion 中收到用户"验收通过 / 定稿"类明确确认后，委派一次秒级写入
> 本文件，作为审查链的结案路径之一（日志 reason=user-accepted），与 review-report 并存时
> 以先满足者为准，二者不互斥。
>
> 硬约束：
>
> - `accepted` 必须为 `true`（其余取值视为无效标记）；
> - `slug` 必须与待结案条目一致（防错配）；
> - `quoted` 必须非空，摘录用户原话（供审计）；
> - **accept 标记不豁免 lint 机器项**——`<slug>.lint-report.json` 缺失或 violations>0 时，
>   标记无效，Stop 钩子仍然 block（先修机器项）。
>
> 正文可留空或一句话说明验收范围；无需评审意见、问题清单等冗余内容。

已验收范围：<一句话：验收的版本 / 功能点>