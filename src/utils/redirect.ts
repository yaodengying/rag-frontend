/** 站内默认落地点 */
export const DEFAULT_REDIRECT = '/'

/**
 * 校验登录后的跳转目标。
 *
 * 只接受站内相对路径，挡住 `?redirect=//evil.com`、`?redirect=https://evil.com`
 * 这类开放重定向——攻击者可以用登录页把你的用户带去钓鱼站点。
 * 不符合要求时回退到 `fallback`。
 */
export function safeRedirect(raw: string | null | undefined, fallback: string = DEFAULT_REDIRECT): string {
  if (!raw) {
    return fallback
  }
  // 必须以单个 / 开头：排除绝对地址（http://...）与协议相对地址（//...）
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    return fallback
  }
  return raw
}
