---
slug: <slug>
date: <YYYY-MM-DD>
files-touched: <目标代码文件，逗号分隔的项目相对路径>
---

# 执行书：<任务标题>

## 改动清单

| 序号 | 文件 | 定位行号（Edit 备选用） | 定位（old 文本精确片段，新文件标 NEW） | 改为（new 文本或全文） |
| --- | --- | --- | --- | --- |
| 1 | <项目相对路径> | <如 L120-L126；新文件写 NEW> | <old：与当前文件内容逐字符一致的精确片段；须在文件内唯一> | <new：完整替换文本> |
| 2 | <项目相对路径> | NEW | NEW | <新文件全文> |

## 补丁脚本

默认路径（v1.7.0 补丁直改）：主会话勘探后把逐条 old→new 生成确定性补丁脚本（Python 标准库，无第三方依赖）全文嵌入本节——PATCHES 逐条 `{file, old, new, count, expect_after}`（count 声明出现次数，默认 1；expect_after 仅新文件分支用：写后断言文件存在且含该文本），前置断言（old 出现次数==count）、后置断言（应用后 new 出现次数==count），字节级读写保真（CRLF 归一），任一失败 `exit 1` 并打印该条上下文 ±3 行：

```python
import sys

PATCHES = [
    {"file": "<项目相对路径>", "old": "<old 精确片段>", "new": "<new 文本>", "count": 1},
    # 新文件：{"file": "<路径>", "old": None, "new": "<新文件全文>", "expect_after": "<写后断言应包含的文本>"},
    # 注：new 为空串（纯删除）或 new 预存多处时改用 patch-mode: edit 路径并在执行书注明。
]

def fail(p, msg, lines, hit):  # 打印该条上下文 ±3 行后 exit 1
    ctx = "\n".join("%4d %s" % (i + 1, l) for i, l in enumerate(lines) if abs(i - hit) <= 3)
    print("[patch-direct] FAIL %s: %s\n%s" % (p["file"], msg, ctx))
    sys.exit(1)

for p in PATCHES:
    # CRLF 保真：字节读写+EOL 归一
    if p["old"] is None:  # 新文件分支：字节写 + 后置断言（文件存在且含 expect_after）
        open(p["file"], "wb").write(p["new"].encode("utf-8"))
        data = open(p["file"], "rb").read().decode("utf-8")
        if p.get("expect_after") is None or p["expect_after"] not in data:
            fail(p, "后置断言：新文件不含 expect_after", data.split("\n"), 0)
        continue
    count = p.get("count", 1)  # 声明出现次数（默认 1）
    data = open(p["file"], "rb").read().decode("utf-8")
    if "\r\n" in data:  # 目标文件含 CRLF → old/new 的 \n 归一为 \r\n 再替换
        old, new = p["old"].replace("\n", "\r\n"), p["new"].replace("\n", "\r\n")
    else:
        old, new = p["old"], p["new"]
    n_old = data.count(old)
    if n_old != count:  # 前置断言：old 出现次数==声明值 count
        hit = data.find(old)
        fail(p, "前置断言：old 出现 %d 次（声明 %d）" % (n_old, count),
             data.split("\n"), data[:hit].count("\n") if hit != -1 else 0)
    text = data.replace(old, new)
    if text.count(new) != count:  # 后置断言：new 出现次数==count
        fail(p, "后置断言：new 出现 %d 次（声明 %d）" % (text.count(new), count), text.split("\n"), 0)
    open(p["file"], "wb").write(text.encode("utf-8"))
print("[patch-direct] OK: %d patches applied" % len(PATCHES))
```

## 执行命令

worker 单轮内**一条 Bash 原样执行**本字段（补丁+验证串联，`&&` 保证补丁失败即短路；stdin heredoc，不落盘任何临时文件；禁止改写/拆分/增删步骤）：

```bash
python - <<'PYEOF' && <验证命令，含显式 timeout>
<补丁脚本全文（与上节逐字一致）>
PYEOF
```

补丁不适用场景（新文件全文写入、跨多处的结构性重写等）显式声明 `patch-mode: edit` 走 Edit 备选：按"定位行号"列定向 Read（禁止全文件读入），Edit 锚点用最短唯一片段。

## 执行顺序与验证

| 步骤 | 动作（应用序号 N / 运行命令） | 预期输出（精确） |
| --- | --- | --- |
| 1 | 应用序号 1 | <Edit old→new 成功，无报错> |
| 2 | 应用序号 2 | <Write 新文件成功，无报错> |
| 3 | 运行命令：<命令，含显式 timeout> | <实际输出须逐字符一致，如 "3 passed"> |

<!-- 约束（硬性，主会话产出时遵守）：
     1. old 片段必须与目标文件当前内容逐字符一致——主会话勘探（Read/Grep）时复制，
        禁止手打或凭记忆改写；锚点片段须在文件内唯一。
     2. new 文本为完整替换内容（非意图描述）；新文件（定位 NEW）给全文。
     3. 每步验证命令含显式 timeout（单命令 ≤120000ms），预期输出精确到可逐字符比对。
     4. code-worker 只逐条按序机械应用；old 不匹配 / 锚点缺失 / 预期输出不符 →
        立即停报不重试（前提不符），由主会话修书重发。
     5. S 级任务不建本文件：执行书并入变更单 docs/changes/<slug>.md 的"改动清单"
        表（同样文本级精确 old→new）。 -->
