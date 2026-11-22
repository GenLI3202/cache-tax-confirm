import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { CommandRunInput, ModelCompleteResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { ADVISOR_TIMEOUT_MS, adviceFromRules, buildDigest, heldKind, isZh, parseAdvisor, pathsIn, score } from '../hooks/advice'
import type { Digest, Msg } from '../hooks/advice'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000
const SID = '1acae3c3-98fa-4647-90a7-cfd1c4a769d3'
const ROOT = '/p/dig_twin'

// The two sends the twin session actually had held: a question that names its own subject, and a two-word instruction.
const QUESTION = '精度高的话可以接受仿真多跑一会儿；PyBaMM我看github stars 上千，明显比另外几个好。除了pybamm还有其他类似同等级的开源方案么？甚至都不一定要是python的，你是工程师lead，你精通其他的代码，选择很多的'
const DIRECTIVE = '保持 1:2'

// A transcript shaped like the twin one: subagent hand-backs among the user rows, a file the main thread wrote,
// and a report a subagent wrote that only the last reply names, by a path relative to the project.
const MSGS: Msg[] = [
  { role: 'user', text: '本项目的核心目标是构建 Digital Twin 的高质量Demo，完成整体的关键设计。' },
  { role: 'assistant', text: '好的，先整理资料。', toolUses: [{ tool: 'Write', input: { file_path: `${ROOT}/docs/campaign.md` } }] },
  { role: 'user', text: 'Another Claude session sent a message: <agent-message from="a1"> [Subagent hand-back] done' },
  { role: 'user', text: '3D场景的话主要就是 ominiverse 平台去做渲染对吧？' },
  { role: 'assistant', text: '对，Omniverse 负责渲染。' },
  { role: 'user', text: 'Another Claude session sent a message: <agent-message from="a2"> [Subagent hand-back] report ready' },
  { role: 'user', text: '<command-name>/keepwarm</command-name>' },
  { role: 'assistant', text: '行为模型的调研回来了，报告在 `docs/behavior_model_options.md`，给出三条候选路线。旧稿 /p/dig_twin/docs/old_draft.md 已删，脚本在 ~/.claude/skills/x/run.py。行为模型走哪条路线？' },
]

const session: SessionStartInput = { surface: null, isInteractive: true, cwd: '/w' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-2', ...over,
})
const turn = (): TurnCompleteInput => ({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer', usage: usage() })
const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const run = (args: string): CommandRunInput => ({ command: 'cache-tax', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })

const ANSWER = JSON.stringify({
  verdict: 'handoff',
  reason: '这是一个独立的调研问题，答案只需要调研报告和你的偏好',
  brief: '目标：电池数字孪生 Demo。\n行为模型已有三条候选路线，PyBaMM 是首选。\n精度优先，可以接受更长仿真时间。',
  files: [`${ROOT}/docs/behavior_model_options.md`, '/made/up/file.md'],
})

type ModelAnswer = 'json' | 'fail' | 'hang'

function world(on: On, opts: { surfaces?: string[]; model?: ModelAnswer; theme?: string } = {}) {
  mock.store(on, {})
  const logs: string[] = []
  const copied: string[] = []
  const asked: string[] = []
  on('env.get', () => ({ value: undefined }))
  const reads = { theme: 0 }
  on('config.list', () => {
    reads.theme++
    return { value: (opts.theme ? [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] : []) as never }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: SID }))
  on('session.model', () => ({ value: 'claude-fable-5-2' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: 500139 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/Users/me/digital_twin' }))
  on('session.surfaces', () => ({ value: (opts.surfaces ?? []) as never }))
  on('session.messages', () => ({ value: MSGS as never }))
  on('fs.stat', ($, e) => {
    if (e.path === `${ROOT}/docs/behavior_model_options.md` || e.path === `${ROOT}/docs/campaign.md`) return { value: { kind: 'file' as const, size: 1, mtimeMs: START, isLink: false } }
    if (e.path === ROOT) return { value: { kind: 'dir' as const, size: 0, mtimeMs: START, isLink: false } }
    throw new Error('ENOENT')
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => { statuses.push(e.text); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', ($, e) => { copied.push(e.text); return { value: { isCopied: true as const } } })
  on('model.complete', async ($, e) => {
    asked.push(typeof e.prompt === 'string' ? e.prompt : '')
    if (opts.model === 'hang') await new Promise(() => {})
    const value: ModelCompleteResult = opts.model === 'fail'
      ? { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' } as unknown as ModelCompleteResult
      : { isAnswered: true, text: ANSWER, usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as unknown as ModelCompleteResult
    return { value }
  })
  return { logs, copied, asked, reads, statuses }
}

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 75,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

const resolveNone = async () => null
const base = { id: SID, title: null, cwd: '/w', ctx: 500139, idle: '13h03m' }

describe('rules', () => {
  test('a self-contained question and a short instruction are told apart', async () => {
    expect(heldKind(QUESTION)).toBe('standalone')
    expect(heldKind(DIRECTIVE)).toBe('directive')
    expect(heldKind('按你说的第二条来做，但是把参数表也一起更新一下')).toBe('followup')
    expect(heldKind('选A')).toBe('directive')
    expect(heldKind('now do the same for the other file')).toBe('followup')
    expect(heldKind('yes go')).toBe('directive')
    expect(heldKind('What other open-source battery simulators are as mature as PyBaMM, in any language, and how fast are they?')).toBe('standalone')
    expect(isZh('Please check the 报告 file')).toBe(false)
    expect(isZh(QUESTION)).toBe(true)
  })

  test('the twin question reads as a handoff and the instruction as pay', async () => {
    const resolve = async (p: string) => (p === 'docs/behavior_model_options.md' ? `${ROOT}/${p}` : p === `${ROOT}/docs/campaign.md` ? p : null)
    const q = await buildDigest(MSGS, { ...base, held: QUESTION }, resolve)
    const d = await buildDigest(MSGS, { ...base, held: DIRECTIVE }, resolve)
    expect(q.machine).toBe(2)
    expect(q.asks.some(a => a.startsWith('<command-name>'))).toBe(false)
    expect(q.files[0]).toBe(`${ROOT}/docs/behavior_model_options.md`)
    expect(q.files).toEqual([`${ROOT}/docs/behavior_model_options.md`, `${ROOT}/docs/campaign.md`])
    expect(score(q).verdict).toBe('handoff')
    expect(score(d).verdict).toBe('pay')
    expect(adviceFromRules(d).drafts).toEqual([])
  })

  test('drafts name the session by its full id and carry the held words verbatim', async () => {
    const q = await buildDigest(MSGS, { ...base, held: QUESTION }, resolveNone)
    const [handoff, own] = adviceFromRules(q).drafts
    expect(handoff?.text).toContain(`接续 Claude 会话 ${SID}`)
    expect(handoff?.text).toContain('--source claude')
    expect(handoff?.text.endsWith(QUESTION)).toBe(true)
    expect(own?.text.endsWith(QUESTION)).toBe(true)
  })

  test('paths in a reply, and a model answer that invents one', async () => {
    expect(pathsIn('报告在 `docs/behavior_model_options.md`，另见 /Users/x/a.md 和 https://x.io/a.md')).toEqual(['docs/behavior_model_options.md', '/Users/x/a.md'])
    expect(pathsIn('see **/Users/x/y.md** and /Users/x/z.ts:42 and /Users/x/w.md的内容 and ////')).toEqual(['/Users/x/y.md', '/Users/x/z.ts', '/Users/x/w.md'])
    const sys = await buildDigest([{ role: 'assistant', text: 'read /etc/hosts and ~/.ssh/id_rsa.md and /Users/x/.env and /Users/x/ok.md' }], { ...base, held: QUESTION }, async p => p.replace('~', '/Users/x'))
    expect(sys.files).toEqual(['/Users/x/ok.md'])
    const d: Digest = { ...base, held: QUESTION, zh: true, asks: [], machine: 0, files: [`${ROOT}/a.md`], checkpoint: null, lastReply: '' }
    const a = parseAdvisor('```json\n{"verdict":"handoff","reason":"可以","files":["/made/up.md"]}\n```', d)
    expect(a?.source).toBe('model')
    expect(a?.drafts[0]?.text).toContain(`${ROOT}/a.md`)
    expect(a?.drafts[0]?.text).not.toContain('/made/up.md')
    expect(parseAdvisor('not json', d)).toBe(null)
    expect(parseAdvisor('{"verdict":"maybe","reason":"x"}', d)).toBe(null)
  })
})

async function goCold($: Parameters<TestBody>[0], clock: { advance: (ms: number) => Promise<void> }) {
  await $.session.start(session)
  await $.turn.complete(turn())
  await clock.advance(14 * HOUR)
}

describe('held send', () => {
  test('the desktop app reports no surface at start: the drop line still carries the advice and a draft', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { surfaces: [] })
    await goCold($, clock)
    const r = await $.prompt.submit(prompt(QUESTION))
    expect(r.drop).toMatch(/^cache-tax: the prompt cache went cold/)
    expect(r.drop).toContain('建议：适合新开会话接续')
    expect(r.drop).toContain(`用 session-handoff 接续 Claude 会话 ${SID}`)
    expect(r.drop).toContain(QUESTION)
    expect(r.drop).not.toContain('/made/up/file.md')
    // The model read a digest, not the context: a few thousand characters at most.
    expect(w.asked.length).toBe(1)
    expect((w.asked[0] ?? '').length).toBeLessThan(8000)
  })

  test('a surface that attaches later gets the card, with the verdict and a working copy button', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { surfaces: ['desktop'] })
    await goCold($, clock)
    const r = await $.prompt.submit(prompt(QUESTION))
    expect(r.drop).toMatch(/^cache-tax: your message is on hold/)
    expect(r.drop).toContain('建议：适合新开会话接续')
    // The card holds the drafts as Copy buttons: neither it nor the drop line prints one.
    expect(r.drop).not.toContain(`接续 Claude 会话 ${SID}`)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface, component: 'AbovePrompt', props: bandProps })
      expect((await ui.find({ type: 'Text', text: /建议：适合新开会话接续/ }))).toBeTruthy()
      expect(await ui.find({ type: 'Text', text: /接续 Claude 会话/ })).toBeFalsy()
      expect(await ui.find({ type: 'Code' })).toBeFalsy()
      await ui.press({ key: 'copy-0' })
      await ui.unmount()
    }
    expect(w.copied.length).toBe(2)
    expect(w.copied[0]).toContain(`接续 Claude 会话 ${SID}`)
  })

  test('the model failing falls back to the rules, which say pay for a short instruction', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: [], model: 'fail' })
    await goCold($, clock)
    const r = await $.prompt.submit(prompt(DIRECTIVE))
    expect(r.drop).toContain('建议：建议付费续用本会话')
    expect(r.drop).not.toContain('session-handoff')
    expect(r.drop).toContain('.claude/checkpoint.md')
  })

  test('a model that does not answer in time is cut off and the rules answer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: [], model: 'hang' })
    await goCold($, clock)
    const pending = $.prompt.submit(prompt(QUESTION))
    await clock.advance(ADVISOR_TIMEOUT_MS + 1000)
    const r = await pending
    expect(r.drop).toContain('建议：适合新开会话接续')
    expect(r.drop).toContain(`接续 Claude 会话 ${SID}`)
  })

  test('a second prompt while the advice is worked out leaves no stale card', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: ['desktop'], model: 'hang' })
    await goCold($, clock)
    const first = $.prompt.submit(prompt(QUESTION))
    const second = $.prompt.submit(prompt('/cache-tax status'))
    await clock.advance(ADVISOR_TIMEOUT_MS + 1000)
    expect((await second).drop).toBe(undefined)
    expect((await first).drop).toMatch(/not sent; another one came in/)
    const ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: /On hold/ })).toBeFalsy()
    await ui.unmount()
  })

  test('a band found after start reads the theme once', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { surfaces: [], theme: 'light' })
    await goCold($, clock)
    expect(w.reads.theme).toBe(0)
    const ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await ui.unmount()
    const again = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    await again.unmount()
    expect(w.reads.theme).toBe(1)
  })

  test('/cache-tax preview judges a message given to it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: [] })
    await goCold($, clock)
    const r = await $.command.run(run(`preview ${QUESTION}`))
    expect(r.text).toContain('No band on this surface')
    expect(r.text).toContain('建议：适合新开会话接续')
    expect(r.text).toContain('自带摘要，不依赖技能')
  })
})

describe('display', () => {
  const keepwarm = (args: string): CommandRunInput => ({ command: 'keepwarm', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const row = /cache-tax · /

  test('on the desktop the idle status is a short band row by default; line, band and off switch it', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, { surfaces: ['desktop'] })
    await $.session.start(session)
    await $.command.run(keepwarm(''))
    await $.turn.complete(turn())
    // The default: one short row in the band, nothing in the status line under the prompt.
    let ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: row })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /last ping read|^keepwarm / })).toBeFalsy()
    await ui.unmount()
    expect(w.statuses.at(-1)).toBe(undefined)

    await $.command.run(run('display line'))
    ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: row })).toBeFalsy()
    await ui.unmount()
    expect(w.statuses.at(-1)).toMatch(/^warm · \d+h\d+m left · ping in /)
    // The minute tick keeps the countdown current without any event.
    const before = w.statuses.at(-1)
    await clock.advance(2 * MIN)
    expect(w.statuses.at(-1)).not.toBe(before)

    expect((await $.command.run(run('display band'))).text).toMatch(/row above/)
    expect(w.statuses.at(-1)).toBe(undefined)
    ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: row })).toBeTruthy()
    await ui.unmount()

    await $.command.run(run('display off'))
    expect(w.statuses.at(-1)).toBe(undefined)
    ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: row })).toBeFalsy()
    await ui.unmount()

    expect((await $.command.run(run('display sideways'))).text).toMatch(/takes line .* now off/)
  })

  test('a cold send on the desktop is still held behind the card in line mode', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, { surfaces: ['desktop'] })
    await goCold($, clock)
    const r = await $.prompt.submit(prompt(DIRECTIVE))
    expect(r.drop).toMatch(/^cache-tax: your message is on hold/)
    const ui = await $.ui.mount({ plugin: 'cache-tax-confirm', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: /on hold|消息已暂缓/i })).toBeTruthy()
    await ui.unmount()
  })
})
