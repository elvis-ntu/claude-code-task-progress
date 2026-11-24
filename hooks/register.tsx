import { atom, read, update } from 'claude-code'
import type { ElementConstructor, Register, SvgProps } from 'claude-code'

import type { ProgressTask } from '../types'

const tasksAtom = atom({ plugin: 'task-progress', key: 'tasks' } as const, [] as ProgressTask[])
// 本輪（一次提問到回答結束）開始的時間；沒有在處理時為 null
const turnAtom = atom({ plugin: 'task-progress', key: 'turnStartedAt' } as const, null as number | null)
// 處理中每秒加一，讓面板重畫（計時與動畫）
const tickAtom = atom({ plugin: 'task-progress', key: 'tick' } as const, 0)

export const register: Register = (on, options) => {
  const style = readStyle(options)
  // 新的提問：上一件工作若已全部完成，就把舊任務清掉（沒做完的保留）
  on('prompt.submit', async ($, e, next) => {
    await update($, tasksAtom, prev =>
      prev.length > 0 && prev.every(t => t.status === 'completed') ? [] : prev,
    )
    return next(e)
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
    if ((e as { agentId?: string }).agentId === undefined) await update($, turnAtom, () => null)
    return next(e)
  })

  // 內建的轉圈提示（Unfurling… (56s · 5.6k tokens)）：在後面接上真實的任務進度
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!style.spinner) return next(e)
    const tasks = await read($, tasksAtom)
    if (tasks.length === 0) return next(e)
    const doneN = tasks.filter(t => t.status === 'completed').length
    const cur = tasks.find(t => t.status === 'in_progress')
    const detail = cur?.total !== undefined && cur.done !== undefined ? `，進行中 ${cur.done}/${cur.total}` : ''
    return next({ ...e, props: { ...e.props, suffix: `… 任務 ${doneN}/${tasks.length}${detail}` } })
  })

  // /task-progress demo：填入範例任務；/task-progress clear：清空
  on('session.start', async ($, e, next) => {
    $.clock.every(1000, () => {
      void read($, turnAtom).then(t => {
        if (t !== null) void update($, tickAtom, n => n + 1)
      })
    })
    await $.tool.register({
      name: 'set_tasks',
      description:
        '更新輸入框上方的任務進度面板。每次任務狀態改變時呼叫，傳入完整任務清單（title 與 status: pending | in_progress | completed）。'
        + '進行中的任務必須同時傳 total（這項工作總共有幾件）與 done（已完成幾件），進度百分比由 done/total 算出。'
        + '開始前先把總量數出來（檔案數、步驟數、項目數）；數不出來就把工作拆成可數的子步驟再回報。缺少 total 的進行中任務會被拒絕。'
        + '預設是合併更新：用 title 對應已存在的任務並更新狀態，沒提到的任務保持原樣、順序不變，新任務接在後面。開始一件全新的工作時才傳 reset: true，清掉舊的所有任務。',
      isDeferred: false,
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
                total: { type: 'number', minimum: 1 },
                done: { type: 'number', minimum: 0 },
              },
              required: ['title', 'status'],
            },
          },
        },
        required: ['tasks'],
      },
    })
    await $.command.register({
      name: 'task-progress',
      description: '任務進度面板：demo 顯示範例，clear 清空',
    })
    return next(e)
  })

  on('command.run', { command: 'task-progress' }, async ($, e) => {
    if (String(e.args ?? '').trim() === 'clear') {
      await update($, tasksAtom, () => [])
      return { text: '已清空任務進度。' }
    }
    const now = await $.clock.now()
    const min = 60000
    const demo: ProgressTask[] = [
      { title: '盤點資料夾', status: 'completed', startedAt: now - 6 * min, doneAt: now - 4 * min },
      { title: '整理檔案結構', status: 'completed', startedAt: now - 4 * min, doneAt: now - 1 * min },
      { title: '補上 README', status: 'in_progress', startedAt: now - 1 * min, doneAt: null, pct: 50, done: 1, total: 2 },
      { title: '驗證結果', status: 'pending', startedAt: null, doneAt: null },
    ]
    await update($, tasksAtom, () => demo)
    return { text: '已載入範例任務，請看輸入框上方。' }
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
      return {
        deny: `「${bad.title}」是進行中，必須同時回報 total（總共幾件，至少 1）與 done（已完成幾件，0 到 total）。請先把工作量數出來再呼叫。`,
      }
    }
    const now = await $.clock.now()
    await update($, tasksAtom, prev => {
      const out: ProgressTask[] = input.reset ? [] : [...prev]
      for (const t of list) {
        const idx = out.findIndex(p => p.title === t.title)
        const old = idx >= 0 ? out[idx] : undefined
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
    const text = `已更新 ${list.length} 個任務`
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
    const bar = (pct: number, c: string, st: Status = 'in_progress') => {
      if (Svg && SVG_KINDS.includes(style.bar)) {
        const d = svgBar(style.bar, pct, c, st, style.track === 'dashed')
        return <Svg source={d.source} alt={`${pct}%`} width={d.w} height={d.h} />
      }
      const kind = FALLBACK[style.bar] ?? style.bar
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

    const header = `任務進度 ${doneN}/${tasks.length}  ${Math.round(total)}%`
    const elapsed = startedAt === null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))
    // 不確定總量的進度，不給百分比：只畫一段來回移動的亮塊，旁邊是真實經過的秒數
    const sweep = () => {
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
    const eta = overallEta(tasks)

    if (tasks.length === 0 && style.layout !== 'detailed') return next(e)

    if (style.layout === 'compact') {
      const cur = tasks.find(t => t.status === 'in_progress') ?? tasks.find(t => t.status === 'pending')
      return (
        <Box paddingX={1} gap={1}>
          <Text bold>{header}</Text>
          {bar(total, total >= 100 ? th.done : th.active)}
          {cur ? (
            <Text color={color(cur.status)}>{`${ic[cur.status]} ${clip(cur.title, 24)}`.trim()}</Text>
          ) : (
            <Text color={th.done}>全部完成</Text>
          )}
          <Text dimColor>{eta}</Text>
        </Box>
      )
    }

    if (style.layout === 'header') {
      return (
        <Box paddingX={1} gap={1}>
          <Text bold>{header}</Text>
          {bar(total, total >= 100 ? th.done : th.active)}
          <Text dimColor>{eta}</Text>
        </Box>
      )
    }

    // 固定順序（依加入順序），列的位置不會因狀態改變而跳動；太多時只顯示最近的
    const shown = tasks.slice(-MAX_ROWS)
    const hidden = tasks.length - shown.length
    const iconW = style.icons === 'none' ? 0 : 3
    const workingRow =
      startedAt === null ? null : (
        <Box key="working" gap={1}>
          {iconW > 0 ? (
            <Box width={iconW}>
              <Text color={th.active}>{spin}</Text>
            </Box>
          ) : null}
          <Box width={nameW}>
            <Text wrap="truncate-end">處理中</Text>
          </Box>
          {sweep()}
          <Box width={5}>
            <Text bold>—</Text>
          </Box>
          <Text dimColor>{`已 ${elapsed}s`}</Text>
        </Box>
      )
    if (tasks.length === 0) return <Box flexDirection="column" paddingX={1}>{workingRow}</Box>

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box gap={1}>
          <Box width={iconW + (iconW > 0 ? 1 : 0) + nameW}>
            <Text bold wrap="truncate-end">{`任務進度 ${doneN}/${tasks.length}`}</Text>
          </Box>
          {bar(total, total >= 100 ? th.done : th.active)}
          <Box width={5}>
            <Text bold>{`${Math.round(total)}%`}</Text>
          </Box>
          <Text dimColor>{eta}</Text>
        </Box>
        {hidden > 0 ? <Text dimColor>{`… 前面還有 ${hidden} 個較早的任務`}</Text> : null}
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
              <Text dimColor>{rowTime(t, now)}</Text>
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

function pick(v: unknown, allowed: readonly string[], fallback: string): string {
  return typeof v === 'string' && allowed.includes(v) ? v : fallback
}

function readStyle(o: Readonly<Record<string, unknown>> | undefined): Style {
  return {
    bar: pick(o?.barStyle, ['solid', ...Object.keys(GLYPHS), ...SVG_KINDS], 'solid'),
    icons: pick(o?.iconSet, Object.keys(ICONS), 'symbols'),
    layout: pick(o?.layout, ['detailed', 'compact', 'header'], 'detailed'),
    theme: pick(o?.theme, Object.keys(THEMES), 'default'),
    track: pick(o?.trackStyle, ['filled', 'dashed'], 'filled'),
    working: pick(o?.showWorking, ['on', 'off'], 'on') === 'on',
    spinner: pick(o?.spinnerProgress, ['on', 'off'], 'on') === 'on',
  }
}

function rowTime(t: ProgressTask, now: number): string {
  if (t.status === 'in_progress' && t.startedAt) {
    const n = t.total !== undefined && t.done !== undefined ? `${t.done}/${t.total} · ` : ''
    return `${n}已 ${fmt(now - t.startedAt)}`
  }
  if (t.status === 'completed' && t.startedAt && t.doneAt) return `用 ${fmt(t.doneAt - t.startedAt)}`
  return ''
}

// 整體預估：已完成任務的平均耗時 × 剩餘任務數
function overallEta(tasks: ProgressTask[]): string {
  const finished = tasks.filter(t => t.status === 'completed' && t.startedAt && t.doneAt)
  const remaining = tasks.filter(t => t.status !== 'completed').length
  if (!finished.length || !remaining) return ''
  const avg = finished.reduce((s, t) => s + (t.doneAt! - t.startedAt!), 0) / finished.length
  return `預估剩餘 ~${fmt(avg * remaining)}`
}

function fmt(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
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
