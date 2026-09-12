import type { AiProfileInput } from './ai-types'
/** Context stays application-owned data; only the explicitly saved configuration runs. */
export function createAiRequestCode(profile: AiProfileInput): string {
  return `// messages 已包含选句、阅读上下文与系统提示词；保留它们即可。
// 密钥由软件填入请求头，不要在这里粘贴真实密钥。
return {
  model: ${JSON.stringify(profile.model || 'MODEL_ID')},
${profile.protocol === 'anthropic' ? '  system: request.body.system,\n' : ''}  messages: request.body.messages,
${profile.maxTokens ? `  ${profile.protocol === 'anthropic' ? 'max_tokens' : profile.tokenParameter}: ${profile.maxTokens},\n` : ''}\
  stream: true
};`
}
