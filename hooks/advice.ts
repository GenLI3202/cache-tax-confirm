// Should a cold send be paid, or carried to a new session? Built from the transcript the session already holds, with
// rules alone (no call) and then, if a cheap model answers in time, with its reading of the same digest.

/** `handoff`: a new session from a short prompt loses little. `pay`: the next step leans on what only this context holds. */
export type Verdict = 'handoff' | 'pay' | 'either'

/** The parts of a SessionMessage read here. */
export type Msg = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: ReadonlyArray<{ tool: string; input: Record<string, unknown> }>
}

export type Digest = {
  id: string
  title: string | null
  cwd: string
  ctx: number
  idle: string
  held: string
  zh: boolean
  /** What the person typed lately, oldest first, clipped. */
  asks: string[]
  /** Subagent hand-backs, other sessions' messages and task notices among the recent user rows: links a new session does not have. */
  machine: number
  /** Files the work lives in, absolute where they could be resolved, the most recently touched first. */
  files: string[]
  /** A checkpoint or handoff note among them. */
  checkpoint: string | null
  /** The last reply with text, clipped. */
  lastReply: string
}

export type Draft = { label: string; text: string }

export type Advice = {
  verdict: Verdict
  reason: string
  drafts: Draft[]
  /** Who judged: the rules alone, or the model over the same digest. */
  source: 'rules' | 'model'
}

export const ADVISOR_MODEL = 'haiku'
export const ADVISOR_TIMEOUT_MS = 8000

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const RECENT_ROWS = 14
const ASKS = 6
const ASK_CLIP = 220
const REPLY_CLIP = 1200
const MAX_FILES = 6
const MAX_DRAFT_FILES = 5
// Candidates looked up on disk at most, found or not: a session full of moved files must not stall the hold.
const MAX_TRIES = 20
const BRIEF_CLIP = 900

const CJK = /[㐀-鿿豈-﫿]/
const MACHINE = /^(Another Claude session sent a message|<agent-message|<cross-session-message|<task-notification|<teammate-message)/
// Rows the person did not type as a request: command wrappers and shell escapes.
const NOT_ASK = /^(<local-command|<command-name>|<command-message>|<bash-input>|<bash-stdout>|<bash-stderr>|<user-memory-input>|\[Request interrupted)/
const BACKREF_ZH = /(这个|那个|这些|那些|上面|上述|刚才|刚刚|前面|之前|你说的|你提到|按你|照你|继续|接着|就这样|就按|保持|选\s*[A-Za-z一二三四五]|方案\s*[A-Za-z一二三四五]|第[一二三四五六七八九十]\s*[条个点步])/
const BACKREF_EN = /\b(this one|that one|these|those|above|earlier|you said|as you said|continue|go ahead|keep it|option [a-e]|the (first|second|third) one|the same|same for|now do|do it|again|the other)\b/i
// Paths a reply names: absolute, home-relative, or a relative path with a folder and an extension.
const PATH = /(?:^|[\s`'"(（「*])((?:~\/|\/)[^\s`'"()（）「」<>，。；：]+|[A-Za-z0-9_.-]+\/[^\s`'"()（）「」<>，。；：]*\.[A-Za-z0-9]{1,8})(?=$|[\s`'")）」，。；：,.;:])/g
const HANDOFF_NOTE = /(checkpoint|handoff|交接)[^/]*\.md$/i

const CJK_ALL = new RegExp(CJK.source, 'g')

/** Chinese when CJK carries the message, not when one name or quote in it is Chinese. */
export function isZh(text: string): boolean {
  // A Chinese character carries about what an English word does.
  const cjk = (text.match(CJK_ALL) ?? []).length
  const words = (text.match(/[A-Za-z]+/g) ?? []).length
  return cjk >= 2 && cjk >= words
}

function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > n ? flat.slice(0, n) + '…' : flat
}

function strip(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim()
}

export type HeldKind = 'standalone' | 'followup' | 'directive'

/** A short instruction leans on the turn before it; a long question that names its subject stands on its own. */
export function heldKind(text: string): HeldKind {
  const t = text.trim()
  const backref = BACKREF_ZH.test(t) || BACKREF_EN.test(t)
  if (CJK.test(t)) {
    // Characters: a Chinese sentence says in 25 what an English one says in 8 words.
    const size = [...t.replace(/\s+/g, '')].length
    if (size <= 12) return 'directive'
    if (backref && size < 60) return 'followup'
    return size >= 25 ? 'standalone' : 'followup'
  }
  const words = t.split(/\s+/).filter(Boolean).length
  if (words <= 3) return 'directive'
  if (backref && words < 20) return 'followup'
  return words >= 10 ? 'standalone' : 'followup'
}

/** Paths in a reply, in the order they appear, cleaned of markdown emphasis, a `:line` suffix and Chinese run on after them. */
export function pathsIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(PATH)) {
    let p = (m[1] ?? '').replace(/^\*+|\*+$/g, '').replace(/[.,;:]+$/, '').replace(/:\d+(?::\d+)?$/, '')
    const cut = new RegExp(`^(.*?\\.[A-Za-z0-9]{1,8})(?=${CJK.source})`).exec(p)
    if (cut?.[1]) p = cut[1]
    if (p.includes('://') || p.length < 4 || /^\/+$/.test(p)) continue
    if (/^\/(?:[A-Za-z]+)$/.test(p)) continue
    out.push(p)
  }
  return out
}

const DOC = /\.(md|markdown|html?|txt|rst|tsv|csv|pdf|ipynb|docx?)$/i

// Agent plumbing (skills, plugins, memory, tool output) and scratch space say nothing a new session needs to read;
// the checkpoint note is the one file under .claude/ that does.
function kept(path: string): boolean {
  if (/\/\.claude\/checkpoint\.md$/.test(path)) return true
  if (/(^|\/)\.claude\/|\/tool-results\/|\/node_modules\/|^\/(?:tmp|private\/tmp)\//.test(path)) return false
  // System files and secrets never go in a list a new session is told to read.
  return !/^\/(?:dev|etc|proc|sys|usr|bin|sbin|var|System|Library|private\/etc)(\/|$)|(^|\/)\.(?:ssh|gnupg|aws|config\/gh)(\/|$)|(^|\/)\.env(\.|$)|\.(?:pem|key|p12)$/.test(path)
}

/**
 * Reads the transcript into a digest. `resolve` answers where a path a reply named or the session edited is on disk
 * now, absolute, or null when it is not there; it is the only thing here that touches the disk.
 */
export async function buildDigest(
  msgs: readonly Msg[],
  base: { id: string; title: string | null; cwd: string; ctx: number; idle: string; held: string },
  resolve: (path: string, near: readonly string[]) => Promise<string | null>,
): Promise<Digest> {
  const asks: string[] = []
  let machine = 0
  let seen = 0
  const edited: string[] = []
  const named: string[] = []
  let lastReply = ''
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'assistant') {
      for (const use of m.toolUses ?? []) {
        const p = use.input?.file_path ?? use.input?.notebook_path
        if (EDIT_TOOLS.has(use.tool) && typeof p === 'string' && !edited.includes(p)) edited.push(p)
      }
      const text = m.text.trim()
      if (text) {
        if (!lastReply) lastReply = clip(text, REPLY_CLIP)
        if (named.length < 40) for (const p of pathsIn(text)) if (!named.includes(p)) named.push(p)
      }
      continue
    }
    const text = strip(m.text)
    if (!text || NOT_ASK.test(text)) continue
    if (seen >= RECENT_ROWS) continue
    seen++
    if (MACHINE.test(text)) machine++
    else if (asks.length < ASKS) asks.unshift(clip(text, ASK_CLIP))
  }
  // Notes written for picking the work up again first; then documents, which hold conclusions, before code. Among
  // each, what replies pointed at (subagents' reports among them, which the main thread never edited) before what the
  // main thread edited. Each candidate must be found on disk; the search stops once there are enough.
  const doc = (p: string) => DOC.test(p)
  const ranked = [
    ...[...edited, ...named].filter(p => HANDOFF_NOTE.test(p)),
    ...named.filter(doc), ...edited.filter(doc),
    ...edited.filter(p => !doc(p)), ...named.filter(p => !doc(p)),
  ]
  const files: string[] = []
  const tried = new Set<string>()
  for (const p of ranked) {
    if (files.length >= MAX_FILES || tried.size >= MAX_TRIES) break
    if (tried.has(p) || !kept(p)) continue
    tried.add(p)
    const found = await resolve(p, edited)
    if (found && kept(found) && !files.includes(found)) files.push(found)
  }
  const checkpoint = files.find(p => HANDOFF_NOTE.test(p)) ?? null
  return { ...base, zh: isZh(base.held), asks, machine, files, checkpoint, lastReply }
}

type Score = { verdict: Verdict; why: string[] }

/** The rules: what the held message leans on, whether the work is on disk, and how much a long context costs per turn. */
export function score(d: Digest): Score {
  const zh = d.zh
  const why: string[] = []
  let n = 0
  const kind = heldKind(d.held)
  if (kind === 'standalone') {
    n += 2
    why.push(zh ? '这条消息自成一问，不依赖上文细节' : 'the message stands on its own')
  } else if (kind === 'directive') {
    n -= 2
    why.push(zh ? '这条是对上一轮的简短指令，接着做最顺' : 'it is a short instruction that continues the last turn')
  } else {
    why.push(zh ? '这条消息指向上文' : 'the message points back at the conversation')
  }
  if (d.checkpoint) {
    n += 2
    why.push(zh ? '已有交接笔记' : 'a handoff note exists')
  } else if (d.files.length) {
    n += 1
    why.push(zh ? `结论已写进 ${d.files.length} 个文件` : `the work is in ${d.files.length} files`)
  }
  if (d.ctx >= 300000) {
    n += 1
    why.push(zh ? '上下文很长，热缓存每轮也贵' : 'the context is long, so even warm turns cost a lot')
  }
  if (d.machine >= 2) {
    n -= 1
    why.push(zh ? '最近有子代理或其他会话的回传，新会话接不上这些联系' : 'recent hand-backs from subagents or other sessions would not carry over')
  }
  const verdict: Verdict = n >= 2 ? 'handoff' : n <= -1 ? 'pay' : 'either'
  return { verdict, why }
}

function fileList(files: readonly string[], zh: boolean): string {
  if (!files.length) return ''
  const lines = files.slice(0, MAX_DRAFT_FILES).map(f => `- ${f}`).join('\n')
  return zh ? `先读这些文件，以文件里的当前内容为准：\n${lines}\n\n` : `First read these files; what they say now wins:\n${lines}\n\n`
}

function sessionName(d: Digest): string {
  return d.title ? `${d.id}（"${d.title}"）` : d.id
}

/** The drafts: one through the session-handoff skill, one that carries its own brief and needs no skill. */
export function drafts(d: Digest, brief: string | null, files: readonly string[]): Draft[] {
  const zh = d.zh
  const where = d.cwd ? (zh ? `，原工作目录 ${d.cwd}` : `, which ran in ${d.cwd}`) : ''
  const handoff = zh
    ? `用 session-handoff 接续 Claude 会话 ${sessionName(d)}${where}，--source claude -n 6。\n\n${fileList(files, zh)}然后回答我在原会话里没发出去的这条消息：\n\n${d.held}`
    : `Use session-handoff to continue the Claude conversation ${d.title ? `${d.id} ("${d.title}")` : d.id}${where}, with --source claude -n 6.\n\n${fileList(files, zh)}Then answer the message I could not send there:\n\n${d.held}`
  // The brief is model-written: capped, and labelled as a summary the files overrule.
  const written = brief?.trim() ?? ''
  const context = written ? (written.length > BRIEF_CLIP ? written.slice(0, BRIEF_CLIP) + '…' : written) : d.lastReply ? clip(d.lastReply, 400) : ''
  const own = zh
    ? `${context ? `背景（自动整理的摘要，与文件不符时以文件为准）：\n${context}\n\n` : ''}${fileList(files, zh)}我的问题：\n\n${d.held}`
    : `${context ? `Background (an automatic summary; the files win where they differ):\n${context}\n\n` : ''}${fileList(files, zh)}My question:\n\n${d.held}`
  return [
    { label: zh ? '用 session-handoff 接续' : 'Continue with session-handoff', text: handoff },
    { label: zh ? '自带摘要，不依赖技能' : 'Self-contained, no skill needed', text: own },
  ]
}

export function adviceFromRules(d: Digest): Advice {
  const { verdict, why } = score(d)
  const sep = d.zh ? '；' : '; '
  return { verdict, reason: why.join(sep), drafts: verdict === 'pay' ? [] : drafts(d, null, d.files), source: 'rules' }
}

/** What the cheap model reads: the digest, never the context itself. */
export function advisorPrompt(d: Digest): { system: string; prompt: string } {
  const lang = d.zh ? 'Simplified Chinese' : 'English'
  const system = [
    'You decide whether a coding-agent conversation whose prompt cache went cold should be resumed (paying to re-send the whole context) or handed off to a fresh session started from a short prompt.',
    'A fresh session started with the session-handoff skill gets: the last 4 rounds of the old conversation in full, earlier user messages as short excerpts, plus any files on disk. It loses tool outputs, mid-session reasoning, and links to running subagents or other sessions.',
    'Say "handoff" when the held message can be answered from files plus the last few rounds (a self-contained question, research, a new sub-task). Say "pay" when it continues work in flight that leans on details only the context holds (a short instruction mid-task, debugging state, decisions never written down). Say "either" when it is close.',
    `Answer with one JSON object and nothing else: {"verdict":"handoff|pay|either","reason":"one sentence in ${lang}, under 60 words","brief":"3 to 6 short lines in ${lang}: the goal, decisions so far, and where things stand, only what the held message needs; no file list","files":["paths copied exactly from the list given, the ones the next step needs, most important first, at most 5"]}`,
  ].join('\n')
  const lines = [
    `Context size: ${d.ctx.toLocaleString('en-US')} tokens. Cache cold for ${d.idle}.`,
    `Recent hand-backs from subagents or other sessions: ${d.machine}.`,
    '',
    'Files (most recent first):',
    ...(d.files.length ? d.files.map(f => `- ${f}`) : ['- none found']),
    '',
    'Recent user messages, oldest first:',
    ...(d.asks.length ? d.asks.map((a, i) => `${i + 1}. ${a}`) : ['(none)']),
    '',
    'Last assistant reply (clipped):',
    d.lastReply || '(none)',
    '',
    'The held message, which the user wants answered next:',
    d.held,
  ]
  return { system, prompt: lines.join('\n') }
}

/** Reads the model's answer; null when it is not the object asked for. */
export function parseAdvisor(text: string, d: Digest): Advice | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const verdict = o.verdict === 'handoff' || o.verdict === 'pay' || o.verdict === 'either' ? o.verdict : null
  if (!verdict || typeof o.reason !== 'string' || !o.reason.trim()) return null
  // Only paths the digest offered: a path the model made up would send the new session looking for nothing.
  const picked = Array.isArray(o.files) ? o.files.filter((f): f is string => typeof f === 'string' && d.files.includes(f)) : []
  const files = picked.length ? picked : d.files
  const brief = typeof o.brief === 'string' ? o.brief : null
  return { verdict, reason: o.reason.trim(), drafts: verdict === 'pay' ? [] : drafts(d, brief, files), source: 'model' }
}

const VERDICT_ZH: Record<Verdict, string> = { handoff: '适合新开会话接续', pay: '建议付费续用本会话', either: '两种都行' }
const VERDICT_EN: Record<Verdict, string> = { handoff: 'hand it off to a new session', pay: 'pay and keep this session', either: 'either works' }

export function verdictLabel(a: Advice, zh: boolean): string {
  return (zh ? VERDICT_ZH : VERDICT_EN)[a.verdict]
}

/** The advice as plain text, for the drop line and the terminal. `drafts` caps how many drafts it spells out. */
export function adviceText(a: Advice, zh: boolean, draftsShown = 1): string {
  const head = zh ? `建议：${verdictLabel(a, zh)}。${a.reason}。` : `Advice: ${verdictLabel(a, zh)}. ${a.reason}.`
  const parts = [head.replace(/。。$/, '。').replace(/\.\.$/, '.')]
  const shown = a.drafts.slice(0, draftsShown)
  for (const dr of shown) parts.push(zh ? `\n新会话里粘贴（${dr.label}）：\n${dr.text}` : `\nPaste into a new session (${dr.label}):\n${dr.text}`)
  if (a.verdict === 'pay') {
    parts.push(zh ? '付费前可以在消息末尾加一句"答完后把交接笔记写进 .claude/checkpoint.md"，这样这次的钱也买到一份交接。'
      : 'Before paying, you can end the message with "then write a handoff note to .claude/checkpoint.md", so the payment also buys a handoff.')
  }
  return parts.join('\n')
}

/** What "Pay, send and write a note" sends: the held words, then the ask for a note. */
export function withNote(text: string, zh: boolean): string {
  return zh
    ? `${text}\n\n（答完后，把交接笔记写进 .claude/checkpoint.md，覆盖旧的：目标、已定结论和理由、待定问题、相关文件、下一步。60 行以内。）`
    : `${text}\n\n(When done, write a handoff note to .claude/checkpoint.md, replacing any old one: goal, decisions and why, open questions, files, next steps. Under 60 lines.)`
}
