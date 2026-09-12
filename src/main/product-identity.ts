export type ProductChannel = 'preview' | 'preview-ai' | 'preview-theme' | 'stable'
export interface ProductIdentity {
  channel: ProductChannel
  appId: string
  profileFolder: string
  title: string
}
const identities: Record<ProductChannel, ProductIdentity> = {
  preview: {
    channel: 'preview',
    appId: 'com.zhumo.reader.preview',
    profileFolder: 'ZhuMo-2.0-preview',
    title: '朱墨 2.0 预览'
  },
  'preview-ai': {
    channel: 'preview-ai',
    appId: 'com.zhumo.reader.ai-preview',
    profileFolder: 'ZhuMo-AI-preview',
    title: '朱墨 · AI 细读'
  },
  'preview-theme': {
    channel: 'preview-theme',
    appId: 'com.zhumo.reader.chaosheng',
    profileFolder: 'ZhuMo-Chaosheng-preview',
    title: '朱墨 · 潮光'
  },
  stable: {
    channel: 'stable',
    appId: 'com.zhumo.reader.v2',
    profileFolder: 'ZhuMo-2.0',
    title: '朱墨 2.0'
  }
}

/** Product and profile identity must survive a version-number change. */
export function productIdentity(metadata: { zhumoChannel?: unknown }): ProductIdentity {
  const channel = metadata.zhumoChannel
  if (typeof channel !== 'string' || !Object.hasOwn(identities, channel))
    throw Error('此构建没有明确的朱墨产品身份，未打开任何阅读资料。')
  return { ...identities[channel as ProductChannel] }
}
export function allowsFileAssociations(
  product: ProductIdentity,
  packaged: boolean,
  background: boolean
): boolean {
  return process.platform === 'win32' && product.channel === 'stable' && packaged && !background
}
