import { atom, read, update } from 'claude-code'
import type { ElementConstructor, EngineInterface, Register, SvgProps, ToolSpec } from 'claude-code'

import type { ProgressTask } from '../types'

const tasksAtom = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as ProgressTask[])
// 本輪（一次提問到回答結束）開始的時間；沒有在處理時為 null
const turnAtom = atom({ plugin: 'task-progress', key: 'turnStartedAt' } as const, null as number | null)
// 處理中時每個間隔加一，讓面板重畫（動畫）
// 動畫更新間隔（毫秒）：太慢會像卡住
const TICK_MS = 120
const tickAtom = atom({ plugin: 'task-progress', key: 'tick' } as const, 0)

// ---------- i18n：所有會顯示給使用者（或模型）的文字都放在這裡 ----------
type Lang = 'en' | 'zh-TW'
type Strings = {
  /** 附在每個提問旁邊的提醒（只給模型看） */
  guide: string
  panelTitle: (done: number, total: number) => string
  allDone: string
  working: string
  hiddenEarlier: (n: number) => string
  /** 空間不夠時，標題列上「另有幾個任務沒列出」 */
  outside: (n: number) => string
  /** /task-progress list 沒有任務時 */
  noTasks: string
  /** 已經過多久（含單位的字串，例如 12s、3m） */
  elapsed: (t: string) => string
  /** 已完成的任務花了多久 */
  took: (t: string) => string
  /** 回答結束時仍沒開始的任務 */
  unsettled: string
  eta: (t: string) => string
  /** 內建轉圈提示後面接的任務進度 */
  spinner: (done: number, total: number, cur?: { done: number; total: number }) => string
  updated: (n: number) => string
  /** 接在 updated 後面：這次剛完成的任務與耗時 */
  finished: (items: { title: string; took: string }[]) => string
  denyInProgress: (title: string) => string
  commandDesc: string
  cleared: string
  demoLoaded: string
  saverOn: string
  saverOff: string
  demoTitles: readonly [string, string, string, string]
}

const STR: Record<Lang, Strings> = {
  en: {
    guide:
      'Whenever this reply will use any tool, first count the total amount of work, then report progress with mcp__task-progress__set_tasks (not update_plan), even for a single step.',
    panelTitle: (d, n) => `Task progress ${d}/${n}`,
    allDone: 'All done',
    working: 'Working',
    hiddenEarlier: n => `… ${n} earlier task${n === 1 ? '' : 's'} hidden`,
    outside: n => `+${n} not shown (/task-progress list)`,
    noTasks: 'No tasks right now.',
    elapsed: t => `${t} elapsed`,
    took: t => `took ${t}`,
    unsettled: 'not settled',
    eta: t => `~${t} left`,
    spinner: (d, n, cur) => `… tasks ${d}/${n}${cur ? `, current ${cur.done}/${cur.total}` : ''}`,
    updated: n => `Updated ${n} task${n === 1 ? '' : 's'}`,
    finished: items => `; done: ${items.map(i => `${i.title} (took ${i.took})`).join(', ')}`,
    denyInProgress: title =>
      `"${title}" is in_progress, so it must also report total (how many items in all, at least 1) and done (how many are finished, 0 to total). Count the work first, then call again.`,
    commandDesc: 'Task progress panel: list prints every task, demo shows a sample, clear empties it, saver toggles token-saver mode',
    cleared: 'Task progress cleared.',
    demoLoaded: 'Sample tasks loaded; look above the prompt.',
    saverOn:
      'Token-saver mode: ON. The set_tasks definition is no longer attached to every request; Claude loads it only when needed. Takes effect from the next prompt. Run /task-progress saver again to turn it off.',
    saverOff:
      'Token-saver mode: OFF. The set_tasks definition is attached to every request. Takes effect from the next prompt. Run /task-progress saver again to turn it on.',
    demoTitles: ['Survey the folder', 'Reorganize the files', 'Add a README', 'Verify the result'],
  },
  'zh-TW': {
    guide:
      '只要這次回答會用到工具，就先數出總量，並用 mcp__task-progress__set_tasks 回報進度（不要用 update_plan）；一個步驟也要回報。',
    panelTitle: (d, n) => `任務進度 ${d}/${n}`,
    allDone: '全部完成',
    working: '處理中',
    hiddenEarlier: n => `… 前面還有 ${n} 個較早的任務`,
    outside: n => `另有 ${n} 個未列出（/task-progress list）`,
    noTasks: '目前沒有任務。',
    elapsed: t => `已 ${t}`,
    took: t => `用 ${t}`,
    unsettled: '未結算',
    eta: t => `預估剩餘 ~${t}`,
    spinner: (d, n, cur) => `… 任務 ${d}/${n}${cur ? `，進行中 ${cur.done}/${cur.total}` : ''}`,
    updated: n => `已更新 ${n} 個任務`,
    finished: items => `；完成：${items.map(i => `${i.title}（用 ${i.took}）`).join('、')}`,
    denyInProgress: title =>
      `「${title}」是進行中，必須同時回報 total（總共幾件，至少 1）與 done（已完成幾件，0 到 total）。請先把工作量數出來再呼叫。`,
    commandDesc: '任務進度面板：list 列出全部任務，demo 顯示範例，clear 清空，saver 切換省 token 模式',
    cleared: '已清空任務進度。',
    demoLoaded: '已載入範例任務，請看輸入框上方。',
    saverOn:
      '省 token 模式：開。set_tasks 的定義不再附在每次請求裡，Claude 需要時才會載入，下一個提問起生效。再輸入一次 /task-progress saver 可關閉。',
    saverOff:
      '省 token 模式：關。set_tasks 的定義會附在每次請求裡，下一個提問起生效。再輸入一次 /task-progress saver 可開啟。',
    demoTitles: ['盤點資料夾', '整理檔案結構', '補上 README', '驗證結果'],
  },
}

// 把一段文字（語言設定或 locale）對應到支援的語言；認不出來回傳 null
function toLang(v: unknown): Lang | null {
  if (typeof v !== 'string' || v.trim() === '') return null
  if (/繁|台灣|臺灣|traditional|^zh[-_]?(tw|hk|mo|hant)/i.test(v.trim())) return 'zh-TW'
  if (/^en|english|英文/i.test(v.trim())) return 'en'
  return null
}

// 決定介面語言：外掛設定 language（en / zh-TW）優先；auto 時依序看
// Claude Code 自己的語言設定、環境變數 LC_ALL / LC_MESSAGES / LANG、系統 locale；都沒有就用英文
async function resolveLang($: EngineInterface, pref: unknown): Promise<Lang> {
  if (pref === 'en' || pref === 'zh-TW') return pref
  try {
    const row = (await $.config.list()).find(r => r.key === 'language' || r.key === 'responseLanguage')
    if (typeof row?.value === 'string' && row.value.trim() !== '') return toLang(row.value) ?? 'en'
  } catch {
    // 讀不到就往下
  }
  try {
    const g = globalThis as {
      process?: { env?: Record<string, string | undefined> }
      Intl?: { DateTimeFormat: () => { resolvedOptions: () => { locale: string } } }
    }
    const env = g.process?.env
    for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
      const v = env?.[k]
      if (v && v !== 'C' && v !== 'POSIX') return toLang(v) ?? 'en'
    }
    return toLang(g.Intl?.DateTimeFormat().resolvedOptions().locale) ?? 'en'
  } catch {
    return 'en'
  }
}

// 語言只在第一次用到時解析一次（reload 後模組重新載入，會重算）。
// 必須是頂層的函式宣告：驗證器只允許把 $ 傳給這種函式
let stringsCache: Promise<Strings> | undefined
function getS($: EngineInterface, pref: unknown): Promise<Strings> {
  return (stringsCache ??= resolveLang($, pref).then(l => STR[l]))
}

export const register: Register = (on, options) => {
  stringsCache = undefined
  const style = readStyle(options)
  // 請 Claude 用 set_tasks 回報進度（桌面版另有內建的 update_plan，不指示的話它會優先用內建的）
  // 省 token 模式開啟時不加，避免每次請求多帶這段文字
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if ((await $.store.get('tokenSaver')) === true) return result
    return { sections: [...result.sections, { id: 'task-progress:guide', scope: 'session', text: (await getS($, options?.language)).guide }] }
  })

  // 新的提問就是新的一件工作：清掉上一件留下的所有任務，不論有沒有做完（還需要的，Claude 會重新回報）
  on('prompt.submit', async ($, e, next) => {
    await update($, tasksAtom, () => [])
    // 在提問旁邊附一句固定提醒（只給模型看；不讀也不改使用者輸入的文字）。
    // 斜線指令、系統產生的提問、省 token 模式都不附
    if (e.command || e.isMeta || (await $.store.get('tokenSaver')) === true) return next(e)
    return next({ ...e, context: [...(e.context ?? []), (await getS($, options?.language)).guide] })
  })

  // 一輪處理的開始與結束（只看主對話，不看子代理）
  on('turn.start', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) {
      const at = await $.clock.now()
      await update($, turnAtom, () => at)
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) {
      await update($, turnAtom, () => null)
      // 回答結束時結算漏報的任務，進度條才不會卡住：
      // 進行中的視為做完（補上完成時間）；從沒開始的標成「未結算」，不假裝完成
      const at = await $.clock.now()
      await update($, tasksAtom, prev =>
        prev.map(t =>
          t.status === 'in_progress'
            ? { ...t, status: 'completed' as const, doneAt: at, pct: undefined, done: undefined, total: undefined }
            : t.status === 'pending'
              ? { ...t, unsettled: true }
              : t,
        ),
      )
    }
    return next(e)
  })

  // 內建的轉圈提示（Unfurling… (56s · 5.6k tokens)）：在後面接上真實的任務進度
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!style.spinner) return next(e)
    const tasks = await read($, tasksAtom)
    if (tasks.length === 0) return next(e)
    const doneN = tasks.filter(t => t.status === 'completed').length
    const cur = tasks.find(t => t.status === 'in_progress')
    const s = await getS($, options?.language)
    const progress = cur?.total !== undefined && cur.done !== undefined ? { done: cur.done, total: cur.total } : undefined
    return next({ ...e, props: { ...e.props, suffix: s.spinner(doneN, tasks.length, progress) } })
  })

  // /task-progress demo：填入範例任務；/task-progress clear：清空
  on('session.start', async ($, e, next) => {
    $.clock.every(TICK_MS, () => {
      void read($, turnAtom).then(t => {
        if (t !== null) void update($, tickAtom, n => n + 1)
      })
    })
    // 省 token 模式（存在 $.store，換 session 也保留）：開啟時工具定義不再附在每次請求裡
    const saver = (await $.store.get('tokenSaver')) === true
    await $.tool.register(toolSpec(saver))
    await $.command.register({
      name: 'task-progress',
      description: (await getS($, options?.language)).commandDesc,
    })
    return next(e)
  })

  on('command.run', { command: 'task-progress' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    const s = await getS($, options?.language)
    if (arg === 'clear') {
      await update($, tasksAtom, () => [])
      return { text: s.cleared }
    }
    if (arg === 'list') {
      // 完整清單印在對話裡：不受面板高度與 MAX_ROWS 限制
      const tasks = await read($, tasksAtom)
      if (tasks.length === 0) return { text: s.noTasks }
      const now = await $.clock.now()
      const ic = ICONS[style.icons === 'none' ? 'symbols' : style.icons] ?? ICONS.symbols!
      const pct = Math.round(tasks.reduce((sum, t) => sum + eff(t), 0) / tasks.length)
      const doneN = tasks.filter(t => t.status === 'completed').length
      const lines = tasks.map(t => {
        const time = rowTime(t, now, s)
        const p = t.status === 'in_progress' && t.pct === undefined ? '—' : `${eff(t)}%`
        return `${ic[t.status]} ${t.title}  ${p}${time ? `  ${time}` : ''}`
      })
      return { text: [`${s.panelTitle(doneN, tasks.length)}  ${pct}%`, ...lines].join('\n') }
    }
    if (arg === 'saver' || arg === 'saver on' || arg === 'saver off') {
      const wasOn = (await $.store.get('tokenSaver')) === true
      const isOn = arg === 'saver on' ? true : arg === 'saver off' ? false : !wasOn
      await $.store.set('tokenSaver', isOn)
      await $.tool.register(toolSpec(isOn))
      return { text: isOn ? s.saverOn : s.saverOff }
    }
    const now = await $.clock.now()
    const min = 60000
    const [t1, t2, t3, t4] = s.demoTitles
    const demo: ProgressTask[] = [
      { title: t1, status: 'completed', startedAt: now - 6 * min, doneAt: now - 4 * min },
      { title: t2, status: 'completed', startedAt: now - 4 * min, doneAt: now - 1 * min },
      { title: t3, status: 'in_progress', startedAt: now - 1 * min, doneAt: null, pct: 50, done: 1, total: 2 },
      { title: t4, status: 'pending', startedAt: null, doneAt: null },
    ]
    await update($, tasksAtom, () => demo)
    return { text: s.demoLoaded }
  })

  // 每次待辦清單更新時，記錄各任務的開始／完成時間
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const now = await $.clock.now()
    await update($, tasksAtom, prev =>
      e.todos.map(t => {
        const old = prev.find(p => p.title === t.content)
        return {
          title: t.content,
          status: t.status,
          startedAt: t.status === 'pending' ? null : (old?.startedAt ?? now),
          doneAt: t.status === 'completed' ? (old?.doneAt ?? now) : null,
        }
      }),
    )
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if ((e.tool as string) === 'mcp__ccd_turn__update_plan') {
      const ran = await next(e)
      if (ran.deny !== undefined || ran.isError === true) return ran
      const plan = e as unknown as { items?: { content?: string; status?: string }[] }
      const items = (plan.items ?? []).filter(i => typeof i.content === 'string' && i.content !== '')
      const at = await $.clock.now()
      await update($, tasksAtom, prev =>
        items.map(i => {
          const status: ProgressTask['status'] =
            i.status === 'completed' || i.status === 'in_progress' ? i.status : 'pending'
          const old = prev.find(p => p.title === i.content)
          // update_plan 沒有 done/total，進行中的任務不會有真實百分比
          return {
            title: i.content ?? '',
            status,
            startedAt: status === 'pending' ? null : (old?.startedAt ?? at),
            doneAt: status === 'completed' ? (old?.doneAt ?? at) : null,
          }
        }),
      )
      return ran
    }
    if ((e.tool as string) !== 'mcp__task-progress__set_tasks') return next(e)
    const input = e as unknown as {
      tasks?: { title: string; status: ProgressTask['status']; total?: number; done?: number }[]
      reset?: boolean
    }
    const list = input.tasks ?? []
    const bad = list.find(
      t => t.status === 'in_progress' && !(typeof t.total === 'number' && t.total >= 1 && typeof t.done === 'number' && t.done >= 0 && t.done <= t.total),
    )
    if (bad) {
      return { deny: (await getS($, options?.language)).denyInProgress(bad.title) }
    }
    const now = await $.clock.now()
    // 這次呼叫裡剛變成完成的任務與耗時，附在工具結果後面
    const finished: { title: string; ms: number }[] = []
    const turnStart = (await read($, turnAtom)) ?? now
    await update($, tasksAtom, prev => {
      finished.length = 0
      const out: ProgressTask[] = input.reset ? [] : [...prev]
      for (const t of list) {
        const idx = out.findIndex(p => p.title === t.title)
        let old = idx >= 0 ? out[idx] : undefined
        // 沒經過「進行中」就直接完成：開始時間補成上一個完成任務的完成時間（沒有就用本輪開始），避免耗時變成 0s
        if (t.status === 'completed' && !old?.startedAt) {
          const prevDone = out.reduce((m, p) => (p.doneAt !== null && p.title !== t.title ? Math.max(m, p.doneAt) : m), 0)
          const start = Math.min(prevDone > 0 ? prevDone : turnStart, now)
          old = { title: t.title, status: old?.status ?? 'pending', startedAt: start, doneAt: null }
        }
        if (t.status === 'completed' && old && old.status !== 'completed' && old.startedAt) {
          finished.push({ title: t.title, ms: now - old.startedAt })
        }
        const counted = t.status === 'in_progress' && typeof t.total === 'number' && typeof t.done === 'number'
        const pct = counted ? Math.min(99, Math.round(((t.done ?? 0) / (t.total ?? 1)) * 100)) : undefined
        const item: ProgressTask = {
          title: t.title,
          status: t.status,
          startedAt: t.status === 'pending' ? null : (old?.startedAt ?? now),
          doneAt: t.status === 'completed' ? (old?.doneAt ?? now) : null,
          ...(pct === undefined ? {} : { pct, done: t.done, total: t.total }),
        }
        if (idx >= 0) out[idx] = item
        else out.push(item)
      }
      return out
    })
    const s = await getS($, options?.language)
    const text = s.updated(list.length) + (finished.length ? s.finished(finished.map(f => ({ title: f.title, took: fmt(f.ms) }))) : '')
    return { result: text, text }
  })

  // 新版的任務工具：TaskCreate 建立、TaskUpdate 改狀態
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const id = ran.result.task.id
    const created: ProgressTask = { id, title: e.subject, status: 'pending', startedAt: null, doneAt: null }
    await update($, tasksAtom, prev => [...prev, created])
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError === true) return ran
    const now = await $.clock.now()
    await update($, tasksAtom, prev =>
      prev.flatMap(t => {
        if (t.id !== e.taskId) return [t]
        if (e.status === 'deleted') return []
        const status = e.status ?? t.status
        return [
          {
            ...t,
            title: e.subject ?? t.title,
            status,
            startedAt: status === 'pending' ? null : (t.startedAt ?? now),
            doneAt: status === 'completed' ? (t.doneAt ?? now) : null,
          },
        ]
      }),
    )
    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const tasks = await read($, tasksAtom)
    const startedAt = style.working ? await read($, turnAtom) : null
    const tick = await read($, tickAtom)
    if (e.props.hasSurvey || (tasks.length === 0 && startedAt === null)) return next(e)

    const now = await $.clock.now()
    const s = await getS($, options?.language)
    const { Box, Text } = $.ui.resolve(e)
    // 桌面版／編輯器才有 Svg；終端機退回字元樣式
    const ui = $.ui.resolve(e) as unknown as { Svg?: ElementConstructor<SvgProps> }
    const Svg = e.surface === 'desktop' || e.surface === 'vscode' ? ui.Svg : undefined
    const th = THEMES[style.theme] ?? THEMES.default!
    const ic = ICONS[style.icons] ?? ICONS.symbols!
    const nameW = Math.max(10, Math.min(30, e.props.bodyColumns - BAR_W - 28))
    const total = tasks.length === 0 ? 0 : tasks.reduce((s, t) => s + eff(t), 0) / tasks.length
    const doneN = tasks.filter(t => t.status === 'completed').length
    const color = (st: Status) => (st === 'completed' ? th.done : st === 'in_progress' ? th.active : th.pending)

    // 進度條：每欄固定寬度，桌面版（比例字型）也會對齊
    // auto：桌面版用 candy，終端機用 solid
    const chosen = style.bar === 'auto' ? (Svg ? 'candy' : 'solid') : style.bar
    const bar = (pct: number, c: string, st: Status = 'in_progress') => {
      // 桌面版一律畫 SVG：比例字型下字元寬度不固定，字元進度條會超出欄寬、蓋到旁邊的百分比
      if (Svg) {
        const d = svgBar(SVG_KINDS.includes(chosen) ? chosen : 'flat', pct, c, st, style.track === 'dashed')
        return <Svg source={d.source} alt={`${pct}%`} width={d.w} height={d.h} />
      }
      const kind = FALLBACK[chosen] ?? chosen
      const filled = Math.round((pct / 100) * BAR_W)
      if (kind === 'solid') {
        return (
          <Box width={BAR_W}>
            {filled > 0 ? <Text backgroundColor={c}>{' '.repeat(filled)}</Text> : null}
            {filled < BAR_W ? (
              style.track === 'dashed' ? (
                <Text color={th.pending}>{'┄'.repeat(BAR_W - filled)}</Text>
              ) : (
                <Text backgroundColor={th.track} color={th.pending}>{'╱'.repeat(BAR_W - filled)}</Text>
              )
            ) : null}
          </Box>
        )
      }
      const g = GLYPHS[kind] ?? GLYPHS.blocks!
      const off = kind === 'ascii' ? g.off : style.track === 'dashed' ? '┄' : '╱'
      const offBg = kind === 'ascii' || style.track === 'dashed' ? undefined : th.track
      return (
        <Box width={BAR_W + 2}>
          <Text color={c}>{`${g.l}${g.on.repeat(filled)}`}</Text>
          <Text color={th.pending} backgroundColor={offBg}>{`${off.repeat(BAR_W - filled)}${g.r}`}</Text>
        </Box>
      )
    }

    const header = `${s.panelTitle(doneN, tasks.length)}  ${Math.round(total)}%`
    const elapsed = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
    // 不確定總量的進度，不給百分比：只畫一段來回移動的亮塊，旁邊是真實經過的秒數
    const sweep = () => {
      if (Svg) {
        const d = svgSweep(tick, th.active, th.pending)
        return <Svg source={d.source} alt={s.working} width={d.w} height={d.h} />
      }
      const w = BAR_W
      const seg = 4
      const span = w - seg
      const k = tick % (span * 2)
      const pos = k <= span ? k : span * 2 - k
      return (
        <Box width={w + 2}>
          <Text color={th.pending}>{'┄'.repeat(pos)}</Text>
          <Text color={th.active} bold>{'━'.repeat(seg)}</Text>
          <Text color={th.pending}>{'┄'.repeat(w - seg - pos)}</Text>
        </Box>
      )
    }
    const spin = ['◐', '◓', '◑', '◒'][tick % 4] ?? '◐'
    const eta = overallEta(tasks, s)

    if (tasks.length === 0 && style.layout !== 'detailed') return next(e)

    const compactRow = () => {
      const cur = tasks.find(t => t.status === 'in_progress') ?? tasks.find(t => t.status === 'pending')
      return (
        <Box paddingX={1} gap={1}>
          <Text bold>{header}</Text>
          {bar(total, total >= 100 ? th.done : th.active, total >= 100 ? 'completed' : 'in_progress')}
          {cur ? (
            <Text color={color(cur.status)}>{`${ic[cur.status]} ${clip(cur.title, 24)}`.trim()}</Text>
          ) : (
            <Text color={th.done}>{s.allDone}</Text>
          )}
          <Text dimColor>{eta}</Text>
        </Box>
      )
    }
    if (style.layout === 'compact') return compactRow()

    if (style.layout === 'header') {
      return (
        <Box paddingX={1} gap={1}>
          <Text bold>{header}</Text>
          {bar(total, total >= 100 ? th.done : th.active, total >= 100 ? 'completed' : 'in_progress')}
          <Text dimColor>{eta}</Text>
        </Box>
      )
    }

    // 固定順序（依加入順序），列的位置不會因狀態改變而跳動；太多時只顯示最近的
    let shown = tasks.slice(-MAX_ROWS)
    let hidden = tasks.length - shown.length
    let showWorking = startedAt !== null
    // 放不下時（例如執行中的工具佔掉畫面）：
    // 先拿掉「處理中」列（轉圈提示已經有狀態）；
    // 還放不下但有 3 列以上：照常畫完整清單，交給 Claude Code 捲動（「↓ n more」，滾輪或 ctrl+x tab 後用方向鍵）；
    // 只剩 2 列：標題加目前任務，其餘的數量寫在標題列；只剩 1 列：單行的 compact。
    // 任何時候都能用 /task-progress list 看完整清單
    const room = e.props.maxRows
    let outside = 0
    if (tasks.length > 0 && 1 + (hidden > 0 ? 1 : 0) + shown.length + (showWorking ? 1 : 0) > room) {
      showWorking = false
      if (1 + (hidden > 0 ? 1 : 0) + shown.length > room && room < 3) {
        if (room < 2) return compactRow()
        const k = Math.min(MAX_ROWS, room - 1)
        let anchor = tasks.findIndex(t => t.status === 'in_progress')
        if (anchor < 0) anchor = tasks.findIndex(t => t.status === 'pending')
        if (anchor < 0) anchor = tasks.length - 1
        // 目前任務前面留一列（剛完成的），其餘往後
        const start = Math.max(0, Math.min(anchor - 1, tasks.length - k))
        shown = tasks.slice(start, start + k)
        hidden = 0
        outside = tasks.length - shown.length
      }
    }
    const iconW = style.icons === 'none' ? 0 : 3
    const workingRow =
      !showWorking ? null : (
        <Box key="working" gap={1}>
          {iconW > 0 ? (
            <Box width={iconW}>
              <Text color={th.active}>{spin}</Text>
            </Box>
          ) : null}
          <Box width={nameW}>
            <Text wrap="truncate-end">{s.working}</Text>
          </Box>
          {sweep()}
          <Box width={5}>
            <Text bold>—</Text>
          </Box>
          <Text dimColor>{s.elapsed(`${elapsed}s`)}</Text>
        </Box>
      )
    if (tasks.length === 0) return <Box flexDirection="column" paddingX={1}>{workingRow}</Box>

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Box width={iconW + (iconW > 0 ? 1 : 0) + nameW}>
            <Text bold wrap="truncate-end">{s.panelTitle(doneN, tasks.length)}</Text>
          </Box>
          {bar(total, total >= 100 ? th.done : th.active, total >= 100 ? 'completed' : 'in_progress')}
          <Box width={5}>
            <Text bold>{`${Math.round(total)}%`}</Text>
          </Box>
          {outside > 0 ? <Text dimColor>{s.outside(outside)}</Text> : null}
          <Text dimColor>{eta}</Text>
        </Box>
        {hidden > 0 ? <Text dimColor>{s.hiddenEarlier(hidden)}</Text> : null}
        {shown.map((t, i) => {
          const pct = eff(t)
          const c = color(t.status)
          return (
            <Box key={`${i}-${t.title}`} gap={1}>
              {iconW > 0 ? (
                <Box width={iconW}>
                  <Text color={c}>{ic[t.status]}</Text>
                </Box>
              ) : null}
              <Box width={nameW}>
                <Text dimColor={t.status === 'completed'} wrap="truncate-end">{t.title}</Text>
              </Box>
              {bar(pct, c, t.status)}
              <Box width={5}>
                <Text bold>{t.status === 'in_progress' && t.pct === undefined ? '—' : `${pct}%`}</Text>
              </Box>
              <Text dimColor>{rowTime(t, now, s)}</Text>
            </Box>
          )
        })}
        {workingRow}
      </Box>
    )
  })
}

type Status = ProgressTask['status']

const BAR_W = 14
const MAX_ROWS = 6
// 只用真實數字：完成 100、待辦 0、進行中用 done/total 算出的 pct；沒有數量的進行中任務算 0，不假裝進度
const eff = (t: ProgressTask): number => (t.status === 'completed' ? 100 : (t.pct ?? 0))

const ICONS: Record<string, Record<Status, string>> = {
  symbols: { completed: '✓', in_progress: '●', pending: '⏸' },
  emoji: { completed: '✅', in_progress: '🔄', pending: '⏳' },
  circles: { completed: '●', in_progress: '◐', pending: '○' },
  minimal: { completed: '+', in_progress: '>', pending: '-' },
  none: { completed: '', in_progress: '', pending: '' },
}

const GLYPHS: Record<string, { on: string; off: string; l: string; r: string }> = {
  blocks: { on: '█', off: '░', l: '', r: '' },
  dots: { on: '●', off: '○', l: '', r: '' },
  line: { on: '━', off: '─', l: '', r: '' },
  segments: { on: '▰', off: '▱', l: '', r: '' },
  ascii: { on: '#', off: '-', l: '[', r: ']' },
}

const THEMES: Record<string, { done: string; active: string; pending: string; track: string }> = {
  default: { done: '#48bb78', active: '#ecc94b', pending: '#718096', track: '#2d3748' },
  ocean: { done: '#4fd1c5', active: '#4299e1', pending: '#718096', track: '#2a3a4f' },
  sunset: { done: '#f6ad55', active: '#ed64a6', pending: '#a0aec0', track: '#3b2f3f' },
  neon: { done: '#39ff14', active: '#ff2dd4', pending: '#8a8a8a', track: '#2a2a2a' },
  mono: { done: '#e2e8f0', active: '#ffffff', pending: '#718096', track: '#2d2d2d' },
}

type Style = { bar: string; icons: string; layout: string; theme: string; track: string; working: boolean; spinner: boolean }
// language 選項（auto / en / zh-TW）不在 Style 裡：它由 resolveLang 處理

function pick(v: unknown, allowed: readonly string[], fallback: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : fallback
}

function readStyle(o: Readonly<Record<string, unknown>> | undefined): Style {
  return {
    bar: pick(o?.barStyle, ['auto', 'solid', ...Object.keys(GLYPHS), ...SVG_KINDS], 'auto'),
    icons: pick(o?.iconSet, Object.keys(ICONS), 'symbols'),
    layout: pick(o?.layout, ['detailed', 'compact', 'header'], 'detailed'),
    theme: pick(o?.theme, Object.keys(THEMES), 'default'),
    track: pick(o?.trackStyle, ['filled', 'dashed'], 'filled'),
    working: pick(o?.showWorking, ['on', 'off'], 'on') === 'on',
    spinner: pick(o?.spinnerProgress, ['on', 'off'], 'on') === 'on',
  }
}

function rowTime(t: ProgressTask, now: number, s: Strings): string {
  if (t.status === 'in_progress' && t.startedAt) {
    const n = t.total !== undefined && t.done !== undefined ? `${t.done}/${t.total} · ` : ''
    return `${n}${s.elapsed(fmt(now - t.startedAt))}`
  }
  if (t.status === 'completed' && t.startedAt && t.doneAt) return s.took(fmt(t.doneAt - t.startedAt))
  if (t.unsettled) return s.unsettled
  return ''
}

// 整體預估：已完成任務的平均耗時 × 剩餘任務數
function overallEta(tasks: ProgressTask[], s: Strings): string {
  const finished = tasks.filter(t => t.status === 'completed' && t.startedAt && t.doneAt)
  const remaining = tasks.filter(t => t.status !== 'completed').length
  if (!finished.length || !remaining) return ''
  const avg = finished.reduce((sum, t) => sum + (t.doneAt! - t.startedAt!), 0) / finished.length
  return s.eta(fmt(avg * remaining))
}

// 秒級精度：42s、3m5s、1h20m
function fmt(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m${sec % 60 ? `${sec % 60}s` : ''}`
  return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ''}`
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

// ---------- 桌面版的 SVG 進度條 ----------
const SVG_KINDS = ['candy', 'stripes', 'glossy', 'neon']
// 終端機沒有 Svg，退回最接近的字元樣式
const FALLBACK: Record<string, string> = { candy: 'solid', stripes: 'segments', glossy: 'segments', neon: 'line' }

function mix(hex: string, to: string, t: number): string {
  const a = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  const b = [1, 3, 5].map(i => parseInt(to.slice(i, i + 2), 16))
  return `#${a.map((v, i) => Math.round(v + ((b[i] ?? 0) - v) * t).toString(16).padStart(2, '0')).join('')}`
}

function svgBar(kind: string, pct: number, c: string, st: Status, dashed: boolean): { source: string; w: number; h: number } {
  const hi = mix(c, '#ffffff', 0.45)
  const lo = mix(c, '#000000', 0.25)
  const W = 180
  const wrap = (h: number, body: string) => ({
    w: W,
    h,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">${body}</svg>`,
  })

  if (kind === 'candy') {
    const h = 22
    const x0 = 24
    const bw = W - x0 - 2
    const fw = (bw * pct) / 100
    const icon =
      st === 'completed'
        ? `<path d="M6 4 H16 L21 10 L11 21 L1 10 Z" fill="${c}" stroke="${lo}" stroke-width="1.2"/><path d="M1 10 H21 M6 4 L8 10 L11 21 M16 4 L14 10 L11 21" stroke="${hi}" stroke-width=".8" fill="none"/>`
        : st === 'in_progress'
          ? `<path d="M13 1 L4 12 H10 L8 21 L19 9 H13 Z" fill="${c}" stroke="${lo}" stroke-width="1.2" stroke-linejoin="round"/>`
          : `<rect x="4" y="3" width="5" height="16" rx="1.5" fill="${c}" stroke="${lo}" stroke-width="1.2"/><rect x="13" y="3" width="5" height="16" rx="1.5" fill="${c}" stroke="${lo}" stroke-width="1.2"/>`
    const fill =
      fw > 0
        ? `<rect x="${x0}" y="3" width="${fw}" height="16" rx="${Math.min(8, fw / 2)}" fill="url(#g)"/>` +
          (fw > 10 ? `<rect x="${x0 + 4}" y="5" width="${fw - 8}" height="4" rx="2" fill="#fff" opacity=".4"/>` : '')
        : ''
    return wrap(
      h,
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".55" stop-color="${c}"/><stop offset="1" stop-color="${lo}"/></linearGradient></defs>` +
        `<rect x="${x0}" y="3" width="${bw}" height="16" rx="8" ${dashed ? 'fill="none" stroke="#9aa1ab" stroke-width="1.5" stroke-dasharray="4 3"' : 'fill="#9aa0aa" stroke="#6b7280" stroke-width="1"'}/>${fill}${icon}`,
    )
  }

  if (kind === 'stripes') {
    const h = 20
    const fw = ((W - 8) * pct) / 100
    let polys = ''
    for (let x = 4; x < 4 + fw; x += 20) {
      polys += `<polygon points="${x + 7},4 ${x + 17},4 ${x + 10},${h - 4} ${x},${h - 4}" fill="${c}"/>`
    }
    return wrap(
      h,
      `<defs><clipPath id="k"><rect x="4" y="4" width="${Math.max(0, fw)}" height="${h - 8}" rx="6"/></clipPath></defs>` +
        `<rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="9" fill="${dashed ? 'none' : '#9aa0aa'}" stroke="${dashed ? '#9aa1ab' : c}" stroke-width="2"${dashed ? ' stroke-dasharray="5 3"' : ''}/>` +
        `<g clip-path="url(#k)">${polys}</g>`,
    )
  }

  if (kind === 'glossy') {
    const h = 20
    const n = 10
    const gap = 3
    const sw = (W - 8 - (n - 1) * gap) / n
    const k = Math.round((pct / 100) * n)
    let segs = ''
    for (let i = 0; i < n; i++) {
      segs += `<rect x="${4 + i * (sw + gap)}" y="4" width="${sw}" height="${h - 8}" rx="3" ${i < k || !dashed ? `fill="url(#${i < k ? 'on' : 'off'})"` : 'fill="none" stroke="#8a93a0" stroke-width="1" stroke-dasharray="2 2"'}/>`
    }
    return wrap(
      h,
      `<defs><linearGradient id="on" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${hi}"/><stop offset=".5" stop-color="${c}"/><stop offset="1" stop-color="${lo}"/></linearGradient>` +
        `<linearGradient id="off" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a93a0"/><stop offset="1" stop-color="#4b5563"/></linearGradient></defs>` +
        `<rect x="0" y="0" width="${W}" height="${h}" rx="5" fill="#1f2937"/>${segs}`,
    )
  }

  if (kind === 'flat') {
    // 字元樣式在桌面版的對應：單純的圓角條
    const h = 18
    const fw = ((W - 4) * pct) / 100
    return wrap(
      h,
      `<rect x="1" y="3" width="${W - 2}" height="${h - 6}" rx="6" ${dashed ? 'fill="none" stroke="#9aa1ab" stroke-width="1.5" stroke-dasharray="4 3"' : 'fill="#3a4049"'}/>` +
        (fw > 0 ? `<rect x="2" y="4" width="${fw}" height="${h - 8}" rx="5" fill="${c}"/>` : ''),
    )
  }

  // neon
  const h = 18
  const fw = ((W - 6) * pct) / 100
  const fill =
    fw > 0
      ? `<rect x="3" y="3" width="${fw}" height="${h - 6}" rx="6" fill="url(#n)" filter="url(#glow)"/>` +
        (fw > 8 ? `<rect x="6" y="5" width="${fw - 6}" height="2" rx="1" fill="#fff" opacity=".5"/>` : '')
      : ''
  return wrap(
    h,
    `<defs><linearGradient id="n" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${lo}"/><stop offset=".7" stop-color="${c}"/><stop offset="1" stop-color="${hi}"/></linearGradient>` +
      `<filter id="glow" x="-20%" y="-60%" width="140%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
      `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="8.5" ${dashed ? 'fill="none" stroke="#9aa1ab" stroke-dasharray="4 3"' : `fill="#3a4049" stroke="${mix(c, '#000000', 0.4)}"`}/>${fill}`,
  )
}

// 附在每個提問旁邊的提醒在 STR 裡的 guide（越短越省 token；total/done 是 set_tasks 的必填欄位，工具定義會要求，這裡不重複）

// set_tasks 的工具定義；isDeferred=true 時只有名字在每次請求裡，要用時才由 ToolSearch 載入
function toolSpec(isDeferred: boolean): ToolSpec {
  return {
      name: 'set_tasks',
      description:
        'Report multi-step progress to the panel above the prompt; prefer this over TodoWrite/update_plan. '
        + 'Merges by title: send only changed tasks; reset:true starts a new job. '
        + 'In-progress tasks require total and done (count the work first); percent = done/total. '
        + 'total counts units you will finish and report one by one within this task; work done in one tool call (writing one file, running one script) is total 1, not the number of items it handles.',
      isDeferred,
      inputSchema: {
        type: 'object',
        properties: {
          reset: { type: 'boolean' },
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                total: { type: 'number' },
                done: { type: 'number' },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
  }
}

// 處理中的不確定進度：灰色虛線軌道上一塊來回移動的亮塊（桌面版）
function svgSweep(tick: number, c: string, track: string): { source: string; w: number; h: number } {
  const W = 180
  const H = 20
  const seg = 48
  const span = W - 4 - seg
  const step = 8
  const k = (tick * step) % (span * 2)
  const x = 2 + (k <= span ? k : span * 2 - k)
  return {
    w: W,
    h: H,
    source:
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect x="1" y="6" width="${W - 2}" height="8" rx="4" fill="none" stroke="${track}" stroke-width="1.5" stroke-dasharray="3 3"/>` +
      `<rect x="${x}" y="4" width="${seg}" height="12" rx="6" fill="${c}"/>` +
      `</svg>`,
  }
}
