# 给痛苦一个名字 · 网页版

把“说不清的情绪”变成可以命名的概念，再给出可执行的下一步。

三个板块：**识别与命名 → 理解与探索 → 行动与成长**。当前为无构建静态网页 + 一个 Node 服务端（负责静态托管与模型代理）。小程序代码已归档到 `miniapp` 分支，不参与本仓库构建。

- 线上地址：https://37ku59d503hb0iixfmp.traesite.cn
- 当前版本：0.1.5

---

## 快速开始

前置：Node.js 20+。模型 Key 只放在本地文件或环境变量里，**不要提交到仓库**。

```bash
# 1. 写入 Key（二选一）
#    a. 仓库根目录新建 llm.key，内容为智谱 API Key（已被 .gitignore 忽略）
#    b. 设置环境变量 LLM_API_KEY

# 2. 启动
npm start
# 浏览器打开 http://127.0.0.1:8123
```

Windows 也可以双击 `启动预览.cmd` 或运行 `start.ps1`，脚本会检查 Key 并打开浏览器。

可选环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `LLM_API_KEY` | 空 | 智谱 Key，缺省时读取 `llm.key` |
| `LLM_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` | OpenAI 兼容接口地址 |
| `LLM_MODEL` | `glm-4-flash` | 模型名 |
| `PORT` | `8123` | 端口（云端由平台注入） |
| `HOST` | `127.0.0.1` | 云端设为 `0.0.0.0` |

---

## 目录结构

```
index.html                 页面骨架（三个板块）
assets/css/style.css       样式
assets/js/data.js          概念库数据（自动生成，勿手改）
assets/js/engine.js        本地识别引擎：关键词匹配、候选生成、兜底
assets/js/ai.js            模型调用层：/api/identify、/api/report
assets/js/app.js           交互与状态机：对话、候选卡、报告渲染

server.mjs                 零依赖服务端：静态托管 + 模型代理 + 概念库读取
data/concepts.json         概念库唯一数据源（14 条）
data/inbox/                飞书导出的 CSV 放这里
tools/build-data.mjs       concepts.json → assets/js/data.js
tools/import-feishu.mjs    飞书 CSV → concepts.json（自动触发构建）

eval/                      离线评测：知识库、场景语料、匹配集、报告与覆盖分析
llm.key                    本地 Key（不提交）
```

---

## 数据流

```
飞书多维表格（编辑正文 / 审核状态）
  → 导出 CSV 放进 data/inbox/
  → npm run sync:concepts
  → data/concepts.json
  → npm run data:build
  → assets/js/data.js（前端只拿到展示所需字段）
```

结构化字段（`signals` 关键词、`sources` 文献、`evidence` 证据、`links`、`nearby`、`directions`）**只存在于 `concepts.json`**，不经飞书表格维护，导入时不会被覆盖。原因：改文案不该破坏匹配逻辑。

常用命令：

| 命令 | 作用 |
|---|---|
| `npm run data:build` | 生成前端数据文件 |
| `npm run data:check` | 校验生成文件是否最新（不一致时退出码 1） |
| `npm run sync:concepts` | 导入 `data/inbox/` 最新 CSV 并自动构建 |
| `npm run data:fields` | 打印建议的飞书表格列 |
| `npm run data:export` | 从 data.js 反向导出 concepts.json（迁移用） |

---

## 识别流程

1. 用户在首屏输入一段描述；
2. 前端按固定顺序逐题追问（关系情境 → 情绪命名 → 念头 → 行为 → 身体 → 表情语气 → 愿望），可跳过；
3. 每轮把「原始描述 + 已回答内容」发给 `/api/identify`；
4. 服务端先用信号词检索候选池（最多 8 个），再让模型排序、给出理由；
5. 服务端确定性闸门判断信息是否足够：四项信息（事件 / 情绪 / 行为或身体 / 关系）齐全或已追问过一轮，就不再追问；
6. 信息足够时返回 3–4 个候选概念卡（名称 + 一句话 + 场景）；不足时继续追问或说明暂时无法可靠匹配；
7. 状态机在 `assets/js/app.js` 的 `State.record.status`：`collecting → thinking → followup → awaiting_choice / insufficient_information → confirmed`。

## 板块二：五步探索

确认概念后，不再一次性生成长报告，而是五页连续流程（`record.understand` 保存进度）：

| 页 | 内容 | 数据来源 |
|---|---|---|
| 1 共鸣确认 | 用用户原话 + 概念场景组成一句共鸣语，选择「是，这很像我 / 不太像」 | 本地模板 |
| 2 理解概念 | 专业定义、通俗解释、生活化例子；来源、证据、适用边界折叠在详情里 | `concepts.json` |
| 3 描述场景 | 按概念配置的 3 个引导问题（`sceneQuestions`），可跳过 | 概念数据 |
| 4 概念解释经历 | 区分「你说过的 / 与概念的相似之处 / 无法确定的」，可点「一部分不对」再解释 | `/api/interpret` |
| 5 触发情境 | 3 个情境选项（`situationOptions`）+ 自由输入，生成一句情境总结请用户确认 | 本地模板 |

第 4 页失败时用本地规则给一个保守版本，不会卡住流程。

## 板块三：六步行动

板块三沿用第 5 页确认的情境，不重复采集已知信息（`record.growth`）：

| 页 | 内容 |
|---|---|
| 1 承接理解 | 复述确认过的情境，说明练习不代表责任都在用户 |
| 2 选择方向 | 来自概念的 `directions`（3 个） |
| 3 查看练习 | 每个方向最多 3 张练习卡：适用情境（个性化）/ 具体行动 / 练习目的 |
| 4 我的清单 | 用户主动加入的练习，可记录、暂停、移除、和 AI 聊 |
| 5 反馈与调整 | 四种反馈（有帮助 / 不太适合 / 没能尝试 / 想补充），AI 先回应，替代练习需用户确认才加入 |
| 6 回顾 | 基于真实记录生成简短回顾 + 一句待确认的个人提醒 |

不设打卡、连续天数、积分或未完成提醒；「这次没能尝试」不会被标记为失败。

---

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 服务状态、模型名、概念库条数 |
| GET | `/api/concepts/stats` | 概念库统计与 id/名称列表 |
| POST | `/api/identify` | 识别：候选（信息足够时 3–4 个）+ 追问 |
| POST | `/api/interpret` | 板块二第 4 页：把具体场景与概念对应，区分事实 / 可能解释 / 未知 |
| POST | `/api/report` | 旧版长报告接口（保留兼容，当前页面不再调用） |
| POST | `/api/chat` | 通用模型代理，板块三「和 AI 聊聊」使用 |

`/data/*` 不对外提供静态访问，概念正文只能经 `/api/report` 按 id 读取。

---

## 评测

`eval/` 下有四个数据源与三套用例，全部离线运行，不参与线上请求。

```bash
python eval/build_kb.py        # 四个语料 + 六篇 PDF → eval/kb.sqlite
python eval/build_scenarios.py # 抽样 66 条场景语料（需本地服务与 Key）
python eval/run_eval.py        # 跑匹配集 / 追问集 / 报告契约，输出 report.md
python eval/coverage.py        # 标签覆盖分析，输出 coverage.md
```

当前基线（0.1.5，122 条匹配集）：Top-1 95.3%、Top-3 100%、负例拒答 89.7%、追问触发 6/6、误触发 0、接口错误 0。

> 0.1.5 按需求把识别结果从「1–2 个」放宽到「3–4 个候选」，Top-1 与拒答率各下降约 1–9 个百分点：模型更倾向为边缘案例凑满候选。这是产品要求带来的取舍，不是模型退化；如需更高拒答率，可把候选数退回 1–2 个。

评测集构成：

- `matching.jsonl` 122 条：64 正例 / 58 负例（简单 `n*`、难 `h*`/`k*`、语料 `c*`/`x*`）
- `followup.jsonl` 12 条：该不该追问
- `scenarios.jsonl` 66 条：四语料抽样并机器翻译，标 `needs_review`，暂不参与打分
- `evidence.md`：六篇论文对概念条目的支持度核查（只有 2 条概念拿到直接证据）

注意：`build_kb.py` 里的原始数据路径指向本机桌面目录，换机器需要改常量或把数据放到对应位置。

---

## 部署

线上为 FunctionWeb（Node 20）。部署包需要：

- `build.sh`：把 `index.html`、`server.mjs`、`run.sh`、`assets/`、`data/` 拷进 `dist/`
- `run.sh`：`exec node server.mjs`
- `execution-config.json`：`runtime.start_script` 必须是 `run.sh`，`PORT=8000`，`HOST=0.0.0.0`，Key 走 `environment` 注入

发布后先查 `/api/health`，应返回 `total` 与 `usable` 一致。

---

## 分支

| 分支 | 内容 |
|---|---|
| `main` | 网页版（本仓库） |
| `miniapp` | 支付宝小程序归档版（含 `miniapp/`、`test/`、同步脚本），不再迭代 |

取回小程序代码：`git switch miniapp`，或 `git checkout miniapp -- miniapp/`。

---

## 边界与已知限制

- 不做诊断，不给人格标签；概念卡是“可能的方向”，命名权归用户。
- 用户数据只存在浏览器 localStorage，服务端不落库，因此目前没有跨设备同步与样本回流。
- 模型只通过服务端访问，Key 不进前端；但线上 Key 以环境变量形式存在平台侧。
- 概念库 14 条，全部 `pending_review`；`evidence` 仅 2 条，其余概念的文献来源尚未与本批 PDF 对齐。
- 识别召回仍基于信号词匹配，新构念的口语说法需要持续补词（0.1.4 已补 32 个）。
- 评测存在模型随机性，单次结果有 ±1 条波动，建议多次取均值。
