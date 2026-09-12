/** Diagram source stays in the parsed book; SVG is created only for visible reading surfaces. */
export function diagramPlaceholder(source: string): string {
  const text = source
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  return `<figure class="zmu-diagram" data-diagram-state="pending"><figcaption><span class="diagram-kind">图解</span><div><button type="button" data-diagram-action="source" aria-expanded="false">查看源文</button><button type="button" data-diagram-action="open">展开图解</button></div></figcaption><div class="diagram-canvas" role="button" tabindex="0" aria-label="放大图解"><span class="diagram-wait">图解正在展开</span></div><pre class="diagram-source" hidden tabindex="0" aria-label="Mermaid 源文"><code>${text}</code></pre><p class="diagram-status" role="status"></p></figure>\n`
}
