<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { SYNTAX_READING_EXAMPLES } from '../../../shared/syntax-reading-examples'
import MeaningPassage from './MeaningPassage.vue'
import SyntaxMeaningKey from './SyntaxMeaningKey.vue'
const topic = ref(0),
  light = ref(true),
  still = ref(false),
  dark = ref(false),
  reading = ref('recipient_reading')
const topics = [
  {
    name: '否定与全称',
    title: '相同的词，承担不同的判断。',
    description:
      '外层在字上展开，内层在字下保留。玫紫标明否定范围，蓝光标明量化范围：两种光交换内外，句子的承诺也随之改变。',
    indices: [0, 1]
  },
  {
    name: '控制与距离',
    title: '真正相连的，未必彼此最近。',
    description:
      '金色光路连接 leave 与它的控制者。谓词改变后，离开的人也改变；中间的名字不会仅因为邻近就被照亮。',
    indices: [2, 3]
  },
  {
    name: '照应与视角',
    title: '一个字有来处，一个判断有归属。',
    description:
      '冰蓝光把再指称与先行项连起来；紫色范围区分转述与可能性。它们帮助读者追踪身份，也保留尚未被断言为真的内容。',
    indices: [4, 5]
  },
  {
    name: '歧义与省略',
    title: '有些意义，不能被草率地合拢。',
    description:
      '互斥读法分别呈现；原文缺席的谓词不被补成虚影。光只连接图中已有依据、在文中真正可定位的成分。',
    indices: [6, 7]
  }
]
const current = computed(() => topics[topic.value])
watch(
  dark,
  (v) => {
    document.documentElement.dataset.skin = v ? 'chaosheng' : 'lucent'
  },
  { immediate: true }
)
</script>
<template>
  <main class="meaning-lab" :class="{ 'is-dark': dark }">
    <header class="meaning-lab-header">
      <a class="meaning-wordmark" href="./index.html?mock=1&lightTheme=lucent">朱 墨</a
      ><span>语言的光学 · 17</span>
      <div class="meaning-lab-actions">
        <button :aria-pressed="dark" @click="dark = !dark">{{ dark ? '潮光' : '琉璃' }}</button
        ><button :aria-pressed="still" @click="still = !still">
          {{ still ? '恢复流动' : '静观结构' }}</button
        ><button :aria-pressed="light" @click="light = !light">
          {{ light ? '暂隐标注' : '显现关系' }}
        </button>
      </div>
    </header>
    <div class="meaning-introduction">
      <p class="meaning-kicker">阅读，不必等到鼠标停下来。</p>
      <h1>让意义的结构，<br />成为可见的光。</h1>
      <p>光需要让你看见一个判断怎样成立、怎样被限制、又怎样向前文借取意义。</p>
    </div>
    <nav class="meaning-tabs" aria-label="理解的问题">
      <button
        v-for="(item, index) in topics"
        :key="item.name"
        :aria-current="topic === index ? 'page' : undefined"
        @click="topic = index"
      >
        {{ item.name }}
      </button>
    </nav>
    <section :key="topic" class="meaning-comparison" :aria-label="current.name">
      <div class="meaning-question">
        <h2>{{ current.title }}</h2>
        <p>{{ current.description }}</p>
      </div>
      <div class="meaning-pair">
        <article
          v-for="(index, ordinal) in current.indices"
          :key="index"
          class="meaning-case"
          :data-case="SYNTAX_READING_EXAMPLES[index].id"
        >
          <p class="meaning-case-label">
            <span>{{ String(ordinal + 1).padStart(2, '0') }}</span
            >{{ SYNTAX_READING_EXAMPLES[index].title }}
          </p>
          <MeaningPassage
            :analysis="SYNTAX_READING_EXAMPLES[index].analysis"
            :reading="index === 6 ? reading : undefined"
            :light="light"
            :still="still"
          />
          <div v-if="index === 6" class="meaning-reading-choice">
            <button
              v-for="r in SYNTAX_READING_EXAMPLES[index].analysis.readings"
              :key="r.id"
              :aria-pressed="reading === r.id"
              @click="reading = r.id"
            >
              {{ r.label }}
            </button>
          </div>
          <p v-if="index < 2" class="meaning-formula">
            {{ index === 0 ? '¬ ∀  ·  并非所有人都读懂' : '∀ ¬  ·  所有人都没有读懂' }}
          </p>
          <p class="meaning-consequence">
            {{
              index === 6
                ? SYNTAX_READING_EXAMPLES[index].analysis.readings?.find((r) => r.id === reading)
                    ?.explanation
                : SYNTAX_READING_EXAMPLES[index].analysis.summary
            }}
          </p>
        </article>
      </div>
    </section>
    <SyntaxMeaningKey />
    <footer class="meaning-lab-footer">
      <p>
        固定语言学案例 · 与桌面版共用渲染组件 · 未调用模型<br />移动鼠标不会改变分析；静观模式仍保留关系、范围与嵌套。
      </p>
      <a href="./index.html?mock=1&book=syntax-meaning&aiDemo=meaning&lightTheme=lucent"
        >在阅读器中继续 →</a
      >
    </footer>
    <div class="meaning-research-links">
      研究参照：<a href="https://aclanthology.org/W13-0101/">UCCA的关系结构</a
      ><a href="https://aclanthology.org/E17-2039/">话语与组合意义</a
      ><a href="https://aclanthology.org/W17-1804/">否定作用域</a
      ><span>光的映射是朱墨的设计实验。</span>
    </div>
  </main>
</template>
