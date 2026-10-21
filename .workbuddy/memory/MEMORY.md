# rag-frontend — 项目长期备忘

## 定位
RAG 系统的前端工程，目录 `H:/work/rag-frontend`。
同目录下另有 `.venv`（Python 3.14.7）与 PyCharm 工程 `.idea`，属后端/工具链用途；**前端构建只依赖 Node.js**，不要试图用 venv 里的 Python 去跑 Vite。

## 技术栈基线
- 构建：Vite 8 + `@vitejs/plugin-react`；Node 22.22.2（托管运行时）
- 语言：TypeScript 6（`tsconfig.app.json` / `tsconfig.node.json` / `tsconfig.json`）
- UI：React 19 + antd 6 + `@ant-design/icons` 6
- 状态：zustand 5
- 路由：react-router 8 —— **v8 已移除 `react-router-dom` 包**，`createBrowserRouter` 等从 `react-router` 导入，`RouterProvider` 从 `react-router/dom` 导入
- 请求：axios 1
- Lint：oxlint（非 ESLint）
- 脚本：`npm run dev` / `build`（tsc -b && vite build）/ `lint` / `preview`

## 约定
- npm 源固定 `https://registry.npmmirror.com`（项目 `.npmrc` 已固化，勿改回 taobao 旧域名）。
- 按 antd v6 API 写代码，不要套用 v5 教程写法。
- **目录非空时禁止使用 `create-vite --overwrite`**（会删除 `.venv`/`.idea`）。改用「临时子目录 + `mv -n` 提升」的方式。
- 后续如需流程图用 `@antv/x6` v3，流式对话用 `@microsoft/fetch-event-source`（注意 npm 上不存在 `sse-util` 这个包）。
- `tsconfig` 开启了 `verbatimModuleSyntax`（类型必须 `import type`）、`erasableSyntaxOnly`（禁 enum / 构造函数参数属性）、`noUnusedLocals`。

## 请求层约定（`src/api`）
- 业务代码统一 `import { get, post, put, patch, del } from '@/api'`（或相对路径），**不要直接 import axios**。
- `get<T>()` 等的泛型 `T` 就是解包后的业务数据类型。
- 包裹体判定保留为兼容（`SUCCESS_CODES`/`isEnvelope`，见 `src/api/types.ts` 与 `http.ts`），但**真实后端没有外壳**（见下节），这两处实际恒不命中。

## 后端契约（rag-backend，FastAPI @ 127.0.0.1:8000，前缀 /api/v1）
- **成功响应是裸对象/数组，无 `{code,message,data}` 外壳**；错误是非 2xx + `{code: string, message, detail}`。
- auth 仅 `POST /auth/login`、`/auth/register`；**无 logout / me**（`logout()` 只清本地态；没有注册 UI，
  故 `AUTH_ENDPOINTS` 只留 login，早先的 `fetchProfile()`/`register` 常量已作为死代码删除）。
- **会话历史在服务端 Redis**（2026-10-17 起，localStorage 版已删）：`src/api/modules/conversations.ts` 是
  `/conversations` 的 HTTP 封装（list/get/delete + `summarizeChatStats`）。会话的**写**在问答链路：
  请求带 `conversation_id` → 服务端读 Redis 历史进提示词、答完落库（含溯源 文件名+页码）；首问不带 →
  服务端生成并从 `done.conversationId` 回传，前端 setConversationId 后续轮带上。**带会话 ID 时不发
  history**（发了也被忽略）；服务端未配 Redis 时 done 无 ID → 自动退回本地 history 兜底，同一套代码
  两种部署都成立。后端 503（REDIS_URL 未配置）时知识库页统计静默显示 0。
- 文档挂在知识库下：`GET/POST /knowledge-bases/{kbId}/documents`（单文件上传字段名 `file`）、`POST .../documents/batch`（字段名 `files`）、`DELETE /documents/{id}`；无 stats / 重处理 → KB 统计用 `computeKbStats` 前端聚合，文档状态归一 `ready→done`。
- 单文件上传走 `uploadDocument(file, kbId, { onProgress })`，用 axios `onUploadProgress` 拿字节进度；**后端是同步入库**，进度 100% 只代表字节发完，请求仍要等索引结束。逐文件上传不比批量慢（后端 `ingest_batch` 本身串行）。
- ⚠️ 后端入库曾把服务挂死：上传后进程存活但事件循环彻底阻塞（0% CPU / 126 线程等待 / 所有请求超时），DB 里文档永久停留 `processing`。疑似空闲数小时后首次 Milvus gRPC（upsert）调用无超时所致。**重启方式**：`taskkill //F //PID <pid>`，等约一分钟让 8000 上的连接残留释放（期间重绑会报 10048，netstat 反而查不到监听者，属正常），再 `.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000`（可去掉 `--reload`）。健康进程下小文件上传 6 秒内完成。
- KB 更新是 PUT 全量对象（name+description），无状态流转接口。
- KB 行「操作」菜单为**「查看文档 / 编辑 / 删除」**（2026-10-13 深夜曾改为「编辑/归档/删除」+ 本地归档标记，随后按用户要求**整体回退**：归档接口/徽标/CSS 全部移除，用户浏览器里可能残留的 `rag:archived-kbs` localStorage 键已无人读取、属惰性数据）。KB 库级状态徽标由文档状态派生（空库/处理中/部分失败/就绪），状态列渲染勿再注释——`statusOf` 无人引用会触发 `noUnusedLocals` 构建失败。
- chat 请求体 `{kb_id(必填), question, history, top_k?, rerank_k?, enable_retry?}`；SSE 事件
  `retry?|sources|delta|done|error`，data 是 `{"type":...}` JSON，顺序 `retry? → sources → delta×N → done`。
- **`enable_retry` 是三态**（2026-10-15）：`true`/`false` = 用户的选择，**必须原样发**；
  `undefined` = 不发字段 → 服务端默认值生效。写成 `if (!enableRetry)` 会让「用户关掉开关」被
  服务端默认值悄悄推翻（变异 M1 抓的就是它）。默认值只由服务端持有：`GET /chat/options`
  （`stream_retry_default` / `stream_retry_max_attempts` / `stream_events`），**前端不要抄一份**；
  读不到就置灰开关、不发字段，绝不猜一个可能相反的值写上去。
- **`done` 事件带收尾事实** `{refused, retried, attempts, can_retry, query}`（后端 `_done_event`
  唯一产出，字段集恒定）。`can_retry=true` ⇒ 气泡里弹「再找一次」：`retry(messageId)` **复用同一条
  助手消息**、强制 `enable_retry=true`、history 里丢掉紧邻的用户消息（否则同一问送两遍）。它与顶栏
  的预设开关是**互补的两条路**（那个管"以后都这样"，这个管"这一问再试一次"），不是两套逻辑。
- baseURL：`.env.development` 的 `VITE_API_BASE_URL=/api/v1`；`config.ts` 的 DEFAULT_BASE_URL 也是它（生产无 env 文件也正确）。
- 联调测试数据：账号 `demo/demo123456`，KB「联调测试库」（含 chunk-intro.txt）；E2E 脚本留存于 `.workbuddy/tmp/verify-*.mjs`（Chrome headless + CDP）。
- 单个请求开关（已通过 `declare module 'axios'` 扩展类型）：`skipAuth`（不注入 token）、`skipAuthRedirect`（401 不触发清登录态与跳转）、`skipErrorToast`（不弹全局提示）、`rawResponse`（跳过解包，拿完整 AxiosResponse）。
  ⚠️ **这些开关在 HTTP 错误路径上生效的前提**是响应拦截器的 `onRejected` 把 `error.config` 传进了 `reportFailure` —— 改拦截器时别漏，历史 bug 就出在这（曾导致登录 401 误触发跳转并误弹提示）。
- 错误统一为 `ApiError`：`kind`(business/http/network/timeout/canceled/unknown)、`status`、`code`、`data`、`isUnauthorized`、`isRetryable`；取文案用 `getErrorMessage(e)`。
- 401 行为：清 token → 广播 `auth:unauthorized` → 跳 `/login?redirect=`。跳转实现由 `src/layouts/RootLayout.tsx` 通过 `setUnauthorizedHandler()` 注入为**前端路由跳转（无刷新）**；`REDIRECT_TO_LOGIN_ON_401` 仅在未接入路由时作整页跳转兜底。
- 全局错误提示走 `src/utils/notify.ts` 的可插拔出口，由 `AntdNotifierBridge`（在 `<AntdApp>` 内）注册 antd message 实例；**不要在请求层直接 import antd**。
- Token 存在 `src/store/auth.ts` 的 zustand store（key `rag:auth`）。持久化是**双介质**的：勾选「记住我」写 localStorage，否则写 sessionStorage；读取时按命中的介质纠正策略，刷新后不漂移。该文件**不能**反向 import `src/api`，否则循环依赖。
- 新增接口模块建议放 `src/api/modules/*.ts`，从 `src/api` 出口统一导出。

## 路由与页面约定（`src/router`）
- 路由表在 `src/router/index.tsx`：`RootLayout`（外壳，挂 401 无刷新跳转）→ `/login` 公开；`RequireAuth`（守卫）→ `AppLayout`（应用外壳：侧边导航 + 顶栏）→ 页面（`/` 重定向 `/knowledge-base`、`/documents`、`/chat`（支持 `?id=` 打开历史会话）、`/conversations`、`*` 404）。
- **新增需要登录的页面，直接加进 `AppLayout` 的 children**，不要各自写鉴权判断。
- 守卫只判断「有没有 token」，token 是否有效交给后端 401 统一处理（`api/unauthorized.ts`）。
- 页面放 `src/pages/<Name>/index.tsx`，样式同名 `index.css` 或 `<name>.css`；全局样式只留 `src/index.css` 的 reset。
- 登录相关：`src/api/modules/auth.ts` 集中登录/登出/用户信息与**字段归一化**（`TOKEN_KEYS` / `USER_KEYS` / id、username 回退）。后端字段命名不同时**只改这个文件**，业务代码不动。
- 登录后跳转目标必须过 `src/utils/redirect.ts` 的 `safeRedirect()`（只允许单斜杠开头的站内相对路径，防开放重定向）。
- **删除操作防重复提交约定**（三个页面已实现，新增删除入口照此办理）：`deletingId` state（驱动按钮 loading/disabled）+ `deletingRef`（真正的重入开关，finally 复位）；`onOk` 必须返回 Promise 让 antd 自动 loading；删除中禁止取消/关闭弹窗（`closable={!deleting}`、cancel disabled）。**注意：`modal.confirm` 的 onOk 闭包捕获的是创建时的 state，重入判断必须走 ref，不能读 state。**

## 无 mock / 无 599 约定（2026-10-13 起 mock 层与 599 代理标记均已移除）
- `src/api/mock.ts`、`src/api/modules/chatMock.ts` 已删除；`withMock`/`shouldUseMock`/`isNetworkError`/`fakeChatStream`/`streamChatSmart` 不再存在，`VITE_USE_MOCK` 也从 `.env.development` 与 `env.d.ts` 移除。**后端不在时没有任何兜底数据**：请求直接报错。
- **599 代理标记机制也已删除（用户明确要求）**：`vite.config.ts` 不再有 `proxy.on('error')` 兜底、`config.ts` 的 `PROXY_UNREACHABLE_STATUS` 与 `error.ts` 的 `BACKEND_UNREACHABLE_MESSAGE` 均已移除。后端不可达时走 Vite 默认行为：**502 Bad Gateway + 空 body → 页面显示「网关错误」**（`HTTP_STATUS_MESSAGE[502]`），登录仍被拦在登录页、不写 `rag:auth`。若想恢复更明确的文案，重新给代理加 error handler 并在 error.ts 加回 599 分支即可。
- 流式对话 `useChatStream` 直连 `src/api/modules/chat.ts` 的 `streamChat`（不再经 chatMock 转发）。
- 三个数据模块（kb/documents/conversations）的所有请求都带 `skipErrorToast: true`，错误由页面 catch 处理；新增模块照此办理，避免列表请求失败时先弹全局「连接失败」。
- **页面 catch 必须跳过取消**：React StrictMode 双挂载会中断第一批请求，页面级 catch 里用 `isCanceled(error)`（`src/api/error.ts`）判定后再弹提示，否则每次进页面都会闪一个「请求已取消」toast。
- 模块内的字段归一化（normalizeXxx + 各类 KEY 常量）是后端字段名不一致时的唯一修改点。

## 本机环境注意事项（踩过的坑）
- shell 里有全局 `http_proxy=http://127.0.0.1:56648`：`curl` 访问 localhost 必须加 `--noproxy '*'`；**Node 侧 axios 会读它**，跑 Node 接口测试要先 `delete process.env.http_proxy`，否则请求以 absolute-form 走代理。浏览器端不受影响。
- Git Bash 的 `kill` 杀不掉 Windows 原生进程，用 `taskkill //F //PID <pid>`（PID 从 `netstat -ano` 取）。
- **Windows 上 `WinError 10013` 多半是端口被占，不是权限/防火墙**：与占用者绑定同一个**具体地址**时，双方都设 `SO_REUSEADDR` 则 bind 返回 `WSAEACCES(10013)`，未设则返回 `WSAEADDRINUSE(10048)`。判据：`netstat -ano -p tcp | awk '$2 ~ /:8000$/'` 看监听者；用 venv python 分别试绑 `127.0.0.1` 与 `0.0.0.0`，若后者成功说明占用者绑的是具体地址。排除系统保留端口用 `netsh int ipv4 show excludedportrange protocol=tcp`（本机仅保留 `50000-50059`）。
- **本会话后台起的 uvicorn 实例不会随"以为的会话结束"退出**：曾导致用户自启后端报 10013。交接前务必 `tasklist | grep python` 确认没有残留占用 8000。
- Vite 默认绑 `localhost` → 本机解析为 IPv6 `[::1]`；自测建议显式 `--host 127.0.0.1`。
- 端口 5173 被非本会话的 node 进程长期占用，`npm run dev` 会静默退到 5174。
- ⚠️ **5180 也被占**：更早的验证脚本（`verify-chat.mjs`）留下的 vite 没退干净，一直 LISTENING。
  它让新起的 vite（`--strictPort`）**静默**失败，而"readiness 探测 `${APP}/`"照样 200——
  只有探 `/api/v1/chat/options` 看**响应体**才能证伪。验证脚本要用独立端口 + 起完先探代理响应体。
- ⚠️ 用 npm 起子进程后 `kill` 只杀得到 npm 外壳，vite 会留在端口上 → 验证脚本里直接
  `node node_modules/vite/bin/vite.js` 起（`process.execPath`），kill 才杀得到正主。
- ⚠️ **Milvus 起不来时前端也能做端到端**：用 node:http 写一个脚本化 SSE 替身（报文逐字抄后端
  `_sse_format`），vite 代理指过去即可。比真后端更能把"事件序列 + 请求体字段"钉死，因为拒答那
  一路本来就要"检索不到"。参考 `.workbuddy/tmp/verify-chat-retry.mjs`（+ 同目录 mutations 变异驱动）。
- 后端接口带不带 `/api` 前缀决定 `vite.config.ts` 里代理 `rewrite` 是否要打开（当前注释状态，默认 /api 前缀原样转发到 8000）。

## 渲染 SPA 原型 / 无头浏览器验证
- agent-browser 自带的 Chromium 下载被墙（storage.googleapis.com）。**用系统 Chrome headless**：`"C:/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --dump-dom|--screenshot --virtual-time-budget=20000 <url>`。
- 加 `--proxy-server='direct://' --proxy-bypass-list='*'` 强制直连（绕开系统代理）。
- 需要登录态的页面：起 Chrome 带 `--remote-debugging-port=9333`，Node 22 内置 WebSocket 走 CDP，`Runtime.evaluate` 预置 localStorage（zustand persist 格式 `{"state":{...},"version":0}`），再 `Page.navigate` + `Page.captureScreenshot`。
- headless Chrome 从 `&` 后台起的会随 Bash 命令结束被回收，Chrome 启动 + CDP 操作要在**同一条命令**里完成。
- `Runtime.evaluate` 抛异常不会让 CDP 调用 reject（错误在 `exceptionDetails` 里），脚本必须显式检查，否则失败被静默吞掉。
- **antd v6 改了多处类名，写自动化测试别照抄 v5 选择器**：
  Select 内容区 `.ant-select-selector` → **`.ant-select-content`**（触发用外层 `.ant-select`，input 是 `.ant-select-input`）；
  Drawer 内容区 `.ant-drawer-content` → **`.ant-drawer-section`**（`.ant-drawer-body` 仍在）；
  Modal 内容区 `.ant-modal-content` → **`.ant-modal-container`**。
  下拉选项仍是 `.ant-select-item-option`。
- **弹窗按钮区有两套类名**：受控 `<Modal>` 用 `.ant-modal-footer`；`modal.confirm` 用 **`.ant-modal-confirm-btns`**。选择器写 `'.ant-modal-footer, .ant-modal-confirm-btns'` 兼容。
- **antd 给两字中文按钮插空格**（「删 除」「取 消」「创 建」），脚本按文本匹配先 `innerText.replace(/\s+/g,'')`，或直接用 `button.ant-btn-primary`。
- **rc-menu 菜单项不能用合成事件点**：`dispatchEvent` 的 mousedown 会让菜单重渲染并替换 DOM 节点，旧节点上的 click 落空。必须用 CDP `Input.dispatchMouseEvent`（mouseMoved → mousePressed → mouseReleased，坐标取 `getBoundingClientRect()` 中心）。
- **要采样"请求进行中"的瞬时 UI 状态（loading 等）**：用 CDP `Fetch.enable` + `requestPaused` 把目标请求人为延迟 2s+（`Fetch.continueRequest`），期间即可断言按钮 loading/disabled。参考脚本 `.workbuddy/tmp/verify-delete-loading.mjs`。
- 复用同一 `--user-data-dir` 时 localStorage 登录态会残留，导航 `/login` 会被重定向走；自动化脚本要先 `localStorage.clear()` 再导航到登录页。
- **联调前先确认后端「能响应」而不只是「端口在听」**：`curl --noproxy '*' -m 5 .../api/v1/health` 能返回才算活。踩过一次坑：后端进程存活、8000 可连，但事件循环已挂死（0% CPU / 126 线程全等），所有请求 20s 无响应，导致上传验证卡在「上传中」。

## SSE / 流式对话约定
- 底层用 `@microsoft/fetch-event-source` v2（原生 EventSource 只支持 GET，RAG 对话需要 POST + Header）。**不要绕过 `src/api/sse.ts` 直接用 fetch**，否则丢掉 token 注入、401 处理、重连控制与空闲超时。
- `streamSSE(url, options, handlers)` 是协议无关的传输层；`streamChat(request, handlers, options)` 是对话协议层。业务代码一般只用 `streamChat` 或 `useChatStream`。
- 后端换了流式协议，**只改 `options.decode`**（或在 `src/api/modules/chat.ts` 改 `decodeChatChunk`），不要动 `sse.ts`；接口地址改 `CHAT_ENDPOINT` 或传 `options.endpoint`。
- `decodeChatChunk` 要认 `event: retry` 与 `event: done` 的**事件体**：done 是唯一携带收尾事实的
  事件，把它丢成裸 `{type:'done'}` 会让「再找一次」永远不出现且**没有任何报错**（变异 M5）。
  `can_retry` 缺字段时保守取 `false`：宁可少弹一次提示，不给用户一个点了没用的按钮。
- 错误语义：出错 **reject** 成 ApiError；被 `signal` 取消则 **resolve** 并带 `aborted: true` + 已生成的部分内容。
- 重连策略：默认 `maxRetries = 0`（不重连）。因为流式对话重放请求会导致答案重复，只有在「尚未收到任何内容」时才允许重连。
- 空闲超时默认 60s（`DEFAULT_IDLE_TIMEOUT`），每收到一条消息重置；服务端不断连而卡死时靠它兜底。
- 配置与 401 处理在 `src/api/config.ts` 与 `src/api/unauthorized.ts`，axios 与 SSE 共用，改一处即可。
- `src/hooks/useChatStream.ts` **不要**从 `src/api/index.ts` 导出（会把 React 拖进请求层依赖图）。

## 本机 IDE 环境（PyCharm）
- **实际在用 PyCharm Community Edition 2024.2**（build `PC-242.20224.347`，装在 `E:\JetBrains\PyCharm Community Edition 2024.2`），装了 Qoder 插件。
  `C:\Users\Administrator\AppData\Local\Programs\PyCharm Professional 2025.3` 存在但**从未启动**（无 `PyCharm2025.3` 配置目录），排查时别当成用户环境。
- 双窗口打开项目的**关键开关**：`AppData\Roaming\JetBrains\PyCharmCE2024.2\options\ide.general.xml` 里的
  `confirmOpenNewProject2`。取值语义（`com.intellij.ide.GeneralSettings`，源码 `GeneralSettings.kt`）：
  `ASK=-1`（每次弹框）/ `NEW_WINDOW=0`（总是新窗口）/ `SAME_WINDOW=1`（总是替换当前窗口）/ `SAME_WINDOW_ATTACH=2`。
  **值为 1 时任何打开入口都不会弹框、也开不出第二个窗口**。
- 排查 JetBrains 内部行为的手段：反编译 `lib/app-client.jar` 里的 class（`E:\java11\bin\javap.exe -p -constants -cp <解压目录> <类名>`，`jbr\bin` 下没有 javap）；
  实时日志 `AppData\Local\JetBrains\PyCharmCE2024.2\log\idea.log`；已打开项目见 `options\recentProjects.xml` 的 `opened="true"`。
- 本机相关项目路径：`H:/work/rag-backend`、`H:/work/rag-frontend`、`H:/workSpace/{ai‑knowledge‑rag, agent-rag, rag-backend, rag-frontend}`。
