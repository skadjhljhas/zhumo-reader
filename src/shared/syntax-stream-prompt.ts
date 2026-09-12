import { SYNTAX_PROMPT_V2, SYNTAX_CONTRACT_V2 } from './syntax-prompts'

export const SYNTAX_PROMPT_V3 =
  SYNTAX_PROMPT_V2.replace('只返回应用契约规定的 JSON。', '只返回应用契约规定的逐行 JSON 流。') +
  `

【边分析，边交付】
读者正在阅读，程序会在每一个完整 patch 抵达时开始柔缓显影。请先交付有根据的核心谓词及其论元/关键辖域这一小组，再逐批补充修饰、照应、篇章关系和有根据的候选。不要把所有分析攒到最后，不要先输出长摘要，不要在正式答案里复述思考过程。早交付不等于草率：每批都必须自足、逐字可定位、关系端点已存在，解释与依据简洁而具体。
一个 patch 通常交付2至6个单位、1至4条关系；多句选段先完成一小句的核心。没有必要每次重复已有对象；用稳定 ID 补充或更新。证据不足的判断明确标记 possible/unresolved。互斥读法及其特有单位/关系必须和完整 readings 一起在同一个 patch 中交付，不能让程序短暂把矛盾候选混成同一事实。
思考模式由 API 参数控制；你只负责准确而及时地交付结构。不要承诺无法从材料确认的分析。`

export const SYNTAX_CONTRACT_V3 = `输出 NDJSON：每一行必须是一个独立且完整的 JSON 对象；行内字符串换行转义为 \\n。不要代码围栏、正文前言、HTML/CSS、字符偏移或把整份结果包进数组。流格式版本3；单位与关系沿用下方版本2的语义。
第一行：{"type":"begin","version":3}
中间若干行：{"type":"patch","units":[...],"relations":[...]}。units/relations 允许空数组；每批最多新增/更新12个单位、16条关系，整次上限96个单位、128条关系。完整对象以 id 合并：新 ID 添加，旧 ID 原位替换。关系只引用此前或同一批内的单位。不要删除既有 ID。
patch 可附 language、summary 和 readings；未提供则保留之前的值。readings 一旦提供即整体替换；候选分支必须和所有依赖对象原子交付。共享关系不得引用另一候选独有单位。不要先发送尚未成立的边或半个候选。程序不猜测缺失字段。
最后一行：{"type":"done","summary":"本次关键关系与必要限制。"}。即便没有可定位结构，也要说明原因并发送 done。text 不必复述，程序将 selectedText 原样绑定本次流；锚点只能来自该文本。
示例（每行是一个对象）：
{"type":"begin","version":3}
{"type":"patch","units":[{"id":"u1","layer":"meaning","role":"negation","label":"否定线索","anchors":[{"quote":"并非","occurrence":1}],"explanation":"否定后面的全称判断。","evidence":"并非位于全称表达之前。","status":"supported"},{"id":"u2","layer":"meaning","role":"clause","label":"全称判断","anchors":[{"quote":"所有人都赞同","occurrence":1}],"explanation":"所有相关人都赞同这一命题。","evidence":"所有与都构成全称表达。","status":"supported"}],"relations":[{"id":"r1","kind":"scope","from":"u1","to":["u2"],"label":"否定全称判断","explanation":"不能据此断言所有人都反对。","evidence":"并非否定所有人都赞同。","status":"supported"}]}
{"type":"done","summary":"否定全称判断，保留有人赞同的可能。"}

【单位与关系字段定义，格式以本流式契约为准】
${SYNTAX_CONTRACT_V2.slice(SYNTAX_CONTRACT_V2.indexOf('units：')).replace('原句 text 必须与 selectedText 完全相同。', '原文是输入的 selectedText。')}`
