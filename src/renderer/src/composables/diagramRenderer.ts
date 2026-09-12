import type { Mermaid, MermaidConfig } from 'mermaid'
import type { ThemeId } from './useStudio'
import { cleanDiagramSvg } from './diagramSvg'

export interface DiagramResult {
  svg: string
  width: number
  height: number
  title: string
  type: string
}
const palettes: Record<ThemeId, [string, string, string, string, string, boolean]> = {
  paper: ['#ffffff', '#111111', '#333333', '#f4f4f4', '#e8e8e8', false],
  chaosheng: ['#10243f', '#dfebfa', '#9bbfe9', '#1a3455', '#34374c', true],
  lucent: ['#eaf5fa', '#253e54', '#477d9b', '#cde5ef', '#e8e4f3', false],
  astral: ['#182b46', '#e0ebfa', '#a6caed', '#263c59', '#312e50', true],
  cinnabar: ['#faf4e9', '#382f27', '#ae4938', '#ede1c9', '#eee4db', false],
  nocturne: ['#1c343e', '#dbe5df', '#d6ba8a', '#2b424a', '#354545', true],
  cosmos: ['#172739', '#dcf2ed', '#9de2d1', '#29434b', '#342c50', true],
  manifesto: ['#f9e773', '#252525', '#d63d2b', '#f5f0df', '#f5b197', false],
  botanical: ['#edf1e7', '#304a3a', '#547e5d', '#dbe5cf', '#ebe3ce', false],
  prism: ['#f0edf8', '#403957', '#7564a4', '#dedaf0', '#e7dfe9', false]
}
export const diagramName = (type: string): string =>
  ({
    flowchart: '流程图',
    'flowchart-v2': '流程图',
    sequence: '时序图',
    state: '状态图',
    stateDiagram: '状态图',
    'stateDiagram-v2': '状态图',
    class: '类图',
    classDiagram: '类图',
    er: '关系图',
    mindmap: '思维导图',
    timeline: '时间线',
    gantt: '甘特图',
    pie: '饼图',
    journey: '旅程图',
    'xychart-beta': '坐标图',
    xychart: '坐标图'
  })[type] ?? '图解'
function config(theme: ThemeId, mathLabels: boolean): MermaidConfig {
  const [paper, ink, accent, secondary, tertiary, dark] = palettes[theme]
  // Mermaid's base theme darkens its generated branch scale by 75 points in
  // dark mode. Supply every branch color explicitly so it cannot collapse to
  // black; labels and connector strokes keep the reader's own palette.
  const branchColors = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      [`cScale${index}`, [paper, secondary, tertiary][index % 3]],
      [`cScaleLabel${index}`, ink],
      [`cScaleInv${index}`, accent],
      [`cScalePeer${index}`, paper]
    ]).flat()
  )
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: 300000,
    maxEdges: 5000,
    theme: 'base',
    themeCSS: `
      .mindmap-node > circle + .label text { text-anchor: middle; }
      .mindmap-node > .label-container, .mindmap-node > .node-bkg {
        stroke: ${accent}; stroke-width: 1.2px;
      }
      .edge[class*="section-edge-"] {
        stroke: ${accent}; stroke-width: 1.5px; stroke-opacity: 0.72;
      }
      .edge.edge-depth-1 { stroke-width: 2.5px; }
    `,
    htmlLabels: mathLabels,
    legacyMathML: false,
    forceLegacyMathML: false,
    fontFamily: 'Microsoft YaHei, Segoe UI, sans-serif',
    secure: [
      'secure',
      'securityLevel',
      'startOnLoad',
      'suppressErrorRendering',
      'maxTextSize',
      'maxEdges',
      'htmlLabels',
      'legacyMathML',
      'forceLegacyMathML',
      'theme',
      'themeVariables',
      'themeCSS',
      'fontFamily',
      'flowchart',
      'class'
    ],
    flowchart: { htmlLabels: mathLabels, useMaxWidth: false, curve: 'basis', padding: 18 },
    class: { htmlLabels: false, useMaxWidth: false },
    themeVariables: {
      ...branchColors,
      git0: secondary,
      gitBranchLabel0: ink,
      darkMode: dark,
      background: paper,
      primaryColor: paper,
      primaryTextColor: ink,
      primaryBorderColor: accent,
      secondaryColor: secondary,
      secondaryTextColor: ink,
      secondaryBorderColor: accent,
      tertiaryColor: tertiary,
      tertiaryTextColor: ink,
      tertiaryBorderColor: accent,
      lineColor: accent,
      textColor: ink,
      mainBkg: paper,
      nodeBorder: accent,
      clusterBkg: secondary,
      clusterBorder: accent,
      edgeLabelBackground: paper,
      actorBkg: paper,
      actorTextColor: ink,
      actorBorder: accent,
      signalColor: accent,
      signalTextColor: ink,
      noteBkgColor: tertiary,
      noteTextColor: ink,
      noteBorderColor: accent,
      labelColor: ink,
      xyChart: {
        backgroundColor: 'transparent',
        titleColor: ink,
        dataLabelColor: ink,
        legendTextColor: ink,
        xAxisLabelColor: ink,
        xAxisTitleColor: ink,
        xAxisTickColor: accent,
        xAxisLineColor: accent,
        yAxisLabelColor: ink,
        yAxisTitleColor: ink,
        yAxisTickColor: accent,
        yAxisLineColor: accent,
        plotColorPalette: `${accent},${dark ? '#d6b7cd' : '#8f6d98'}`
      },
      fontFamily: 'Microsoft YaHei, Segoe UI, sans-serif',
      fontSize: '16px'
    }
  }
}
let library: Promise<Mermaid> | undefined
let tail: Promise<unknown> = Promise.resolve()
let serial = 0
let cacheBytes = 0
const cache = new Map<string, DiagramResult>()
const inFlight = new Map<string, Promise<DiagramResult>>()

/** Mermaid owns shared configuration, so initialization and layout are one serialized job. */
export function renderDiagram(source: string, theme: ThemeId): Promise<DiagramResult> {
  const key = `${theme}\n${source}`
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return Promise.resolve(cached)
  }
  const pending = inFlight.get(key)
  if (pending) return pending
  const task = tail.then(async () => {
    library ??= import('mermaid').then((module) => module.default)
    const mermaid = await library
    await document.fonts.ready
    // Mermaid's native MathML labels need foreignObject layout in flowcharts.
    // Ordinary diagrams retain SVG text; strict sanitization remains enabled for both.
    mermaid.initialize(config(theme, /\$\$[\s\S]*?\$\$/.test(source)))
    const mount = document.createElement('div')
    mount.className = 'diagram-layout-scratch'
    document.body.append(mount)
    try {
      const result = await mermaid.render(`zhumo-layout-${++serial}`, source, mount)
      const value = { ...cleanDiagramSvg(result.svg), type: result.diagramType }
      cache.set(key, value)
      cacheBytes += key.length * 2 + value.svg.length * 2
      while (cache.size > 48 || cacheBytes > 12 * 1024 * 1024) {
        const oldest = cache.entries().next().value
        if (!oldest) break
        cacheBytes -= (oldest[0].length + oldest[1].svg.length) * 2
        cache.delete(oldest[0])
      }
      return value
    } finally {
      mount.remove()
    }
  })
  inFlight.set(key, task)
  tail = task.catch(() => undefined)
  void task.finally(() => inFlight.delete(key)).catch(() => undefined)
  return task
}
