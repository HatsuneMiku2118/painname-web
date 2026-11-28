# 识别与报告基线评测

- 生成时间：2026-11-28 15:56:17
- 接口：http://127.0.0.1:8123
- 匹配集：122 条（正例 64 / 负例 58）

## 一、核心指标

| 指标 | 数值 |
|---|---|
| Top-1 命中率 | 98.4%（63/64） |
| Top-3 命中率 | 100.0%（64/64） |
| MRR | 0.992 |
| 负例正确拒答率 | 94.8%（55/58） |
| 负例误报率 | 5.2%（3/58） |
| 平均候选数 | 1.75 |
| 候选数 >4 的次数 | 0 |
| 延迟 P50 / P90 | 1.6s / 2.13s |
| 追问触发（应问） | 100.0%（6/6） |
| 追问误触发（不应问） | 0.0%（0/6） |
| 接口错误 | 0 |

## 二、Top-3 未命中

无。

## 三、负例分类

| 负例类型 | 条数 | 正确拒答 |
|---|---|---|
| 简单负例（明显无关） | 8 | 100.0% |
| 难负例（情绪相似但缺模式） | 30 | 93.3% |
| 语料负例（真实情绪文本） | 20 | 95.0% |

## 四、负例误报

| 用例 | 实际候选 |
|---|---|
| h08 | rejection_sensitivity、emotional_granularity |
| k17 | self_silencing、rejection_sensitivity、emotional_granularity |
| x12 | self_blame、rejection_sensitivity、attachment_anxiety |

## 五、报告契约

| 概念 | 解释段 | 机制段 | 循环步 | 依据条 | 总结字数 | 禁用词 | 疑似引用 |
|---|---|---|---|---|---|---|---|
| rumination | 2 | 2 | 4 | 4 | 129 | — | — |
| attachment_anxiety | 2 | 2 | 5 | 3 | 117 | — | — |
| self_blame | 2 | 2 | 5 | 4 | 156 | — | — |
| breakup_identity | 2 | 2 | 5 | 3 | 115 | — | — |
| emotional_granularity | 2 | 2 | 4 | 3 | 95 | — | — |
| demand_withdraw | 2 | 2 | 5 | 4 | 136 | — | — |

异常报告：0 条。

## 六、概念库覆盖

| 概念 | 信号组 | 关键词数 | 审核状态 |
|---|---|---|---|
| 反刍思维 | 4 | 26 | pending_review |
| 依恋焦虑 | 4 | 42 | pending_review |
| 拒绝敏感性 | 3 | 27 | pending_review |
| 关系不确定性 | 3 | 21 | pending_review |
| 自我责备 | 3 | 25 | pending_review |
| 分手后的自我概念模糊 | 3 | 18 | pending_review |
| 情绪粒度偏低 | 3 | 18 | pending_review |
| 要求—退缩循环 | 4 | 19 | pending_review |
| 关系中的自我沉默 | 4 | 36 | pending_review |
| 担忧 | 4 | 20 | pending_review |
| 羞耻感 | 4 | 34 | pending_review |
| 孤独感 | 4 | 21 | pending_review |
| 反事实后悔 | 4 | 21 | pending_review |
| 情绪耗竭 | 4 | 23 | pending_review |

所有条目均至少有 2 组信号。

## 七、场景语料

共 66 条，翻译成功 64 条。

| 来源 | 条数 |
|---|---|
| MELD | 18 |
| GoEmotions | 24 |
| EmoBank | 12 |
| CPM/tec | 10 |
| CPM/reman | 2 |

> 场景语料由模型翻译，标记 needs_review，用于扩展用例与覆盖检查，当前不参与打分。

## 八、结论

- 概念匹配 Top-3 为 100.0%，Top-1 为 98.4%。
- 负例误报 3 条，说明对概念库外议题的拒答能力仍需加强。
- 报告结构异常 0 条，禁用词与疑似引用需逐条人工确认。
- 追问触发 100.0%，误触发 0.0%（信息充足时不应再问）。
