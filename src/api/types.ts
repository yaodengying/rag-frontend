/**
 * 请求层公共类型与常量。
 *
 * 当前后端（rag-backend / FastAPI）的契约：
 *   - **成功**：直接返回业务对象或数组，**没有** `{ code, message, data }` 包裹体。
 *     例如 `POST /api/v1/auth/login` → `{ access_token, token_type, ..., user }`。
 *   - **失败**：非 2xx 状态码 + `{ code: <字符串>, message, detail }`
 *     （如 `{"code":"not_found","message":"知识库不存在","detail":null}`）。
 *     因为走的是 HTTP 错误分支，不会经过下面的 `isEnvelope` 解包。
 *
 * 所以 `isEnvelope` 在本项目里实际恒为 false —— 保留它是为了让请求层仍兼容
 * 「有包裹体」的后端；换成包裹体风格的后端时无需改 `http.ts`。
 */

export interface ApiResponse<T = unknown> {
  code: number | string
  message?: string
  msg?: string
  data: T
}

/**
 * 视为「业务成功」的 code 取值，兼容数字与字符串两种写法。
 * 仅在响应体被识别为包裹体时才参与判断（见 `http.ts` 的 `isEnvelope`）。
 */
export const SUCCESS_CODES: readonly (number | string)[] = [0, 200, '0', '200']

/**
 * 扩展 AxiosRequestConfig，给单个请求挂上行为开关。
 * 用法：`get('/x', params, { skipAuth: true })`
 */
declare module 'axios' {
  interface AxiosRequestConfig {
    /** 不注入 Authorization 头（登录、刷新 token、公开接口等） */
    skipAuth?: boolean
    /**
     * 401 时不触发「清登录态 + 跳转登录页」。
     * 登录、刷新 token、校验凭据这类接口的 401 属于业务结果，应交给调用方处理。
     */
    skipAuthRedirect?: boolean
    /** 出错时不弹全局提示，交由调用方自行处理 */
    skipErrorToast?: boolean
    /** 直接返回 axios 原始响应，跳过 code 校验与 data 解包 */
    rawResponse?: boolean
  }
}
