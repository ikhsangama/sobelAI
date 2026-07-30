import { describe, expect, it } from 'vitest'
import {
  OPT_OUT_KEYWORDS,
  SNOOZE_KEYWORDS,
  SNOOZE_DAYS_DEFAULT,
  SNOOZE_DAYS_NEXT_YEAR,
  detectKeywords,
} from './keywords'

const SENT_AT = new Date('2026-07-30T12:00:00.000Z')
const detect = (body: string) => detectKeywords(body, SENT_AT)
const daysAfter = (n: number) =>
  new Date(SENT_AT.getTime() + n * 86_400_000).toISOString()

describe('§6.2 keyword lists are transcribed exactly', () => {
  it('carries all 12 opt-out keywords in the contract order', () => {
    expect(OPT_OUT_KEYWORDS).toEqual([
      'stop',
      'unsubscribe',
      'remove me',
      "don't message",
      'dont message',
      'stop messaging',
      'not interested anymore',
      'already bought',
      'already rented',
      'found already',
      'got already',
      'dont contact',
    ])
  })

  it('carries all 7 snooze keywords in the contract order', () => {
    expect(SNOOZE_KEYWORDS).toEqual([
      'call me next month',
      'next month',
      'after cny',
      'after chinese new year',
      'q1',
      'next year',
      'busy now',
    ])
  })

  it('every opt-out keyword actually fires on a message containing it', () => {
    for (const keyword of OPT_OUT_KEYWORDS) {
      // `stop` is whole-message-only by design; the rest work in a sentence.
      const body = keyword === 'stop' ? 'stop' : `hi there, ${keyword} please`
      expect(detect(body).opted_out, `keyword "${keyword}" never fires`).toBe(true)
    }
  })

  it('every snooze keyword actually fires on a message containing it', () => {
    for (const keyword of SNOOZE_KEYWORDS) {
      const r = detect(`ok lah ${keyword} then`)
      expect(r.snooze_until, `keyword "${keyword}" never fires`).not.toBeNull()
    }
  })
})

describe('opt-out detection', () => {
  it('opts out on a bare "stop" regardless of case or punctuation', () => {
    for (const body of ['stop', 'STOP', 'Stop.', '  stop  ', 'stop!']) {
      expect(detect(body)).toEqual({ opted_out: true, snooze_until: null, keyword_hit: 'stop' })
    }
  })

  it('reports the specific phrase, not bare "stop", for an in-sentence opt-out', () => {
    const r = detect('pls stop messaging me, already bought')
    expect(r.opted_out).toBe(true)
    expect(r.keyword_hit).toBe('stop messaging')
  })

  it('matches a curly apostrophe, which is what phone keyboards emit', () => {
    expect(detect('don’t message me again').opted_out).toBe(true)
    expect(detect("don't message me again").opted_out).toBe(true)
  })

  it('never sets snooze_until when opting out', () => {
    const r = detect('stop messaging me, call me next year maybe')
    expect(r.opted_out).toBe(true)
    expect(r.snooze_until).toBeNull()
  })
})

describe('opt-out false positives — the whole reason `stop` is whole-message-only', () => {
  // Every one of these permanently kills a live lead under a plain substring
  // read of §6.2. `opted_out` has no reverse anywhere in the contract.
  const ordinary = [
    'can i stop by the showflat this weekend?',
    'ok i will stop by tomorrow after work',
    'is there a bus stop nearby?',
    'the mrt stop is quite far right',
    'i stopped looking at D15, focusing on D19 now',
    'non-stop flights from changi, so location matters',
    'my agent stopped replying so im looking again',
    'we can stop at 1.2m if the unit is good',
  ]

  for (const body of ordinary) {
    it(`does not opt out: "${body}"`, () => {
      expect(detect(body).opted_out).toBe(false)
    })
  }
})

describe('opt-out false positives — mixed English/Chinese messages (§7.1 supports this)', () => {
  // A prior bareWord() implementation stripped every non-[a-z0-9] character,
  // including CJK text, so any mostly-Chinese message that merely mentioned
  // the English word "stop" collapsed to the bare string "stop" and opted
  // the lead out. Both of these are ordinary bus-stop questions, not opt-outs.
  const mixedLanguage = ['巴士站 stop 在哪里', '这个 stop 离我很近']

  for (const body of mixedLanguage) {
    it(`does not opt out: "${body}"`, () => {
      expect(detect(body).opted_out).toBe(false)
    })
  }
})

describe('snooze detection', () => {
  it('defaults to +30 days', () => {
    const r = detect('call me next month')
    expect(r.snooze_until).toBe(daysAfter(SNOOZE_DAYS_DEFAULT))
    expect(r.keyword_hit).toBe('call me next month')
    expect(r.opted_out).toBe(false)
  })

  it('uses +60 days for "next year" only', () => {
    expect(detect('maybe next year lah').snooze_until).toBe(daysAfter(SNOOZE_DAYS_NEXT_YEAR))
    expect(detect('busy now, ping me later').snooze_until).toBe(daysAfter(SNOOZE_DAYS_DEFAULT))
  })

  it('measures the snooze from sentAt, not from the current clock', () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z')
    expect(detectKeywords('busy now', earlier).snooze_until).toBe(
      new Date(earlier.getTime() + SNOOZE_DAYS_DEFAULT * 86_400_000).toISOString(),
    )
  })

  it('reports the more specific phrase when both would match', () => {
    // "call me next month" precedes "next month" in §6.2's order.
    expect(detect('call me next month ok').keyword_hit).toBe('call me next month')
  })
})

describe('no match', () => {
  it('returns all-clear for an ordinary message', () => {
    expect(detect('looking at katong area, budget around 1.5m for a 3 bedder')).toEqual({
      opted_out: false,
      snooze_until: null,
      keyword_hit: null,
    })
  })

  it('does not match a keyword embedded in a longer token', () => {
    // `q1` must not fire inside "q12"; digit-aware boundaries, not \b.
    expect(detect('stack q12 please').keyword_hit).toBeNull()
  })
})
