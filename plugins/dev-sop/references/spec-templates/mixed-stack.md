---
slug: <slug>
status: draft
date: <YYYY-MM-DD>
code-files: <C# 与 .c 文件，逗号分隔的项目相对路径，如 Services/DataService.cs, firmware/panel.c>
ui-files: <.xaml 与 .c 文件，逗号分隔的项目相对路径，如 MainWindow.xaml, firmware/panel.c>
review: required
---

# <混合栈项目名>（C# 服务层 + WPF 表现层 + LVGL 固件层）

## 层架构

三层清单（本表内容须同步落到项目根 `docs/architecture.md`——spec 与缺陷排查必读约定，缺陷定位流程见 stages-detail 第 1.4 节阶段 0.7）：

| 层 | 技术栈 | 职责 | 文件 | 测试命令 |
| --- | --- | --- | --- | --- |
| C# 服务层 | .NET | <业务逻辑 / 数据处理 / 与固件通信，一句话可验证的职责描述> | <如 Services/DataService.cs> | `dotnet test <测试项目路径>` |
| WPF 表现层 | XAML / .NET | <桌面界面：数据绑定 / 事件 / 交互> | <如 MainWindow.xaml> | `node <插件目录>/scripts/wpf-check.mjs <xaml 文件或目录>` |
| LVGL 固件层 | C / LVGL | <嵌入式界面显示与绘制> | <如 firmware/panel.c> | `node <插件目录>/hooks/lvgl-check.mjs <.c 文件>` |

## 跨层数据流

每个跨层数据项一行，按链路列全产出→绑定→显示三段；缺陷定位"显示与数据不一致"时逐行核对找断点层：

| 数据项 | C# 侧产出 | WPF 绑定/事件 | LVGL 显示 |
| --- | --- | --- | --- |
| <如：当前温度> | <DataService.ReadTemp() 返回 double> | <TextBox Text="{Binding Temp}"> | <lv_label_set_text(temp_label, buf)> |

## 各层验收清单

- [ ] C# 服务层：`dotnet test` 全绿（0 failed）
- [ ] WPF 表现层：`wpf-check.mjs <xaml>` 全部 error=0（warning 逐条说明取舍）
- [ ] LVGL 固件层：`lvgl-check.mjs <.c>` 全部 error=0
- [ ] 跨层回归：改任一层后相邻层验收命令照常全绿（C#↔WPF↔LVGL，见阶段 0.7 第 4 步）

## 测试计划表

| 验收标准 | 测试层级(静态/单元/集成/浏览器) | 命令 | 预期输出 | 预计耗时 |
| --- | --- | --- | --- | --- |
| <对应各层验收清单 C# 行> | 单元 | dotnet test <测试项目路径> | <Passed! - Failed: 0> | <120s> |
| <对应 WPF 行> | 静态 | node <插件目录>/scripts/wpf-check.mjs <xaml 文件或目录> | <summary.errors=0> | <10s> |
| <对应 LVGL 行> | 静态 | node <插件目录>/hooks/lvgl-check.mjs <.c 文件> | <summary.errors=0> | <10s> |
