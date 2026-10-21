/**
 * 变异实验：把「流式是否重试」前端实现改坏，确认端到端断言能抓到。
 *
 * 两条硬规矩（都踩过）：
 *  1. 每个变异必须从**干净基线**出发——上一个变异的破坏累积下来会让失败签名互相污染，
 *     看起来"都抓到了"，其实结论无效；
 *  2. 判定"是否被抓到"不能只看 `[FAIL]` 字样——改坏代码可能让脚本直接崩（没有 FAIL 行，
 *     只有"流程中断"），必须同时看**退出码**与汇总行。
 *
 * 运行：node .workbuddy/tmp/verify-chat-retry-mutations.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const ROOT = 'H:/work/rag-frontend/'
const E2E = '.workbuddy/tmp/verify-chat-retry.mjs'

const FILES = [
  'src/api/modules/chat.ts',
  'src/hooks/useChatStream.ts',
  'src/store/chat.ts',
  'src/pages/Chat/index.tsx',
]

const backup = new Map(FILES.map((f) => [f, readFileSync(ROOT + f, 'utf8')]))
const restoreAll = () => {
  for (const [file, text] of backup) {
    writeFileSync(ROOT + file, text)
  }
}

const mutations = [
  {
    id: 'M1',
    label: 'enable_retry 的发字段判断退化成真值判断（false 被吞掉）',
    file: 'src/api/modules/chat.ts',
    find: '...(request.enableRetry !== undefined ? { enable_retry: request.enableRetry } : {}),',
    replace: '...(request.enableRetry ? { enable_retry: request.enableRetry } : {}),',
  },
  {
    id: 'M2',
    label: '「再找一次」不强制 true，改用预设开关的值',
    file: 'src/hooks/useChatStream.ts',
    find: 'await runTurn(question, messageId, collectHistory(before), true)',
    replace: 'await runTurn(question, messageId, collectHistory(before), optionsRef.current.enableRetry)',
  },
  {
    id: 'M3',
    label: '不写入 canRetry（「再找一次」永不出现）',
    file: 'src/hooks/useChatStream.ts',
    find: '            canRetry: result.done?.canRetry ?? false,',
    replace: '            canRetry: false,',
  },
  {
    id: 'M4',
    label: '重试时 history 不丢弃紧邻的用户消息（同一问送两遍）',
    file: 'src/hooks/useChatStream.ts',
    find: `      if (before.length > 0 && before[before.length - 1].role === 'user') {
        before.pop()
      }`,
    replace: '      // mutation: 故意不丢弃紧邻的用户消息',
  },
  {
    id: 'M5',
    label: 'done 事件丢掉收尾事实（收尾信息不解析）',
    file: 'src/api/modules/chat.ts',
    find: `  if (eventName === 'done') {
    return [buildDoneEvent(safeJsonParse(raw))]
  }`,
    replace: `  if (eventName === 'done') {
    return [{ type: 'done' }]
  }`,
  },
  {
    id: 'M6',
    label: '开关初值不读服务端默认值（写死 false）',
    file: 'src/pages/Chat/index.tsx',
    find: `        setChatOptions(options)
        setRetryEnabled(options.streamRetryDefault)`,
    replace: `        setChatOptions(options)
        setRetryEnabled(false)`,
  },
]

function runE2E() {
  try {
    const out = execFileSync(process.execPath, [E2E], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300000,
    })
    return { code: 0, out }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

console.log('=== 基线：确认干干净净的实现是全绿的 ===')
let base = runE2E()
const baseOk = base.code === 0 && base.out.includes('全部通过')
console.log(`  基线 ${baseOk ? '全绿' : '不绿（后续结论无效）'}  退出码=${base.code}  ${base.out.trim().split('\n').pop()}`)
if (!baseOk) {
  restoreAll()
  process.exit(1)
}

const summary = []
for (const m of mutations) {
  restoreAll()
  const path = ROOT + m.file
  const text = readFileSync(path, 'utf8')
  const hits = text.split(m.find).length - 1
  if (hits !== 1) {
    console.log(`\n[${m.id}] 锚点未命中（命中 ${hits} 次），跳过`)
    summary.push({ id: m.id, label: m.label, caught: false, note: `锚点命中 ${hits} 次` })
    continue
  }
  writeFileSync(path, text.replace(m.find, m.replace))

  console.log(`\n[${m.id}] ${m.label}`)
  const r = runE2E()
  // 不能只看 [FAIL]：崩溃时没有 FAIL 行，只有「流程中断」
  const caught = r.code !== 0 || /存在失败/.test(r.out) || /流程中断/.test(r.out)
  const failLines = r.out
    .split('\n')
    .filter((line) => line.includes('[FAIL]') || line.includes('流程中断'))
    .map((line) => line.trim())
  console.log(`  → ${caught ? '已抓到' : '未抓到'}  退出码=${r.code}`)
  for (const line of failLines.slice(0, 4)) {
    console.log(`     ${line}`)
  }
  summary.push({ id: m.id, label: m.label, caught, signature: failLines[0] ?? '' })
}

restoreAll()
console.log('\n=== 还原后复跑，确认回到全绿 ===')
const back = runE2E()
const backOk = back.code === 0 && back.out.includes('全部通过')
console.log(`  ${backOk ? '全绿' : '不绿'}  ${back.out.trim().split('\n').pop()}`)

console.log(`\n${'='.repeat(64)}`)
for (const s of summary) {
  console.log(`${s.caught ? '抓到' : '漏掉'}  ${s.id}  ${s.label}`)
}
const caughtCount = summary.filter((s) => s.caught).length
console.log(`\n变异捕获 ${caughtCount}/${summary.length}；还原后${backOk ? '全绿' : '仍不绿'}`)
process.exit(caughtCount === summary.length && backOk ? 0 : 1)
