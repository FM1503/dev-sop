# docs/context/ 账本模板（dev-sop v1.11.0）

项目建账本时把下列五份骨架复制到 `docs/context/`（占位符替换为实际内容）。
预算：单卡 ≤150 行、INDEX ≤60 行；超限把最旧节移入 `docs/context/archive/<card>-<yyyymm>.md` 并更新 INDEX。
CODEMAP.md 为覆写式（永远反映现状）；DECISIONS.md / GOTCHAS.md 只追加；ACTIVE.md 定稿即清节。

## INDEX.md

    # 上下文账本索引
    > 协议：按行取卡，禁止一次全读五卡。ACTIVE=进行中任务，DECISIONS=决策史，CODEMAP=代码结构，GOTCHAS=坑与教训。
    | 卡 | 一句话摘要 | 行数 |
    | --- | --- | --- |
    | ACTIVE.md | 进行中：<slug>@<阶段> | <N> |
    | DECISIONS.md | 决策 <n> 条（最新：<slug>） | <N> |
    | CODEMAP.md | <模块概览一句话> | <N> |
    | GOTCHAS.md | 坑 <n> 条 | <N> |

## ACTIVE.md

    # 进行中任务

    ## <slug>（YYYY-MM-DD）
    - 阶段：spec 批准 / 实现中 / 待审查 / 待验收
    - 下一步：<一句话具体动作>
    - 指针：docs/specs/<slug>.md、docs/tasks/<slug>.md、关键代码文件…
    - 已知上下文：<影响下一步的在脑信息，写全>

## DECISIONS.md

    # 决策史（只追加）
    - YYYY-MM-DD <slug>｜背景… → 结论… → 影响…

## CODEMAP.md

    # 代码结构认知（覆写式）
    - 入口：…
    - 模块：A=职责；B=职责
    - 数据流：…

## GOTCHAS.md

    # 坑与教训（只追加）
    - YYYY-MM-DD <slug>｜现象 → 根因 → 规避法

## archive/（目录，超限归档时创建）