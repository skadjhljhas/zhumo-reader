import { BrowserWindow, dialog, ipcMain } from 'electron'
import { mkdtemp, readFile, writeFile, open, rename, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, basename, extname, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC, type PdfExportRequest } from '../shared/ipc-types'
let pending = Promise.resolve()
const bytesAt = async (path: string): Promise<Buffer | null> =>
  readFile(path).catch((error) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
export function registerPdfExport(library: () => Promise<string>): void {
  ipcMain.handle(IPC.ExportPdf, async (event, request: PdfExportRequest) => {
    if (
      !request ||
      typeof request.html !== 'string' ||
      typeof request.title !== 'string' ||
      request.html.length > 256 * 1024 * 1024
    )
      throw Error('无效的PDF内容。')
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: '导出 PDF',
      defaultPath: join(
        await library(),
        (request.title.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100) || '未命名') + '.pdf'
      ),
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
    }
    const picked = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options)
    if (picked.canceled || !picked.filePath) return null
    const target =
      extname(picked.filePath).toLowerCase() === '.pdf' ? picked.filePath : picked.filePath + '.pdf'
    const before = await bytesAt(target)
    const task = pending
      .catch(() => undefined)
      .then(async () => {
        const directory = await mkdtemp(join(tmpdir(), 'zhumo-pdf-'))
        let window: BrowserWindow | undefined
        try {
          const html = join(directory, 'document.html')
          const head = /^<!doctype html><html[^>]*><head>/i.exec(request.html)
          if (!head) throw Error('PDF页面结构无效。')
          const policy =
            '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;none&#39;; style-src &#39;unsafe-inline&#39; file:; img-src data: file:; font-src data: file:">'
          await writeFile(html, head[0] + policy + request.html.slice(head[0].length), {
            flag: 'wx'
          })
          window = new BrowserWindow({
            show: false,
            focusable: false,
            skipTaskbar: true,
            useContentSize: true,
            width: Math.ceil(((request.orientation === 'landscape' ? 269 : 182) * 96) / 25.4),
            height: Math.ceil(((request.orientation === 'landscape' ? 179 : 266) * 96) / 25.4),
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              offscreen: true,
              backgroundThrottling: false,
              partition: 'zhumo-pdf-' + randomUUID()
            }
          })
          window.webContents.setFrameRate(60)
          window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
          window.webContents.on('will-navigate', (event) => event.preventDefault())
          await window.loadFile(html)
          const ready = await window.webContents.executeJavaScript(`(async()=>{
          await document.fonts.ready;
          const images=[...document.images];
          await Promise.all(images.map(img=>img.decode().catch(()=>undefined)));
          await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
          for(const block of document.querySelectorAll('.pdf-document pre,.pdf-document table,.pdf-document .zmu-math-block')){
            const width=block.parentElement.clientWidth;
            if(block.scrollWidth>width+2){const scale=width/block.scrollWidth;block.style.zoom=String(scale);block.style.maxWidth='none';}
          }
          for(const card of document.querySelectorAll('.pdf-note'))if(card.getBoundingClientRect().height>700)card.classList.add('pdf-long-note');
          return {missingImages:images.filter(img=>!img.naturalWidth).length};
        })()`)
          const bytes = await window.webContents.printToPDF({
            printBackground: true,
            preferCSSPageSize: true,
            generateTaggedPDF: true,
            generateDocumentOutline: true,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate:
              '<div style="width:100%;text-align:center;font-size:9px;color:' +
              (/^[a-f0-9#]{7}$/i.test(request.footerColor) ? request.footerColor : '#496274') +
              '"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
          })
          if (bytes.subarray(0, 5).toString() !== '%PDF-') throw Error('未生成有效的PDF。')
          const now = await bytesAt(target)
          if ((before === null) !== (now === null) || (before && now && !before.equals(now)))
            throw Error('目标PDF在导出过程中被修改，请换一个文件名。')
          const temporary = join(
            dirname(target),
            '.' + basename(target) + '.' + randomUUID() + '.tmp'
          )
          const output = await open(temporary, 'wx')
          try {
            await output.writeFile(bytes)
            await output.sync()
          } finally {
            await output.close()
          }
          try {
            const latest = await bytesAt(target)
            if (
              (before === null) !== (latest === null) ||
              (before && latest && !before.equals(latest))
            )
              throw Error('目标文件已经改变，请重新导出。')
            await rename(temporary, target)
          } finally {
            await rm(temporary, { force: true }).catch(() => undefined)
          }
          return { path: target, missingImages: ready.missingImages as number }
        } finally {
          window?.destroy()
          // Only this mkdtemp-owned directory is removed; manuscripts and destination files are separate.
          const part = relative(await realpath(tmpdir()), await realpath(directory))
          if (!isAbsolute(part) && part.startsWith('zhumo-pdf-') && !part.includes('..'))
            await rm(directory, { recursive: true, force: true }).catch(() => undefined)
        }
      })
    pending = task.then(
      () => undefined,
      () => undefined
    )
    return task
  })
}
