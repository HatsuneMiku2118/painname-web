# 资料覆盖分析

用于回答一个问题：这批英文资料，能补上概念库的哪些缺口。

## 一、知识库规模

| 数据源 | 条数 |
|---|---|
| GoEmotions | 54263 |
| EmoBank | 10062 |
| MELD | 13708 |
| CPM（reman + tec） | 3042 |

## 二、情绪标签覆盖

GoEmotions 共 28 类：概念库直接出现中文线索的，或有明确承接概念的，合计 13 类（46.4%）。

| 标签 | 中文线索词 | 在概念库中的状态 |
|---|---|---|
| admiration | 钦佩、敬佩、佩服 | 不建概念（非痛苦模式） |
| amusement | 好笑、有趣、逗 | 不建概念（非痛苦模式） |
| anger | 生气、愤怒、火大 | 直接覆盖（愤怒） |
| annoyance | 烦、恼、不耐烦 | 直接覆盖（烦） |
| approval | 认可、赞同、支持 | 不建概念（非痛苦模式） |
| caring | 关心、在乎、照顾 | 直接覆盖（在乎、照顾） |
| confusion | 困惑、不解、搞不懂 | 直接覆盖（困惑） |
| curiosity | 好奇、想知道 | 不建概念（非痛苦模式） |
| desire | 想要、渴望、期待 | 直接覆盖（想要、期待） |
| disappointment | 失望、落空 | 由 counterfactual_regret 承接（期待落空后的改写） |
| disapproval | 不认同、反对、不赞成 | 不建概念（非痛苦模式） |
| disgust | 厌恶、反感、恶心 | 不建概念（非痛苦模式） |
| embarrassment | 尴尬、难为情、丢脸 | 直接覆盖（尴尬、难为情、丢脸） |
| excitement | 兴奋、激动 | 不建概念（非痛苦模式） |
| fear | 害怕、恐惧、怕 | 直接覆盖（害怕、怕） |
| gratitude | 感激、感谢 | 不建概念（非痛苦模式） |
| grief | 悲伤、哀伤、丧失 | 直接覆盖（丧失） |
| joy | 开心、高兴、快乐 | 不建概念（非痛苦模式） |
| love | 爱、喜欢 | 直接覆盖（爱、喜欢） |
| nervousness | 紧张、不安、心慌 | 直接覆盖（紧张、不安、心慌） |
| optimism | 乐观、有希望 | 不建概念（非痛苦模式） |
| pride | 骄傲、自豪 | 不建概念（非痛苦模式） |
| realization | 意识到、发现 | 不建概念（非痛苦模式） |
| relief | 释然、松一口气、轻松 | 不建概念（非痛苦模式） |
| remorse | 懊悔、后悔、愧疚 | 直接覆盖（懊悔、后悔） |
| sadness | 难过、伤心、低落 | 由 （多个概念） 承接（不建独立构念，避免与抑郁混淆） |
| surprise | 惊讶、意外、没想到 | 不建概念（非痛苦模式） |
| neutral | 平静、中性 | 不建概念（非痛苦模式） |

> 覆盖判断基于关键词字面匹配，只用于提示缺口，不代表语义完备。

## 三、CPM 五成分与追问维度

| CPM 成分 | 含义 | 现有追问 |
|---|---|---|
| Cognitive | 想法 / 评价 | thought |
| Neurophysiological | 身体反应 | body |
| Motivational | 行为倾向 / 想做什么 | behavior |
| Motor Expression | 表情与表达 | expression |
| Subjective Feeling | 情绪命名 | emotion |

CPM 的五个成分现在都有对应追问：认知→想法、神经生理→身体、动机→行为、运动表达→表情与语气、主观感受→情绪命名。

## 四、论文语料

| 论文 | 页数 | 字符数 |
|---|---|---|
| DialogueGCN.pdf | 11 | 42718 |
| EmoBank.pdf | 8 | 53309 |
| GoEmotions.pdf | 15 | 55971 |
| SemEval Affect in Tweets.pdf | 17 | 69017 |
| calculating.pdf | 5 | 4521 |
| location.pdf | 24 | 21220 |

六篇论文全文已存于 `papers` 表，可用于抽取定义、实验设置与结论，作为概念条目的可追溯依据。
