import { useAuthStore } from '../../store/auth'
import type { AuthUser } from '../../store/auth'
import { ApiError } from '../error'
import { get, post } from '../http'

/**
 * 登录 / 注册 / 当前用户接口。
 *
 * 后端（rag-backend）的认证端点：
 *   POST /auth/login     登录（换发访问令牌）
 *   POST /auth/register  注册（成功即签发令牌，201）
 *   GET  /auth/me        取当前令牌对应的账号（令牌无效 → 401）
 *
 * **没有** /auth/logout：令牌是无状态签名串，服务端不保存会话，
 * 所以「登出」在前端就是清掉本地令牌。
 *
 * 为什么需要 /auth/me：
 *   令牌存在 localStorage，**刷新页面后前端无法判断它是否还有效**
 *   （可能已过期，也可能被管理员停用）。没有这个端点，只能等第一次业务
 *   请求返回 401 才知道——用户会先看到一个空列表、然后才被踢回登录页。
 *
 * 字段命名各家不同，这里仍保留归一化：token、用户对象都从常见字段名里按优先级取。
 */

export const AUTH_ENDPOINTS = {
  login: '/auth/login',
  me: '/auth/me',
} as const

export interface LoginPayload {
  username: string
  password: string
}

/** token 可能出现的字段名，按优先级排列 */
const TOKEN_KEYS = [
  'token',
  'accessToken',
  'access_token',
  'access-token',
  'jwt',
  'idToken',
  'id_token',
] as const

/** 用户对象可能出现的字段名，按优先级排列 */
const USER_KEYS = ['user', 'userInfo', 'user_info', 'profile', 'account', 'admin'] as const

const USER_ID_KEYS = ['id', 'userId', 'user_id', 'uid'] as const

const USERNAME_KEYS = [
  'username',
  'userName',
  'user_name',
  'name',
  'account',
  'nickname',
] as const

export interface LoginResult {
  /** 已归一化的 token */
  token: string
  /** 归一化后的用户信息；后端未返回时为 null */
  user: AuthUser | null
  /**
   * 令牌过期时刻（毫秒时间戳）；后端未给出时为 null。
   * 只用于"本地能看出肯定过期"时省一次请求，真实判据仍是服务端 401。
   */
  expiresAt: number | null
  /** 后端原始返回体，字段命名特殊时可从这里自行取值 */
  raw: unknown
}

export interface LoginOptions {
  /**
   * 静默模式：不弹全局错误提示，由调用方内联展示。
   * 登录页需要把「用户名或密码错误」显示在表单上，因此默认开启。
   */
  silent?: boolean
  signal?: AbortSignal
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

/** 按优先级从对象里取第一个非空标量并转成字符串 */
function pickText(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return undefined
}

/**
 * 把后端返回的用户对象归一化成 `AuthUser`。
 * 保证 id / username 两个字段存在（缺失时互相回退），其余字段原样保留。
 */
export function normalizeUser(raw: unknown): AuthUser | null {
  const record = asRecord(raw)
  if (!record) {
    return null
  }

  const id = pickText(record, USER_ID_KEYS)
  const username = pickText(record, USERNAME_KEYS)
  // 后端的展示名字段是 display_name；页面上用它做友好显示，取不到就回落登录名
  const displayName = pickText(record, ['display_name', 'displayName', 'nickname']) ?? username

  return {
    ...record,
    id: id ?? username ?? '',
    username: username ?? id ?? '',
    displayName,
  }
}

/**
 * 从登录响应里解析过期时刻（毫秒时间戳），取不到返回 null。
 *
 * 优先 `expires_at`（绝对时刻，后端 `TokenOut` 给的就是这个），
 * 其次 `expires_in`（相对秒数）。两者都没有就不要硬算——
 * 前端自己拍一个默认有效期，等于凭空造出一个"看起来权威"的错误结论。
 */
export function normalizeExpiresAt(source: Record<string, unknown>): number | null {
  const absolute = pickText(source, ['expires_at', 'expiresAt'] as const)
  if (absolute) {
    const parsed = Date.parse(absolute)
    if (Number.isFinite(parsed)) {
      return parsed
    }
    // 后端偶尔给纯数字字符串（epoch 秒或毫秒）
    const asNumber = Number(absolute)
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber > 1e12 ? asNumber : asNumber * 1000
    }
  }

  const relative = pickText(source, ['expires_in', 'expiresIn'] as const)
  if (relative) {
    const seconds = Number(relative)
    if (Number.isFinite(seconds) && seconds > 0) {
      return Date.now() + seconds * 1000
    }
  }

  return null
}

/** 从登录响应里取出 token 与用户信息，取不到 token 视为失败 */
export function normalizeLoginResult(data: unknown): LoginResult {
  // 少数后端直接返回一个 token 字符串
  if (typeof data === 'string') {
    const token = data.trim()
    if (!token) {
      throw new ApiError({ kind: 'business', message: '登录失败：响应中缺少 token' })
    }
    return { token, user: null, expiresAt: null, raw: data }
  }

  const record = asRecord(data)
  const token = record ? pickText(record, TOKEN_KEYS) : undefined

  if (!token) {
    throw new ApiError({
      kind: 'business',
      message: '登录成功，但响应里没有识别到 token 字段，请在 auth.ts 的 TOKEN_KEYS 中补充',
      data,
    })
  }

  const userSource = record
    ? USER_KEYS.map((key) => record[key]).find((value) => asRecord(value))
    : undefined

  return {
    token,
    user: normalizeUser(userSource),
    expiresAt: record ? normalizeExpiresAt(record) : null,
    raw: data,
  }
}

/**
 * 登录。
 *
 * 三个刻意为之的请求选项：
 *  - `skipAuth`：不带旧 token（否则后端可能因为过期 token 直接拒绝）；
 *  - `skipAuthRedirect`：密码错误返回 401 属于业务反馈，不该触发「跳转登录页」；
 *  - `skipErrorToast`：默认由登录页内联展示错误。
 *
 * 没有后端时这里直接抛错（错误文案由 `error.ts` 统一给出），
 * 不会再有本地假登录——所有数据都必须来自真实接口。
 */
export async function login(
  payload: LoginPayload,
  options: LoginOptions = {},
): Promise<LoginResult> {
  const data = await post<unknown>(
    AUTH_ENDPOINTS.login,
    { username: payload.username, password: payload.password },
    {
      skipAuth: true,
      skipAuthRedirect: true,
      skipErrorToast: options.silent ?? true,
      signal: options.signal,
    },
  )
  return normalizeLoginResult(data)
}

/**
 * 登出。
 *
 * 后端没有登出端点（无状态令牌，服务端不保存会话），
 * 因此这里只做本地清理；保留函数与签名是为了让调用点不必关心后端有没有这个接口。
 */
export async function logout(_options: { silent?: boolean } = {}): Promise<void> {
  useAuthStore.getState().logout()
}

/**
 * 取当前令牌对应的账号，用于**启动时校验令牌是否还有效**。
 *
 * 三个刻意的请求选项：
 *  - `skipAuthRedirect`：401 正是本函数要判断的结果，不该触发"跳登录页"
 *    （跳转由调用方 `RequireAuth` 决定，它清楚当前在哪个页面）；
 *  - `skipErrorToast`：同上，令牌过期不是"操作失败"，无需弹提示；
 *  - 不带 `skipAuth`：本函数的意义就是带上令牌去问。
 *
 * 返回值归一化成 `AuthUser`；后端若只回一个裸对象也能吃下。
 * 令牌无效时抛 `ApiError(status: 401)`，由调用方决定怎么处理。
 */
export async function fetchCurrentUser(options: { signal?: AbortSignal } = {}): Promise<AuthUser> {
  const data = await get<unknown>(AUTH_ENDPOINTS.me, undefined, {
    skipAuthRedirect: true,
    skipErrorToast: true,
    signal: options.signal,
  })
  const user = normalizeUser(data)
  if (!user) {
    throw new ApiError({
      kind: 'business',
      message: '已登录，但 /auth/me 返回的账号信息无法识别',
      data,
    })
  }
  return user
}
