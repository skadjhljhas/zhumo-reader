import { parseSyntaxAnalysis, type SyntaxRole, type SyntaxRelation } from './ai-types'
const unit = (
  id: string,
  quote: string,
  role: SyntaxRole,
  label: string,
  explanation: string,
  layer = 'syntax',
  occurrence = 1
): Record<string, unknown> => ({
  id,
  layer,
  role,
  label,
  anchors: quote ? [{ quote, occurrence }] : [],
  ...(quote ? {} : { implicit: true }),
  explanation,
  evidence: quote ? '对应原文“' + quote + '”。' : '并列结构与前一分句提供恢复依据。',
  status: 'supported'
})
const relation = (
  id: string,
  kind: SyntaxRelation['kind'],
  from: string,
  to: string[],
  label: string,
  explanation: string,
  evidence: string
): SyntaxRelation => ({ id, kind, from, to, label, explanation, evidence, status: 'supported' })
function example(
  id: string,
  title: string,
  raw: Record<string, unknown>
): { id: string; title: string; analysis: ReturnType<typeof parseSyntaxAnalysis> } {
  return {
    id,
    title,
    analysis: parseSyntaxAnalysis(
      JSON.stringify({ version: 2, readings: [], ...raw }),
      String(raw.text)
    )
  }
}
export const SYNTAX_EXAMPLES = [
  example('scope', '否定抵达哪里', {
    text: '并非每位读者都读懂了这封信。',
    language: '现代汉语',
    summary: '“并非”否定所有相关读者都读懂这一判断。它没有说每位读者都没读懂。',
    units: [
      unit('neg', '并非', 'negation', '否定线索', '否定后面的全称判断。', 'meaning'),
      unit(
        'claim',
        '每位读者都读懂了这封信',
        'clause',
        '全称判断的范围',
        '“每位”与“都”构成这里受否定的全称判断。',
        'meaning'
      ),
      unit('reader', '每位读者', 'subject', '句法主语', '与读懂建立主语关系。'),
      unit('read', '读懂', 'predicate', '谓语', '读懂是本句的核心述谓。'),
      unit('letter', '这封信', 'object', '宾语', '读懂所涉及的对象。'),
      unit('aspect', '了', 'particle', '体貌成分', '这里的了位于动词之后、宾语之前。')
    ],
    relations: [
      relation(
        'neg_scope',
        'scope',
        'neg',
        ['claim'],
        '否定全称判断',
        '光的范围对应被否定的判断；并非全都读懂，仍保留有人读懂的可能。',
        '并非位于每位读者都读懂了这封信之前。'
      ),
      relation(
        'subject',
        'dependency',
        'read',
        ['reader'],
        '谁与“读懂”相联',
        '读懂以每位读者为主语；句法主语不因此等同于一般意义上的施事。',
        '原文主谓配置。'
      ),
      relation(
        'object',
        'dependency',
        'read',
        ['letter'],
        '理解指向什么',
        '读懂与这封信构成谓语—宾语关系。',
        '这封信是读懂的宾语。'
      )
    ]
  }),
  example('control', '关系穿过距离', {
    text: 'Lin promised Chen to leave, but Chen persuaded Lin to stay.',
    language: 'English',
    summary:
      '前半句由 Lin 承诺离开；后半句 Chen 劝 Lin 留下。两个谓词通过不同的控制关系确定隐含主语。',
    units: [
      unit('lin1', 'Lin', 'subject', '承诺者', '前一分句的主语。'),
      unit('promise', 'promised', 'predicate', '承诺谓词', '引入承诺内容。'),
      unit('chen1', 'Chen', 'object', '承诺的对方', '承诺面向的人。'),
      unit('leave', 'leave', 'predicate', '离开', '离开者通过控制关系确定。'),
      unit('chen2', 'Chen', 'subject', '劝说者', '后一分句的主语。', 'syntax', 2),
      unit('persuade', 'persuaded', 'predicate', '劝说谓词', '面向受劝说者。'),
      unit('lin2', 'Lin', 'object', '被劝说者', '后一分句的宾语。', 'syntax', 2),
      unit('stay', 'stay', 'predicate', '留下', '留下者通过控制关系确定。')
    ],
    relations: [
      relation(
        'leave_control',
        'control',
        'leave',
        ['lin1'],
        '离开者是谁',
        'promise 构式中，leave 的控制者通常是 Lin，而非距离最近的 Chen。',
        'promised 的主语控制模式。'
      ),
      relation(
        'stay_control',
        'control',
        'stay',
        ['lin2'],
        '留下者是谁',
        'persuade 构式中，stay 的控制者是被劝说的 Lin。',
        'persuaded 的宾语控制模式。'
      ),
      relation(
        'promise_world',
        'perspective',
        'promise',
        ['leave'],
        '承诺中的事件',
        '原文报告承诺，不由此断言离开已经发生。',
        'leave 位于 promised 的内容中。'
      )
    ]
  }),
  example('focus', '两种可讨论的读法', {
    text: '她只给林舟写了信。',
    language: '现代汉语',
    summary:
      '在缺少更明确语境与语调时，可以比较收信人对比与行为对比。切换的是分析问题，原文保持原样。',
    units: [
      unit('only', '只', 'particle', '焦点敏感表达', '与语境中的替代集合有关。', 'meaning'),
      unit('person', '林舟', 'referent', '收信人', '当前句中明写的收信人。', 'discourse'),
      unit('action', '给林舟写了信', 'clause', '所述行为', '写信给林舟这一行为。', 'meaning')
    ],
    relations: [
      {
        ...relation(
          'recipient',
          'focus',
          'only',
          ['person'],
          '收信人对比',
          '在回答给谁写信时，突出林舟与其他可能收信人的对照。焦点关联不等于只对名词施加句法辖域。',
          '需要收信人对比的语境支持。'
        ),
        status: 'possible'
      },
      {
        ...relation(
          'activity',
          'focus',
          'only',
          ['action'],
          '行为对比',
          '在回答为林舟做了什么时，可讨论写信与其他可能行为的对照。',
          '需要行为对比的语境支持。'
        ),
        status: 'possible'
      }
    ],
    readings: [
      {
        id: 'recipient_reading',
        label: '收信人对比',
        units: [],
        relations: ['recipient'],
        explanation: '考察“给谁写信”这一问题。',
        conditions: '例如前文正在比较收信人；书面选句本身没有提供真实重音。'
      },
      {
        id: 'activity_reading',
        label: '行为对比',
        units: [],
        relations: ['activity'],
        explanation: '考察“为林舟做了什么”这一问题。',
        conditions: '需要相应行为对比语境；不能仅凭只字就断言这是唯一读法。'
      }
    ]
  }),
  example('ellipsis', '未写出的部分', {
    text: 'Lin bought tea, and Chen coffee.',
    language: 'English',
    summary: '后一分句的购买关系可以通过并列中的省略分析恢复；原文中没有第二个 bought。',
    units: [
      unit('buy', 'bought', 'predicate', '显式谓词', '前一分句明写购买。'),
      unit('lin', 'Lin', 'subject', '前一主语', '购买茶的人。'),
      unit('tea', 'tea', 'object', '前一宾语', '被购买的茶。'),
      unit('chen', 'Chen', 'subject', '后一参与者', '参与省略分句中的购买关系。'),
      unit('coffee', 'coffee', 'object', '后一对象', '省略分句中的对象。'),
      unit(
        'missing',
        '',
        'implicit',
        '隐含的购买关系',
        '分析中的恢复单位，不是原文中存在的字。',
        'meaning'
      )
    ],
    relations: [
      relation(
        'omission',
        'ellipsis',
        'buy',
        ['missing'],
        '并列中的谓词省略',
        'bought 为后一分句提供恢复购买关系的依据；不向原文添加一个透明的 bought。',
        'Chen 与 coffee 的并列结构，以及前句显式谓词。'
      ),
      relation(
        'participants',
        'dependency',
        'missing',
        ['chen', 'coffee'],
        '隐含关系的参与者',
        '后一分句以 Chen 与 coffee 对应购买关系中的参与者和对象。',
        '两个名词分别对应前句 Lin 与 tea 的结构位置。'
      )
    ]
  })
]
