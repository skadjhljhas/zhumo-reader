import {
  parseSyntaxAnalysis,
  type SyntaxAnalysis,
  type SyntaxRole,
  type SyntaxRelation
} from './ai-types'
import { SYNTAX_EXAMPLES } from './syntax-examples'
const unit = (
  id: string,
  quote: string,
  role: SyntaxRole,
  label: string,
  layer = 'meaning'
): Record<string, unknown> => ({
  id,
  layer,
  role,
  label,
  anchors: [{ quote, occurrence: 1 }],
  explanation: label,
  evidence: '原文明写“' + quote + '”。',
  status: 'supported'
})
const relation = (
  id: string,
  kind: SyntaxRelation['kind'],
  from: string,
  to: string[],
  label: string,
  explanation: string
): SyntaxRelation => ({
  id,
  kind,
  from,
  to,
  label,
  explanation,
  evidence: explanation,
  status: 'supported'
})
function example(
  id: string,
  title: string,
  text: string,
  summary: string,
  units: unknown[],
  relations: SyntaxRelation[]
): { id: string; title: string; analysis: SyntaxAnalysis } {
  return {
    id,
    title,
    analysis: parseSyntaxAnalysis(
      JSON.stringify({
        version: 2,
        text,
        language: /[\u3400-\u9fff]/.test(text) ? '现代汉语' : 'English',
        summary,
        units,
        relations: relations.map((r) => ({
          ...r,
          ...(['inner_all', 'inner_not', 'possibility'].includes(r.id)
            ? {
                within:
                  r.id === 'inner_all'
                    ? 'outer_not'
                    : r.id === 'inner_not'
                      ? 'outer_all'
                      : 'reporting'
              }
            : {})
        })),
        readings: []
      }),
      text
    )
  }
}
export const SYNTAX_READING_EXAMPLES = [
  example(
    'not-all',
    '并非全都',
    '并非每位读者都读懂了这封信。',
    '否定的是“所有相关读者都读懂”这一整体判断。它保留有人读懂的可能。',
    [
      unit('not', '并非', 'negation', '外层否定'),
      unit('all', '每位读者都读懂了这封信', 'clause', '全称命题'),
      unit('every', '每位读者', 'quantifier', '全称量化'),
      unit('understood', '都读懂了这封信', 'clause', '量化的述谓范围')
    ],
    [
      relation(
        'outer_not',
        'scope',
        'not',
        ['all'],
        '否定覆盖全称判断',
        '先构成每位读者都读懂的判断，再否定这个整体。'
      ),
      relation(
        'inner_all',
        'scope',
        'every',
        ['understood'],
        '全称量化在否定之内',
        '每位读者的量化范围是读懂这封信。'
      )
    ]
  ),
  example(
    'all-not',
    '全都没有',
    '每位读者都没有读懂这封信。',
    '对每位相关读者都断言没有读懂。与“并非全都”承担不同的语义承诺。',
    [
      unit('every', '每位读者', 'quantifier', '外层全称量化'),
      unit('denied', '都没有读懂这封信', 'clause', '被量化的否定判断'),
      unit('not', '没有', 'negation', '内层否定'),
      unit('understood', '读懂这封信', 'clause', '被否定的理解事件')
    ],
    [
      relation(
        'outer_all',
        'scope',
        'every',
        ['denied'],
        '全称量化覆盖否定',
        '对每一位相关读者分别作出没有读懂的判断。'
      ),
      relation(
        'inner_not',
        'scope',
        'not',
        ['understood'],
        '否定在全称量化之内',
        '没有作用于读懂这封信，不是否定全称量化本身。'
      )
    ]
  ),
  example(
    'promise',
    '承诺离开的人',
    'Lin promised Chen to leave.',
    '离开者是 Lin。距离 leave 最近的 Chen 不是这个构式的控制者。',
    [
      unit('lin', 'Lin', 'referent', '承诺者', 'syntax'),
      unit('promise', 'promised', 'predicate', '承诺谓词', 'syntax'),
      unit('chen', 'Chen', 'referent', '承诺的对方', 'syntax'),
      unit('leave', 'leave', 'event', '承诺中的离开事件')
    ],
    [
      relation(
        'controller',
        'control',
        'leave',
        ['lin'],
        '离开者由 Lin 控制',
        '英语 promise 在这一构式中体现主语控制。'
      )
    ]
  ),
  example(
    'persuade',
    '被劝说离开的人',
    'Lin persuaded Chen to leave.',
    '离开者是 Chen。光接到受到劝说的人，而不是沿着表面的词序重复上一条关系。',
    [
      unit('lin', 'Lin', 'referent', '劝说者', 'syntax'),
      unit('persuade', 'persuaded', 'predicate', '劝说谓词', 'syntax'),
      unit('chen', 'Chen', 'referent', '受到劝说的人', 'syntax'),
      unit('leave', 'leave', 'event', '劝说内容中的离开事件')
    ],
    [
      relation(
        'controller',
        'control',
        'leave',
        ['chen'],
        '离开者由 Chen 控制',
        '英语 persuade 在这一构式中体现宾语控制。'
      )
    ]
  ),
  example(
    'reference',
    '文字向前借取身份',
    '林舟把旧信递给陈墨。后者随即拆开了它。',
    '“后者”承接陈墨，“它”承接旧信。两条指称链同时存在，跨过句号，彼此独立。',
    [
      unit('letter', '旧信', 'referent', '物的先行项', 'discourse'),
      unit('chen', '陈墨', 'referent', '人的先行项', 'discourse'),
      unit('latter', '后者', 'referent', '后一个人的指称', 'discourse'),
      unit('it', '它', 'referent', '信的再指称', 'discourse')
    ],
    [
      relation(
        'person_chain',
        'reference',
        'latter',
        ['chen'],
        '后者承接陈墨',
        '后者在这里指前句后一个提及的人。'
      ),
      relation(
        'letter_chain',
        'reference',
        'it',
        ['letter'],
        '它承接旧信',
        '拆开动作的对象承接前句的旧信。'
      )
    ]
  ),
  example(
    'perspective',
    '谁承担这个判断',
    '林舟说，陈墨可能已经离开。',
    '报告的是林舟的话；话中只表达离开的可能性。原文没有把陈墨已离开当作确定事实直接断言。',
    [
      unit('reporter', '林舟说', 'predicate', '话语来源', 'discourse'),
      unit('reported', '陈墨可能已经离开', 'clause', '被转述的判断', 'discourse'),
      unit('possible', '可能', 'modal', '可能性算子'),
      unit('event', '已经离开', 'event', '模态范围内的事件')
    ],
    [
      relation(
        'reporting',
        'perspective',
        'reporter',
        ['reported'],
        '判断置于林舟的转述中',
        '句子将内容归于林舟的话语。'
      ),
      relation(
        'possibility',
        'scope',
        'possible',
        ['event'],
        '离开仅为可能',
        '可能引入模态环境，不能由此推出离开已实际发生。'
      )
    ]
  ),
  SYNTAX_EXAMPLES[2],
  SYNTAX_EXAMPLES[3]
]
