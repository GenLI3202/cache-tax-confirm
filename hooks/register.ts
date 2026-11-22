import type { EngineInterface, Register, RenderSurface } from 'claude-code'
import { statusIcons } from './status-icons'
import { ADVISOR_MODEL, ADVISOR_TIMEOUT_MS, adviceFromRules, adviceText, advisorPrompt, buildDigest, isZh, parseAdvisor, verdictLabel, withNote } from './advice'
import type { Advice, Digest, Msg } from './advice'

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 50 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const MAX_RETRIES = 3
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
/** Where the idle status row goes: the status line under the prompt (line), the band above it (band), or nowhere (off). */
const KEY_DISPLAY = 'display'
const ME = 'cache-tax-confirm'

// Prompts no person sent, so nobody could send them again after a refusal. Every
// other origin, including sdk, unclassified and the owner's own Slack or channel
// messages, may carry a person's words and keeps the guard.
const UNATTENDED = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity'])

const LONG_PROMPT_TOKENS = 100000

// $ per million tokens, [cache read, 1h cache write, output], list prices October 2026.
// More specific families first: a model id takes the first row it matches.
const PRICES: Array<[string | RegExp, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['mythos-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['mythos-5', 1, 20, 50],
  ['opus-5-5', 0.2, 8, 20],
  ['opus-5', 0.5, 10, 25],
  // Opus 4 and 4.1 in every spelling (claude-opus-4-1-20250805, claude-opus-4@20250514, the -0 and -1 aliases), never Opus 4.5 and later.
  [/opus-4(?:-[01])?(?:$|[^-\d]|-20\d{6})/, 1.5, 30, 75],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5-5', 0.1, 4, 10],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku-5-5', 0.01, 0.2, 0.5],
  ['3-5-haiku', 0.08, 1.6, 4],
  ['haiku-3-5', 0.08, 1.6, 4],
  ['haiku', 0.1, 2, 5],
]

// A request whose prompt, cache reads and writes included, is over 100k tokens pays these instead.
const LONG_PRICES: Array<[string, number, number, number]> = [
  ['haiku-5-5', 0.05, 1, 2.5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  resumedAt: number
  transcript: number
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  waitForTurn: boolean
  retries: number
  retryReason: string
  gen: number
  tick: number
  offs: number
  turnOffs: number | null
  inFlight: boolean
  stepWrites: StepWrites | null
  steps: number
  endingSid: string
}

/** What this turn's main requests wrote before any compaction it saw, priced per request where the steps reported usage. */
type StepWrites = { tokens: number; usd: number; priced: boolean }

function priceOf(model: string | null, promptTokens: number): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  if (promptTokens > LONG_PROMPT_TOKENS) {
    for (const [family, read, write, output] of LONG_PRICES) if (m.includes(family)) return [read, write, output]
  }
  for (const [family, read, write, output] of PRICES) {
    if (typeof family === 'string' ? m.includes(family) : family.test(m)) return [read, write, output]
  }
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel, s.ctx)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

type Held = { text: string; note: string; ago: string; tokens: number; rate: string; cold: string; warm: string | null; frac: number; hold: string; zh: boolean; advice: Advice | null }

// The cold send the guard dropped, kept so the card above the prompt can pay it.
let held: Held | null = null
// Read by the card as well as the hooks, so they live out here, not inside register.
let light = false
let noColor = false
type Display = 'line' | 'band' | 'off'
let display: Display = 'band'
/** The last text pushed to the status line, so an unchanged line is not pushed again. */
let lastLine: string | undefined
let lineTick: { cancel(): void } | null = null
// Whether the theme and NO_COLOR have been read for the band; a band found after session.start reads them then.
let looked = false
// The title a resumed session arrives with; the handoff drafts name the session by id, and by this when known.
let title: string | null = null
// Counts the person's prompts: a hold whose advice is still being worked out is stale once another prompt arrives.
let promptSeq = 0
const CHECKPOINT = '.claude/checkpoint.md'
const CHECKPOINT_FRESH_MS = 7 * 24 * 60 * 60 * 1000

function buildHeld(s: State, text: string, now: number): Held {
  const price = priceOf(s.lastModel, s.ctx)
  const cold = coldUsd(s)
  const warm = warmUsd(s)
  return {
    text,
    zh: isZh(text),
    advice: null,
    note: `${guardText(s, now)} keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}.`,
    ago: fmtDuration(Math.max(0, now - s.lastRequestAt - TTL_MS)),
    tokens: s.ctx,
    rate: price ? `$${price[1]}/MTok` : 'the cache-write rate',
    cold: fmtUsd(cold),
    warm: warm == null ? null : fmtUsd(warm),
    frac: cold && warm != null ? warm / cold : 0.05,
    hold: fmtDuration(holdMs(s)),
  }
}

async function showStatus($: EngineInterface, s: State) {
  $.ui.log(card(s, await $.clock.now()))
}

async function payHeld($: EngineInterface, s: State, note = false) {
  const h = held
  if (!h) return
  held = null
  s.ackedAt = 0
  s.coldWritePending = true
  $.ui.invalidate('ui.render')
  await $.prompt.submit({ text: note ? withNote(h.text, h.zh) : h.text, asUser: true })
}

async function copyDraft($: EngineInterface, text: string, zh: boolean, surface: RenderSurface) {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? (zh ? '已复制。新开一个会话，粘贴后发送。' : 'Copied. Paste it into a new session.') : (zh ? `没能复制：${r.reason}` : `Could not copy: ${r.reason}`))
}

/** A regular file there now: a folder, a device or a missing path is no file to hand a new session. */
async function present($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

/** Where a path a reply named is now: absolute as given, `~/` under HOME, else under the session's folder or a folder above a file the session edited. */
async function resolvePath($: EngineInterface, path: string, cwd: string, near: readonly string[]): Promise<string | null> {
  if (path.startsWith('/')) return (await present($, path)) ? path : null
  if (path.startsWith('~/')) {
    const home = await $.env.get('HOME').catch(() => undefined)
    const full = home ? `${home}${path.slice(1)}` : null
    return full && (await present($, full)) ? full : null
  }
  const bases: string[] = cwd ? [cwd] : []
  for (const file of near.slice(0, 4)) {
    let dir = file.slice(0, file.lastIndexOf('/'))
    for (let up = 0; up < 4 && dir.length > 1; up++) {
      if (!bases.includes(dir)) bases.push(dir)
      dir = dir.slice(0, dir.lastIndexOf('/'))
    }
  }
  for (const base of bases.slice(0, 12)) {
    const full = `${base}/${path}`
    if (await present($, full)) return full
  }
  return null
}

/** One cheap completion over the digest, cut off at the timeout so a hold never waits long on it. */
async function askAdvisor($: EngineInterface, d: Digest): Promise<Advice | null> {
  const { system, prompt } = advisorPrompt(d)
  const stop = new AbortController()
  // The race settles at the timeout whether or not the call honours the abort.
  let timer: { cancel: () => void } | null = null
  const late = new Promise<null>(resolve => {
    timer = $.clock.after(ADVISOR_TIMEOUT_MS, () => {
      stop.abort()
      resolve(null)
    })
  })
  const call = $.model.complete({ model: ADVISOR_MODEL, system, prompt, maxTokens: 900, effort: 'low' }, { signal: stop.signal })
    .then(r => (r.isAnswered ? parseAdvisor(r.text, d) : null), () => null)
  try {
    return await Promise.race([call, late])
  } finally {
    (timer as { cancel: () => void } | null)?.cancel()
  }
}

/** Whether to pay the cold write or carry the work to a new session, with drafts for the latter. Never throws. */
async function advise($: EngineInterface, s: State, text: string, now: number): Promise<Advice | null> {
  try {
    const raw = await $.session.messages()
    const msgs = Array.isArray(raw) ? (raw as unknown as Msg[]) : []
    const cwd = await $.session.cwd().catch(() => '')
    const id = s.sid || await $.session.id()
    let d = await buildDigest(msgs, { id, title, cwd, ctx: s.ctx, idle: fmtDuration(Math.max(0, now - s.lastRequestAt - TTL_MS)), held: text }, (p, near) => resolvePath($, p, cwd, near))
    // The checkpoint mod's note, when it is recent: the strongest sign the work can be picked up from disk.
    if (!d.checkpoint && cwd) {
      const note = `${cwd}/${CHECKPOINT}`
      try {
        const st = await $.fs.stat(note)
        if (st.kind === 'file' && now - st.mtimeMs < CHECKPOINT_FRESH_MS) d = { ...d, checkpoint: note, files: [note, ...d.files.filter(f => f !== note)].slice(0, 6) }
      } catch {
        // No note.
      }
    }
    return (await askAdvisor($, d)) ?? adviceFromRules(d)
  } catch {
    return null
  }
}

/** The desktop app hosts the engine through the SDK, so session.start reports no surface; the band is found once one draws. */
async function readLook($: EngineInterface) {
  looked = true
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  light = typeof theme === 'string' && theme.startsWith('light')
  noColor = Boolean(await $.env.get('NO_COLOR'))
}

async function findBand($: EngineInterface, s: State): Promise<boolean> {
  if (s.hasBand) return true
  try {
    const surfaces = await $.session.surfaces()
    if (surfaces.includes('terminal') || surfaces.includes('desktop')) {
      s.hasBand = true
      pushLine($, s, await $.clock.now())
      await readLook($)
    }
  } catch {
    // No surfaces to ask about: keep the text path.
  }
  return s.hasBand
}

function dismissHeld($: EngineInterface) {
  held = null
  $.ui.invalidate('ui.render')
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.resumedAt = 0
  s.transcript = 0
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  s.waitForTurn = false
  s.stepWrites = null
  s.steps = 0
  outdate(s)
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') {
    s.lastRequestAt = now - e.seconds_since_last_response * 1000
    s.resumedAt = 0
  }
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. /clear and paste a summary if you only need the conclusions.`
}

/** A transcript resumed without the time of its last response: that response came after its first launch, so an hour after that launch the cache may be cold. */
function mayBeCold(s: State, now: number): boolean {
  return s.resumedAt > 0 && !s.lastRequestAt && now - s.resumedAt >= TTL_MS
}

/** The line for a resumed session whose last response time never arrived: the cache may be cold, and this is what that would cost. */
function unknownText(s: State): string {
  const price = priceOf(s.lastModel, s.ctx)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  return `resumed with up to ${s.ctx.toLocaleString('en-US')} tokens of context and no time of its last response, so the cache may be cold. ` +
    `If it is, this message re-writes them at ${rate} = ${fmtUsd(coldUsd(s))}.`
}

/** The conversation was summarized: the next request is the first over the new prefix, and a ping out for the old one is dropped. */
function markCompacted(s: State) {
  s.compacted = true
  s.transcript = 0
  s.ackedAt = 0
  outdate(s)
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : s.waitForTurn ? ' · nothing to fork yet, first ping after the next turn'
    : s.retries ? ` · API busy, ping retry ${s.retries} of ${MAX_RETRIES}`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function stateWord(s: State, now: number): 'stopped' | 'unknown' | 'cold' | 'warm' {
  return s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
}

/** The short form for the status line under the prompt: state, time left, next ping. The host labels the line with the mod's name, so the text does not repeat it. */
function lineText(s: State, now: number): string | undefined {
  if (s.stopped) return 'keepwarm stopped'
  if (!s.deadline || now >= s.deadline) return undefined
  const state = stateWord(s, now)
  const next = !s.lastRequestAt || s.compacted || s.waitForTurn ? 'ping after next turn'
    : isCold(s, now) ? 'ping after next turn'
    : s.retries ? `retry ${s.retries}/${MAX_RETRIES}`
    : `ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `${state === 'unknown' ? 'state unknown' : state} · ${fmtDuration(s.deadline - now)} left · ${next}`
}

/** The status as one caption-size line for the band: icon, name, state in its colour, time left, next ping. */
function bandLine($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], s: State, now: number) {
  const text = lineText(s, now)
  if (!text) return null
  const state = stateWord(s, now)
  const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
  const { Box, Text } = $.ui.resolve(e)
  const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
  const icon = noColor ? Text({ bold: true, children: ['[>]'] })
    : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
    : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 10, height: 10, alt: 'Cache Tax' })
    : Text({ color, bold: true, children: ['[>]'] })
  const cut = text.indexOf(' · ')
  return Box({ key: 'cache-tax-line', flexDirection: 'row', alignItems: 'center', children: [
    Box({ flexShrink: 0, children: [icon] }),
    Text({ size: 'caption', dimColor: true, children: [
      ' cache-tax · ',
      Text({ color, children: [cut < 0 ? text : text.slice(0, cut)] }),
      cut < 0 ? '' : text.slice(cut),
    ] }),
  ] })
}

// The float: drawn as a picture so its type can be smaller than the surface's smallest text size. Its two lines
// match crab-pal's beach (34 high, the sand at 18 to 20): the first stands above the sand beside the crabs,
// the second under it, on the baseline of the names.
const FLOAT_W = 120
const FLOAT_H = 34
const FLOAT_TOP = 14
const FLOAT_LOW = 32

/** The status in two left-aligned lines of small type: "cache-tax warm", then "5h51m · ping 47m". */
function floatSvg(s: State, now: number): { svg: string; alt: string } | null {
  const text = lineText(s, now)
  if (!text) return null
  const state = stateWord(s, now)
  const grey = light ? '#8a8780' : '#8b8983'
  const tone = noColor ? grey : state === 'warm' ? (light ? '#2f8f5b' : '#5fb985') : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : grey
  const esc = (t: string) => t.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? '')
  const cut = text.indexOf(' · ')
  const head = cut < 0 ? text : text.slice(0, cut)
  const tail = cut < 0 ? '' : text.slice(cut + 3).replace(' left · ', ' · ').replace('ping in ', 'ping ')
  const font = `style="font:10px -apple-system,'PingFang SC','Helvetica Neue',sans-serif"`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${FLOAT_W}" height="${FLOAT_H}" viewBox="0 0 ${FLOAT_W} ${FLOAT_H}">`
    + `<text x="2" y="${FLOAT_TOP}" fill="${grey}" ${font}>cache-tax <tspan fill="${tone}">${esc(head)}</tspan></text>`
    + (tail ? `<text x="2" y="${FLOAT_LOW}" fill="${grey}" ${font}>${esc(tail)}</text>` : '')
    + '</svg>'
  return { svg, alt: `cache-tax · ${text}` }
}

/** The status line: the long text where no band draws, the short one in line mode, nothing otherwise. */
function pushLine($: EngineInterface, s: State, now: number) {
  const text = !s.hasBand ? statusText(s, now) : display === 'line' ? lineText(s, now) : undefined
  if (text === lastLine) return
  lastLine = text
  $.ui.status(text)
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  pushLine($, s, now)
}

/** Cancels the timer. Every new timer is set right after this, so the tick also says the schedule changed. */
function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
  s.tick++
}

/** Outdates any ping in flight: /clear, a resume, compaction or stop replaced the state it was sent for. Re-arming or extending the window does not, so a ping out at that moment still counts; a main request outdates it through the request clock. */
function outdate(s: State) {
  s.gen++
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  // Set before any await, so a window being opened at the same moment sees the off and does not write itself back.
  if (forgetAlways) {
    s.always = false
    s.offs++
  }
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  s.retries = 0
  outdate(s)
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) await $.store.delete(KEY_ALWAYS)
  updateStatus($, s, await $.clock.now())
}

/** The conversation ended under /clear or an in-process resume. The next one's id cannot be read until the engine has switched, so the state is left unseated. */
async function endConversation($: EngineInterface, s: State, reason: 'clear' | 'resume') {
  // Claimed before any await: a second end or a classic start for the same conversation finds it already gone, and an
  // end cut short by its budget leaves no timer and no old id behind, only the keys below.
  const keys = [deadlineKey(s), everyKey(s)]
  const ending = s.sid
  resetForClear(s)
  s.sid = ''
  s.endingSid = ending
  // /clear ends the conversation the window was armed for. A resume carries the window on to the next one, under its
  // id: the old id's keys go here, or a /keepwarm off there could never find them and the old session would re-arm them.
  if (reason === 'clear') {
    s.deadline = 0
    s.every = PING_AFTER_MS
    s.stopped = null
    s.retries = 0
  }
  for (const key of keys) await $.store.delete(key)
  if (reason === 'clear') updateStatus($, s, await $.clock.now())
}

/** Reads the session the process runs now: its id, its model and the engine's figures for its context. Returns the time read with them. */
async function seat($: EngineInterface, s: State, id?: string): Promise<number> {
  s.sid = id ?? await $.session.id()
  s.endingSid = ''
  s.lastModel = await $.session.model()
  const usage = await $.session.usage()
  const now = await $.clock.now()
  if (usage.context.tokens) s.ctx = usage.context.tokens
  // A resumed transcript's last response came somewhere between its first launch and now; only the resume fields say where.
  s.resumedAt = !s.lastRequestAt && usage.context.tokens ? usage.startedAt : 0
  return now
}

/** Seats the state in the conversation that followed a /clear or a resume, once, and arms what always or a window opened meanwhile asks for. */
async function reseat($: EngineInterface, s: State) {
  if (s.sid) return
  const id = await $.session.id()
  // The host still answers with the conversation being ended: the next one is not there to seat yet, so nothing is
  // seated under the old id, and a window opened meanwhile waits in memory for the id it belongs to.
  if (id === s.endingSid) return
  const now = await seat($, s, id)
  if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
  // A window carried over, or armed while the conversation was ending, is written under this id.
  else if (s.deadline) await startWindow($, s, s.deadline - now, s.every)
  else updateStatus($, s, now)
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  s.retries = 0
  if (!s.deadline) return
  const now = await $.clock.now()
  // A timer set while the clock was read, such as a retry, is replaced here, never left running beside this one;
  // from this line to the assignment below nothing awaits.
  disarm(s)
  s.retries = 0
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    // Waiting for a turn sends nothing, but wakes when the cache goes cold so the row says so.
    if (s.waitForTurn) s.pending = $.clock.after(Math.min(s.deadline - now, untilCold), () => { void arm($, s) })
    else {
      const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
      s.pending = $.clock.after(delay, () => { void ping($, s) })
    }
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const tick = s.tick
  const now = await $.clock.now()
  // A timer set or cancelled while the clock was read (an extension, a retry, a turn) owns the window now;
  // if that left no timer, a window still open is armed again rather than left without one.
  if (s.tick !== tick) return s.pending || s.inFlight ? undefined : arm($, s)
  // One fork at a time: the one already out re-arms when it settles. Checked after the await, and set
  // below with no await in between, so two timers can never both send.
  if (s.inFlight) return
  if (now >= s.deadline) return arm($, s)
  if (isCold(s, now)) return arm($, s)
  if (s.compacted || s.waitForTurn || !s.lastRequestAt) return arm($, s)
  // A request since this timer was set moved the clock; schedule from it.
  if (now - s.lastRequestAt < s.every - 1000) return arm($, s)
  // A host that slept past a retry's slot must not send it inside the last minute.
  if (s.retries && now >= s.lastRequestAt + TTL_MS - MIN_PING_MS) return stop($, s, s.retryReason + afterRetries(s.retries))
  const gen = s.gen
  const sentAt = s.lastRequestAt
  s.inFlight = true
  const sent = await $.model.fork({ prompt: PING_PROMPT }).then(reply => ({ reply }), (err: unknown) => ({ err }))
  const at = await $.clock.now()
  s.inFlight = false
  // Checked after the last await. A stop, /clear, resume or compaction, or a main request that moved the
  // cache clock, replaced what this fork was sent for: its reply is dropped and the window armed afresh.
  if (gen !== s.gen || s.lastRequestAt !== sentAt) return s.pending ? undefined : arm($, s)
  if ('err' in sent) return stop($, s, `the ping failed, ${sent.err instanceof Error ? sent.err.message : String(sent.err)}`)
  const reply = sent.reply
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    // A restarted process has no conversation to fork until its first turn; the window waits for one instead of ending.
    if (reply.reason === 'nothing-to-fork') {
      s.waitForTurn = true
      return arm($, s)
    }
    const reason = reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    // A busy or failing API is usually brief; retry while a ping can still land a minute before the cache goes cold.
    if (reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
      const wait = MIN_PING_MS * 2 ** s.retries
      if (s.retries < MAX_RETRIES && at + wait < Math.min(s.deadline, s.lastRequestAt + TTL_MS - MIN_PING_MS)) {
        s.retries++
        s.retryReason = reason
        // Replaces any timer set while the fork was out, such as a window extension's, so only the retry fires.
        disarm(s)
        s.pending = $.clock.after(wait, () => { void ping($, s) })
        updateStatus($, s, at)
        return
      }
    }
    return stop($, s, reason + afterRetries(s.retries))
  }
  const u = reply.usage
  const price = priceOf(s.lastModel, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

function afterRetries(n: number): string {
  return n ? ` after ${n} ${n === 1 ? 'retry' : 'retries'}` : ''
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
/** How long keepwarm holds the cache after a paid cold write: the rolling window when always is on. */
function holdMs(s: State): number {
  return s.always ? DEFAULT_WINDOW_MS : AUTO_WARM_MS
}

function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

// A /keepwarm off after `offs` was read wins: the window it cancelled is not written back. A caller that awaited
// before deciding to open a window passes the count it read first.
async function startWindow($: EngineInterface, s: State, windowMs: number, every: number, offs = s.offs) {
  if (s.offs !== offs) return
  const now = await $.clock.now()
  if (s.offs !== offs) return
  const deadline = now + windowMs
  s.every = every
  s.deadline = deadline
  s.stopped = null
  // Unseated, between a conversation's end and the host reporting the next, the window has no id to be written under; the seat writes it.
  if (!s.sid) return arm($, s)
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  await $.store.set(deadlineKey(s), deadline)
  if (s.offs !== offs) {
    // Remove only what this call wrote; a window armed after the off is left alone.
    if ((await $.store.get(deadlineKey(s))) === deadline) {
      await $.store.delete(deadlineKey(s))
      if (!s.deadline) await $.store.delete(everyKey(s))
    }
    return
  }
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (s.resumedAt) lines.push(mayBeCold(s, now) ? 'state       unknown, resumed without the time of its last response' : `state       resumed without the time of its last response, warm for up to ${fmtDuration(s.resumedAt + TTL_MS - now)} more`)
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next turn, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-tax guard warn to only show the price)' : 'warn only (/cache-tax guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    resumedAt: 0, transcript: 0, guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null,
    waitForTurn: false, retries: 0, retryReason: '', gen: 0, tick: 0, offs: 0, turnOffs: null, inFlight: false, stepWrites: null, steps: 0, endingSid: '',
  }
}

export const register: Register = on => {
  const s = freshState()

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    // A surface that draws this row has a band, whatever session.start reported.
    if (!s.hasBand && (e.surface === 'terminal' || e.surface === 'desktop')) {
      s.hasBand = true
      pushLine($, s, await $.clock.now())
    }
    if (s.hasBand && !looked) await readLook($).catch(() => undefined)
    if (held && s.hasBand && !e.props.hasSurvey) {
      const h = held
      const zh = h.zh
      const advice = h.advice
      const { Box, Button, Text } = $.ui.resolve(e)
      const preview = h.text.length > 80 ? h.text.slice(0, 80) + '…' : h.text
      const orange = light ? '#c15f3c' : '#d97757'
      const green = light ? '#2f8f5b' : '#5fb985'
      const handoff = advice?.verdict === 'handoff'
      const tint = (c: string) => (noColor ? undefined : c)
      // One action row. The recommended path leads and is the only primary button; the rest are short and
      // dim so the row reads at a glance. The drafts are long: each is a Copy button, the text never printed.
      const drafts = advice?.drafts ?? []
      const copyLabels = zh ? ['复制交接提示', '复制独立版'] : ['Copy handoff prompt', 'Copy plain prompt']
      const copyButtons = drafts.map((dr, i) => Button({
        key: `copy-${i}`,
        label: copyLabels[i] ?? `${zh ? '复制' : 'Copy'} ${i + 1}`,
        variant: handoff && i === 0 ? 'primary' : 'secondary',
        dimColor: !(handoff && i === 0) || undefined,
        onPress: () => copyDraft($, dr.text, zh, e.surface),
      }))
      const payButtons = [
        Button({ key: 'pay', label: zh ? '付费发送' : 'Pay and send', variant: handoff ? 'secondary' : 'primary', dimColor: handoff || undefined, onPress: () => payHeld($, s) }),
        Button({ key: 'pay-note', label: zh ? '付费 + 交接笔记' : 'Pay + note', dimColor: true, onPress: () => payHeld($, s, true) }),
      ]
      const actions = Box({ key: 'cache-tax-actions', gap: 'sm', alignItems: 'center', children: [
        ...(handoff ? [...copyButtons, ...payButtons] : [...payButtons, ...copyButtons]),
        Box({ flexGrow: 1, children: [] }),
        Button({ key: 'status', label: zh ? '缓存状态' : 'Status', dimColor: true, onPress: () => showStatus($, s) }),
      ] })
      const adviceRow = advice ? [Text({ size: 'caption', wrap: 'truncate-end', children: [
        Text({ weight: 'semibold', color: tint(advice.verdict === 'pay' ? orange : green), children: [`${zh ? '建议：' : 'Advice: '}${verdictLabel(advice, zh)}`] }),
        Text({ dimColor: true, children: [` — ${advice.reason}`] }),
      ] })] : []
      if (e.surface !== 'desktop') {
        return Box({ flexDirection: 'column', children: [
          rest,
          Text({ bold: true, children: ['cache-tax · your message is on hold'] }),
          Text({ children: [h.note] }),
          Text({ dimColor: true, children: [`On hold: "${preview}"`] }),
          ...adviceRow,
          actions,
          Button({ key: 'dismiss', label: 'Dismiss', dimColor: true, onPress: () => dismissHeld($) }),
        ] })
      }
      const asset = statusIcons[light ? 'light' : 'dark'].cold
      const { Svg } = $.ui.resolve(e)
      return Box({ flexDirection: 'column', children: [
        rest,
        Box({ flexDirection: 'column', borderStyle: 'round', borderColor: orange, padding: 'sm', gap: 'xs', children: [
          // Header: what this is, the held message, how long the cache has been cold, and a close control.
          Box({ gap: 'sm', alignItems: 'center', children: [
            Svg({ source: asset.svg, width: 14, height: 14, alt: 'Cache Tax' }),
            Box({ flexShrink: 0, children: [Text({ size: 'footnote', weight: 'semibold', children: [zh ? '消息已暂缓' : 'Message on hold'] })] }),
            Box({ flexGrow: 1, flexShrink: 1, children: [Text({ size: 'footnote', dimColor: true, wrap: 'truncate-end', children: [`“${preview}”`] })] }),
            Box({ flexShrink: 0, children: [Text({ size: 'caption', dimColor: true, children: [zh ? `缓存已冷 ${h.ago}` : `cold ${h.ago}`] })] }),
            Button({ key: 'dismiss', label: zh ? '取消' : 'Dismiss', role: 'dismiss', dimColor: true, onPress: () => dismissHeld($) }),
          ] }),
          // Cost: the two numbers that decide it, then the detail behind them in dim type.
          Text({ size: 'footnote', wrap: 'truncate-end', children: [
            Text({ weight: 'semibold', color: tint(orange), children: [h.cold] }),
            Text({ dimColor: true, children: [zh ? ' 现在发送' : ' to send now'] }),
            ...(h.warm == null ? [] : [
              Text({ dimColor: true, children: ['  vs  '] }),
              Text({ weight: 'semibold', color: tint(green), children: [h.warm] }),
              Text({ dimColor: true, children: [zh ? ' 缓存热时' : ' warm'] }),
            ]),
            Text({ dimColor: true, children: [`   ·   ${fmtTok(h.tokens)} tok @ ${h.rate}  ·  ${zh ? '之后保温' : 'stays warm'} ${h.hold}`] }),
          ] }),
          ...adviceRow,
          actions,
        ] }),
      ] })
    }
    if (!s.hasBand || e.props.hasSurvey || display !== 'band') return rest
    const line = bandLine($, e, s, await $.clock.now())
    if (!line) return rest
    const { Box } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [rest, line] })
  })

  // With another mod's row in the band (crab-pal's beach), the status takes no row of its own: its row is
  // left out and the status floats in two lines of small type at the left end of the band, adding no height.
  on('ui.render', { component: 'AbovePromptList' }, async ($, e, next) => {
    const rows = e.props.rows
    const others = rows.filter(r => r.plugin !== ME)
    if (e.surface !== 'desktop' || held || e.props.hasSurvey || display !== 'band' || others.length === 0 || others.length === rows.length) return next(e)
    const line = floatSvg(s, await $.clock.now())
    if (!line) return next(e)
    const stacked = await next({ ...e, props: { ...e.props, rows: others } })
    const { Box, Svg } = $.ui.resolve(e)
    return Box({ flexDirection: 'column', children: [
      stacked,
      // At the left end of the rows' last 34 pixels, which is crab-pal's beach when its row is the last: left of
      // this session's crab. The band clips anything drawn outside its rows, so the float stays within them.
      Box({ position: 'absolute', bottom: 0, left: 0, children: [
        Svg({ source: line.svg, width: FLOAT_W, height: FLOAT_H, alt: line.alt }),
      ] }),
    ] })
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = e.surface === 'terminal' || e.surface === 'desktop'
    if (s.hasBand) await readLook($)
    const savedDisplay = await $.store.get(KEY_DISPLAY)
    display = savedDisplay === 'line' || savedDisplay === 'off' ? savedDisplay : 'band'
    lastLine = undefined
    // The status line is pushed, not drawn on demand, so a minute's tick keeps its countdown and warm/cold word current; the band's line is drawn again on the same tick.
    lineTick?.cancel()
    lineTick = $.clock.every(60_000, () => { void $.clock.now().then(t => { pushLine($, s, t); if (s.hasBand && display === 'band') $.ui.invalidate('ui.render') }).catch(() => undefined) })
    const now = await seat($, s)
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS && savedEvery < TTL_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    // The classic start arms a restored window too, but a managed plugin above this tier may continue beneath it; arming twice leaves one timer.
    else if (s.deadline) await arm($, s)
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-tax)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-tax',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-tax, the Mod)',
      argumentHint: '[status | preview | display line|band|off | guard warn | guard refuse]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-tax guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // On Team and Enterprise accounts a managed plugin seated above this tier handles classic.* and continues beneath it, so
  // nothing here is relied on alone: session.end carries the /clear, turn.step the compaction, and the engine's own figures
  // the resumed context. What arrives here refines that, once: a clear already ended is only seated, a seat is never redone.
  on('session.end', async ($, e, next) => {
    // Only the conversation this state sits in: after the classic start of the next one, the old id is history.
    if ((e.reason === 'clear' || e.reason === 'resume') && e.sessionId === s.sid) await endConversation($, s, e.reason)
    return next(e)
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    // A resumed or cleared conversation is not the one a ping in flight was sent for.
    outdate(s)
    // The conversation moved under this state without session.end reaching it: the payload names another id, or a
    // clear names none. One that already seated the new id (a command ran first) is left as it is.
    if (s.sid && (e.session_id === undefined ? e.source === 'clear' : e.session_id !== s.sid)) await endConversation($, s, e.source === 'clear' ? 'clear' : 'resume')
    // No session.start fires after /clear, so this is where always arms the new conversation.
    await reseat($, s)
    // A compaction keeps the conversation and its title; any other start names its own, or none.
    if (typeof e.session_title === 'string' && e.session_title.trim() && e.source !== 'clear') title = e.session_title.trim()
    else if (e.source !== 'compact') title = null
    if (e.source === 'clear') return r
    const line = seedFromResume(s, e, await $.clock.now())
    if (line) $.ui.log(line)
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and always is off for every session from its next turn' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session stays warm until ${fmtDuration(DEFAULT_WINDOW_MS)} after its last turn; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (!window) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        // A period of the cache's whole hour or more would fire only once the cache is already cold.
        if (period == null || period < MIN_PING_MS || period >= TTL_MS) return { text: 'every takes a period from 1m to 59m' }
        every = period
      }
      await startWindow($, s, window, every)
      const rolls = s.always && (window < DEFAULT_WINDOW_MS || every !== PING_AFTER_MS)
      return { text: armedText(s, now, window) + (rolls ? `. Always is on, so your next turn makes it at least ${fmtDuration(DEFAULT_WINDOW_MS)} at one ping per ${fmtDuration(PING_AFTER_MS)}` : '') }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-tax' }, async ($, e) => {
    await reseat($, s)
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'preview') {
      // `/cache-tax preview <message>` judges that message as if it had been held; bare, a stock one.
      const text = String(e.args ?? '').trim().replace(/^preview\b\s*/, '') || 'Where were we? Give me a 2 line recap.'
      const h = buildHeld(s, text, now)
      h.advice = await advise($, s, text, now)
      held = h
      const band = await findBand($, s)
      $.ui.invalidate('ui.render')
      const head = band ? 'Preview card shown above the prompt. Its Pay and send would really send that message, so use Dismiss.'
        : 'No band on this surface, so a hold shows as the text below.'
      return { text: `${head}\n\n${h.advice ? adviceText(h.advice, h.zh, 2) : 'No advice: the transcript could not be read.'}` }
    }
    if (words[0] === 'display') {
      const want = words[1]
      if (want !== 'line' && want !== 'band' && want !== 'off') return { text: `/cache-tax display takes line (status line under the prompt), band (row above it) or off; now ${display}` }
      display = want
      await $.store.set(KEY_DISPLAY, display)
      updateStatus($, s, now)
      return { text: want === 'line' ? 'cache-tax status now shows as one line under the prompt' : want === 'band' ? 'cache-tax status now shows as a small row above the prompt' : 'cache-tax status row hidden; /cache-tax status still shows it, and a cold send is still held' }
    }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-tax guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    const mine = ++promptSeq
    held = null
    await reseat($, s)
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    // Without the time of the last response nothing says whether the cache is cold: the price is shown once and the message goes through.
    if (s.resumedAt) {
      const cold = mayBeCold(s, now)
      s.resumedAt = 0
      if (cold && s.ctx >= BIG_TOKENS) $.ui.log(unknownText(s))
      return next(e)
    }
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    // A refused prompt that no person sent would be lost: nobody is there to send it again.
    const unattended = UNATTENDED.has(e.origin.kind)
    if (s.guard === 'warn' || unattended) {
      $.ui.log(`${guardText(s, now)} Sending anyway${unattended ? `, since this ${e.origin.kind} prompt cannot be sent again` : ''}; keepwarm will hold the cache for ${fmtDuration(holdMs(s))} once it lands.`)
      s.coldWritePending = true
      return next(e)
    }
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    const text = e.text
    const attached = (e as { attachments?: unknown[] }).attachments
    const canHold = text.trim() !== '' && (attached?.length ?? 0) === 0 && !text.includes('@') && await findBand($, s)
    // The advice rides in the drop line too: with no band to hold the card, that line is all the person sees.
    const advice = text.trim() ? await advise($, s, text, now) : null
    // Another prompt came while the advice was worked out (the resend, which may already have paid): no card for this one.
    if (mine !== promptSeq) return { drop: 'cache-tax: this message was not sent; another one came in while it was on hold. Send it again if you still want it.' }
    // Where the card shows, it carries the drafts as Copy buttons, so the drop line keeps to the verdict.
    const tail = advice ? `\n\n${adviceText(advice, isZh(text), canHold ? 0 : 1)}` : ''
    if (canHold) {
      held = { ...buildHeld(s, text, now), advice }
      $.ui.invalidate('ui.render')
      return { drop: `cache-tax: your message is on hold. Press Pay and send above the prompt, or send it again.${tail}` }
    }
    return { drop: `cache-tax: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(holdMs(s))}. Or /clear and start from a note.${tail}` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      await reseat($, s)
      // The off count when the turn's first request went out: an off after it wins over what the turn opens.
      if (e.index === 0) s.turnOffs = s.offs
      // A compaction leaves a summary where tens of messages were; a rewind takes a few off. A request over fewer than half the
      // last one's messages is read as a compaction, whether or not session.compact arrived. The context stays as it was, so
      // turn.complete still scores a cold write this turn paid against it before the live figure replaces it.
      if (e.messageCount * 2 < s.transcript) markCompacted(s)
      s.transcript = e.messageCount
      // Only a request sent before any compaction this turn saw can hold a cold write; what follows one is the summary.
      if (!s.compacted) s.steps++
      s.lastRequestAt = await $.clock.now()
    }
    const r = yield* next(e)
    // Each request's write is priced at its own prompt length's tier (Haiku 5.5 changes price at 100k), not the turn's sum.
    const u = r.usage
    if (!e.agentId && u && !s.compacted) {
      const price = priceOf(u.model || e.model, u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens)
      const was = s.stepWrites ?? { tokens: 0, usd: 0, priced: true }
      s.stepWrites = { tokens: was.tokens + u.cache_creation_input_tokens, usd: was.usd + (price ? u.cache_creation_input_tokens * price[1] / 1e6 : 0), priced: was.priced && price != null }
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    // An off at any point in this turn wins over every window the turn would open; a host that raised no
    // step falls back to the count at completion.
    const offs = s.turnOffs ?? s.offs
    s.turnOffs = null
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    // A turn aborted before it sent anything touched no cache, so it leaves the clock alone.
    if ((e.usage || !e.isAborted) && now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    const compacted = s.compacted
    s.compacted = false
    if (s.lastRequestAt) s.resumedAt = 0
    s.waitForTurn = false
    s.ackedAt = 0
    // Always covers any break up to six hours after a turn that reached the cache (a turn that failed before any
    // response touched nothing, and its cache may be cold): a window of at least six hours at the default period,
    // which brings back a stopped window and replaces a shorter one or a testing period. Another session's
    // /keepwarm off or /keepwarm always changes the shared switch, so every such turn reads it.
    if (e.usage) {
      const shared = (await $.store.get(KEY_ALWAYS)) === true
      if (s.offs === offs) s.always = shared
      if (s.always) await startWindow($, s, Math.max(DEFAULT_WINDOW_MS, s.deadline - now), PING_AFTER_MS, offs)
    }
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const written = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + written
      // A compaction since the last complete turn: what followed it is the summary, no cold write, so the turn is scored
      // on the requests before it alone. None before it leaves nothing to score, whatever the guard saw; requests before
      // it that reported no usage leave only the turn's total, an upper bound kept for a send the guard saw go cold.
      const writes = s.stepWrites
      const write = !compacted ? written : writes ? writes.tokens : s.steps && s.coldWritePending ? written : 0
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || (s.coldWritePending && write > 0)) {
        // Priced per request when the steps reported usage; otherwise at the tier of the context the comeback re-sent.
        const price = priceOf(s.lastModel, prev || s.ctx)
        const usd = writes?.priced ? writes.usd : price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        const extend = s.deadline < now + AUTO_WARM_MS && s.offs === offs
        if (extend) await startWindow($, s, AUTO_WARM_MS, s.every, offs)
        $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}).` +
          (extend ? ` Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.` : ''))
      }
    }
    s.coldWritePending = false
    s.stepWrites = null
    s.steps = 0
    await arm($, s)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      markCompacted(s)
      // Between turns nothing is left to score, and the next turn's summary write is not a cold write.
      s.ctx = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
