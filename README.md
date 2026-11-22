# cache-tax-confirm

[简体中文](README.zh-CN.md)

A patched copy of [karanb192/cache-tax](https://github.com/karanb192/cache-tax) 2.3.1 (MIT, see [LICENSE](LICENSE); the original is by Karan Bansal) for the Claude desktop app.

**The idea.** Claude's prompt cache goes cold after an idle spell, and the first message after that re-writes the whole context at full price. Upstream cache-tax refuses that message and tells you. This patch keeps that guard and makes it easy to act on: the refused message waits behind a card that shows the price, with **Pay and send** and **Dismiss**, and it tells you whether the message is worth paying for or should move to a fresh session.

## Install

```text
/plugin install cache-tax-confirm --marketplace GenLI3202/cache-tax-confirm
```

(or `claude plugin install cache-tax-confirm --marketplace GenLI3202/cache-tax-confirm` from a shell; in the desktop app use **+ → Plugins → Add marketplace**).

**Do not install this beside the upstream `cache-tax` mod**: both register `/keepwarm` and `/cache-tax`.

## What it changes


**Held send.** When the prompt cache is cold and the guard is on `refuse`, the message is still dropped,
but a card above the prompt shows the price with a **Pay and send** button and a **Dismiss** button. Pay and
send resubmits the held text as your own words. A message with an attachment or an `@` mention keeps the
original behaviour (send it again to pay).

**Pay or hand off (confirm.4).** At the same moment the mod decides whether the held message is worth paying for
or should go to a new session, and says why:

- It reads the transcript the session already holds into a short digest: the held message, your last few
  messages, the last reply, hand-backs from subagents and other sessions, and the files the work lives in
  (documents first, each checked on disk; `.claude/checkpoint.md` from the checkpoint mod counts most).
- Rules give a verdict with no call. Then Haiku reads the digest (a few thousand characters, never the context)
  and gives its own; it is cut off after 8 s and the rules answer instead. The call costs well under a cent.
- A self-contained question with its conclusions on disk reads as **hand off**; a short instruction mid-task
  ("保持 1:2", "选A") reads as **pay**.
- For hand off it writes two prompts to paste into a new session: one through the `session-handoff` skill
  (by full session id, so it never matches the wrong session), and one that carries its own brief and needs no
  skill. Both end with the held message word for word, since a dropped message is not in the record.
- For pay it offers **Pay, send and write a handoff note**, which appends a request to write
  `.claude/checkpoint.md`, so the payment also buys a handoff.

The verdict and the first draft are in the "hook blocked your prompt" line too, since some hosts do not show the
card. The card adds a **Copy** button per draft.

`/cache-tax preview <message>` shows the card and the advice for that message without holding anything.

**Fixes.** The band (status row and card) was decided only from `session.start`, which reports no surface in the
desktop app, so the card never showed there; it is now found when a surface draws or is listed. The desktop
card's progress bar read a variable it could not see.

**Display (confirm.5).** The idle status row no longer floats above the prompt. By default it is one short line in
the status line under the prompt (`warm · 6h35m left · ping in 3m`; the host already labels the line with the mod's name, so since confirm.7 the text does not repeat it), refreshed once a minute.
`/cache-tax display band` brings back a smaller row above the prompt, `/cache-tax display off` hides it, and
`/cache-tax display line` returns to the default; the choice is kept across sessions. The Pay and send card for a held
cold send still shows above the prompt in every mode.

**Compact card (confirm.6).** The held-send card is a few small lines: one header line, one price line, the held
message cut to a line, the verdict with its reason, and the buttons. The handoff drafts are no longer printed in the
card, each is a **Copy** button; where the card shows, the "hook blocked your prompt" line carries the verdict only.
With no band to hold a card, that line still carries the first draft in full.

**Status in the band (confirm.8).** The default display is `band` again, now one caption-size line with the short text
(`cache-tax · warm · 6h00m left · ping in 49m`), so it sits inside the panel above the prompt beside crab-pal's row.
`/cache-tax display line` puts it back under the prompt.

**No row of its own (confirm.9).** On the desktop, when another mod has a row in the band (crab-pal's beach), the
status takes no row: an `AbovePromptList` hook leaves its row out and floats the same line at the bottom centre of
the band, so the panel is no taller. Since confirm.13 the float is a 10px picture at the left end of the band, left of this session's crab, in two
lines: `cache-tax warm` above the sand beside the crabs, `5h51m · ping 47m` under it, level with the names. The
band clips anything drawn outside its rows, so a float cannot sit in the bottom padding. With no other row, or while a cold send is held, it draws its own row as before.

Everything else (`/keepwarm`, `/cache-tax`) is upstream's.

The patch also looks at other mods of the same author when they are installed (crab-pal for the shared band, checkpoint for `.claude/checkpoint.md`); none is required.

## Tests

```bash
claude plugin test .
```
