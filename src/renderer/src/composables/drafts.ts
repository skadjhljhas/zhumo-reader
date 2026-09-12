export interface Draft {
  id: string
  path: string
  source: string
  savedSource: string
  updatedAt: number
}
const session = (() => {
  try {
    const key = 'zhumo.draft.session'
    const id = sessionStorage.getItem(key) ?? crypto.randomUUID()
    sessionStorage.setItem(key, id)
    return id
  } catch {
    return crypto.randomUUID()
  }
})()
const keyFor = (path: string): string => `${session}:${path}`
let db: Promise<IDBDatabase> | undefined
function database(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('zhumo-recovery', 2)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('drafts-v2', { keyPath: 'id' })
      store.createIndex('path', 'path')
      if (request.result.objectStoreNames.contains('drafts')) {
        const legacy = request.transaction!.objectStore('drafts').getAll()
        legacy.onsuccess = () => {
          for (const draft of legacy.result) store.put({ ...draft, id: `legacy:${draft.path}` })
        }
      }
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close()
        db = undefined
      }
      resolve(request.result)
    }
    request.onerror = () => {
      db = undefined
      reject(request.error)
    }
    request.onblocked = () => {
      db = undefined
      reject(new Error('请关闭其他旧版本窗口，再恢复草稿'))
    }
  })
  return db
}
export async function readDrafts(path: string): Promise<Draft[]> {
  const handle = await database()
  return new Promise((resolve, reject) => {
    const req = handle.transaction('drafts-v2').objectStore('drafts-v2').index('path').getAll(path)
    req.onsuccess = () => resolve((req.result as Draft[]).sort((a, b) => b.updatedAt - a.updatedAt))
    req.onerror = () => reject(req.error)
  })
}

export async function readUntitledDrafts(): Promise<Draft[]> {
  const handle = await database()
  return new Promise((resolve, reject) => {
    const request = handle
      .transaction('drafts-v2')
      .objectStore('drafts-v2')
      .index('path')
      .getAll(IDBKeyRange.bound('zhumo:untitled:', 'zhumo:untitled:\uffff'))
    request.onsuccess = () =>
      resolve(
        (request.result as Draft[])
          .filter((d) => d.path.startsWith('zhumo:untitled:') && d.source !== d.savedSource)
          .sort((a, b) => b.updatedAt - a.updatedAt)
      )
    request.onerror = () => reject(request.error)
  })
}
export async function writeDraft(
  draft: Omit<Draft, 'id'> | null,
  path: string,
  recoveredId?: string
): Promise<void> {
  const handle = await database()
  return new Promise((resolve, reject) => {
    const transaction = handle.transaction('drafts-v2', 'readwrite')
    const store = transaction.objectStore('drafts-v2')
    if (draft) store.put({ ...draft, id: keyFor(path) })
    else {
      store.delete(keyFor(path))
      if (recoveredId) store.delete(recoveredId)
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}
export async function removeRecovery(id: string): Promise<void> {
  const handle = await database()
  return new Promise((resolve, reject) => {
    const transaction = handle.transaction('drafts-v2', 'readwrite')
    transaction.objectStore('drafts-v2').delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
