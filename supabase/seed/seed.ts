import { createClient } from '@supabase/supabase-js'
import type { LeadRow } from '../../packages/core/src/types.ts'
import { classify } from '../../packages/core/src/classify.ts'

/**
 * Local demo data. Run with `pnpm seed`.
 *
 * Everything here is relative to NOW (trap 1). The six leads under the first
 * agent are defined by their distance from `now`, not by calendar dates, so
 * the seed produces the same six states whenever it runs.
 *
 * // SPEC-GAP: §11 says "~40 messages total in the fixture voice" and lists
 * six lead descriptors but specifies no message bodies. These are written in
 * the style §10 asks for — realistic, lowercase, typo-ridden Singapore
 * property chat — and the two cold threads are deliberately differentiated by
 * whether a timeline is ever stated (see trap 3).
 */

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set. Get it from `supabase status -o json`.')
}
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

/** `SEED_NOW` lets the eval harness (task 12) pin a run to a fixed instant. */
const NOW = process.env.SEED_NOW ? new Date(process.env.SEED_NOW) : new Date()
if (Number.isNaN(NOW.getTime())) throw new Error('SEED_NOW is not a valid date')
const DAY = 86_400_000

/** N days before NOW, at a given SGT hour. Trap 1 — never hardcode a date. */
const ago = (days: number, sgtHour = 10) => {
  const d = new Date(NOW.getTime() - days * DAY)
  d.setUTCHours(sgtHour - 8, 5, 0, 0)
  return d.toISOString()
}

const AGENT_NAMES = ['Wei Ling', 'Terence Koh']

/**
 * Two voices. §9 cut the `/settings` route, so this contrast is the whole
 * mechanism behind §12's "same lead + two voice profiles produces two visibly
 * different drafts" checkbox. Wei Ling matches the fixture voice in §10;
 * Terence Koh is deliberately her opposite on every axis that matters.
 */
const AGENTS = [
  {
    name: 'Wei Ling',
    max_touches: 4,
    quiet_hours_start: 9,
    quiet_hours_end: 20,
    voice_profile: {
      formality: 2,
      warmth: 4,
      brevity: 4,
      emoji_ok: false,
      sign_off: '- Wei Ling',
      sample_messages: [
        'hey Marcus! just saw a 3 bedder in katong that might work for u, want me to send?',
        'no worries, take ur time. shout when ready ya',
        'ok noted! ill keep a lookout for D15 under 1.5m',
      ],
    },
  },
  {
    name: 'Terence Koh',
    max_touches: 4,
    quiet_hours_start: 9,
    quiet_hours_end: 20,
    voice_profile: {
      formality: 5,
      warmth: 2,
      brevity: 1,
      emoji_ok: false,
      sign_off: 'Best regards,\nTerence Koh',
      sample_messages: [
        'Good afternoon Mr Marcus. I trust this message finds you well. I am writing to inform you that a three-bedroom unit has become available in the Katong vicinity.',
        'Thank you for your response. Please do not hesitate to contact me should you require any further clarification on the matter.',
        'Noted with thanks. I shall revert to you once I have compiled a suitable shortlist for your consideration.',
      ],
    },
  },
]

type SeedMsg = { direction: 'inbound' | 'outbound'; days: number; hour: number; body: string }
type SeedLead = {
  key: string
  /** What classify() must return for this lead. Asserted at the end of main(). */
  expect: string
  name: string
  phone: string
  source: string
  touch_count: number
  inboundDays: number | null
  outboundDays: number | null
  createdDays: number
  opted_out?: boolean
  messages: SeedMsg[]
}

const LEADS: SeedLead[] = [
  {
    // cold + a fact gap: budget, district and bedrooms are all stated, but
    // nobody ever mentions a timeline -> factGaps() returns ['timeline']
    // once task 9 extracts, so gap_fill (60) wins over listing_hook (50).
    key: 'cold_with_gap',
    expect: 'cold',
    name: 'Marcus Tan',
    phone: '+6591230001',
    source: 'propertyguru',
    touch_count: 1,
    inboundDays: 21,
    outboundDays: 20,
    createdDays: 40,
    messages: [
      { direction: 'inbound', days: 40, hour: 21, body: 'hi saw ur listing on pg, still available ah' },
      { direction: 'outbound', days: 40, hour: 21, body: 'Hi Marcus! yes still available. what are u looking for?' },
      { direction: 'inbound', days: 39, hour: 9, body: 'looking at katong area, budget around 1.5m for a 3 bedder' },
      { direction: 'outbound', days: 39, hour: 10, body: 'noted! D15 3 bedders around that range, i have a few. own stay or invest?' },
      { direction: 'inbound', days: 39, hour: 12, body: 'own stay, me n my wife' },
      { direction: 'outbound', days: 30, hour: 11, body: 'hey Marcus, 2 new units came up in D15. want me to send the details?' },
      { direction: 'inbound', days: 21, hour: 20, body: 'ya can send, sorry been busy' },
      { direction: 'outbound', days: 20, hour: 10, body: 'sent to ur email! let me know what u think' },
    ],
  },
  {
    // cold + complete: all four REQUIRED_FOR_QUALIFIED facts are stated in the
    // thread (buy / 1.2m / D19 / "next 3 months"), so there is no gap and
    // listing_hook (50) is the highest rule left standing.
    key: 'cold_complete',
    expect: 'cold',
    name: 'Priya Nair',
    phone: '+6591230002',
    source: '99co',
    touch_count: 1,
    inboundDays: 21,
    outboundDays: 20,
    createdDays: 50,
    messages: [
      { direction: 'inbound', days: 50, hour: 14, body: 'hi, saw the serangoon listing on 99co' },
      { direction: 'outbound', days: 50, hour: 15, body: 'Hi Priya! thanks for reaching out. buying or renting?' },
      { direction: 'inbound', days: 49, hour: 10, body: 'buying. budget max 1.2m, looking at D19 only' },
      { direction: 'outbound', days: 49, hour: 11, body: 'got it. how many bedrooms u need?' },
      { direction: 'inbound', days: 49, hour: 13, body: '3 bedroom. hoping to move in the next 3 months' },
      { direction: 'outbound', days: 49, hour: 14, body: 'perfect, thats doable in D19 at 1.2m. ill shortlist some' },
      { direction: 'inbound', days: 45, hour: 9, body: 'ok thanks' },
      { direction: 'outbound', days: 40, hour: 16, body: 'hi Priya, 3 units in D19 that fit. sending now' },
      { direction: 'inbound', days: 21, hour: 19, body: 'sorry just saw this, still looking ya' },
      { direction: 'outbound', days: 20, hour: 10, body: 'no problem! ill keep u posted on new D19 launches' },
    ],
  },
  {
    // TRAP 2. Zero messages, on purpose. classify() returns 'new' only when
    // last_inbound_at is null; one inbound message flips this lead to 'warm'
    // and new_ad_lead (75) stops firing. Do not "fix" this by adding a thread.
    key: 'new_ad',
    expect: 'new',
    name: 'Jonathan Lim',
    phone: '+6591230003',
    source: 'meta_ad',
    touch_count: 0,
    inboundDays: null,
    outboundDays: null,
    createdDays: 1,
    messages: [],
  },
  {
    // warm + already touched -> warm_human_handles (80) suppresses. This is
    // the product's core promise as a rule: the AI stays out of a live
    // conversation the agent is already having.
    key: 'warm_handled',
    expect: 'warm',
    name: 'Siti Rahman',
    phone: '+6591230004',
    source: 'referral',
    touch_count: 2,
    inboundDays: 2,
    outboundDays: 1,
    createdDays: 30,
    messages: [
      { direction: 'inbound', days: 30, hour: 11, body: 'hi, my colleague gave me ur number. looking to rent' },
      { direction: 'outbound', days: 30, hour: 12, body: 'Hi Siti! sure. which area and whats ur budget?' },
      { direction: 'inbound', days: 29, hour: 9, body: 'tampines or pasir ris, around 3.5k a month' },
      { direction: 'outbound', days: 29, hour: 10, body: 'ok noted. 2 or 3 bedder?' },
      { direction: 'inbound', days: 29, hour: 15, body: '3 bedder, moving in sept' },
      { direction: 'outbound', days: 10, hour: 11, body: 'hi Siti, a few 3 bedders in tampines came up. free to view this wkend?' },
      { direction: 'inbound', days: 2, hour: 20, body: 'yes im keen! sat afternoon can?' },
      { direction: 'outbound', days: 1, hour: 10, body: 'sat 2pm works! ill confirm the unit and revert' },
    ],
  },
  {
    // opted out -> do_not_contact -> hard_suppress (100). The final inbound
    // carries two §6.2 keywords ("stop messaging" and "already bought"), which
    // is what task 10's ingest-inbound will detect. opted_out is set directly
    // here because that function does not exist yet.
    key: 'opted_out',
    expect: 'do_not_contact',
    name: 'Kelvin Ong',
    phone: '+6591230005',
    source: 'propertyguru',
    touch_count: 1,
    inboundDays: 5,
    outboundDays: 6,
    createdDays: 35,
    opted_out: true,
    messages: [
      { direction: 'inbound', days: 35, hour: 13, body: 'hi enquiring about the bedok unit' },
      { direction: 'outbound', days: 35, hour: 14, body: 'Hi Kelvin! its still available. keen to view?' },
      { direction: 'inbound', days: 34, hour: 10, body: 'let me think first' },
      { direction: 'outbound', days: 20, hour: 11, body: 'hi Kelvin, just checking if ure still looking?' },
      { direction: 'outbound', days: 6, hour: 10, body: 'hi Kelvin, new bedok listing came up, keen?' },
      { direction: 'inbound', days: 5, hour: 18, body: 'pls stop messaging me, already bought' },
    ],
  },
  {
    // 60 days silent -> dormant -> long_dormant (30) / market_update.
    key: 'dormant',
    expect: 'dormant',
    name: 'Rachel Goh',
    phone: '+6591230006',
    source: 'manual',
    touch_count: 1,
    inboundDays: 60,
    outboundDays: 59,
    createdDays: 90,
    messages: [
      { direction: 'inbound', days: 90, hour: 16, body: 'hi, met u at the queenstown showflat last wkend' },
      { direction: 'outbound', days: 90, hour: 17, body: 'Hi Rachel! good to hear from u. still considering the 2 bedder?' },
      { direction: 'inbound', days: 89, hour: 11, body: 'ya but waiting for my hdb to sell first' },
      { direction: 'outbound', days: 89, hour: 12, body: 'understood! ping me when its sold, ill line up some viewings' },
      { direction: 'inbound', days: 60, hour: 15, body: 'still not sold yet, market quite slow' },
      { direction: 'outbound', days: 59, hour: 10, body: 'no worries Rachel, ill check in again in a bit' },
    ],
  },
]

/**
 * The lead mirrored under the second agent. Same thread, same timings,
 * different voice profile — which is exactly the input task 12's two-voice
 * fixture needs to print two drafts side by side.
 */
const VOICE_CONTRAST_KEY = 'cold_with_gap'

async function main() {
  console.log(`Seeding against ${SUPABASE_URL}`)
  console.log(`now = ${NOW.toISOString()}`)

  // Idempotent: `pnpm seed` twice must not produce twelve leads. Deleting the
  // agents cascades to leads -> messages / lead_facts / drafts (§3).
  const { error: delErr } = await db.from('agents').delete().in('name', AGENT_NAMES)
  if (delErr) throw new Error(`clearing previous seed failed: ${delErr.message}`)

  const { data: agents, error: agentErr } = await db.from('agents').insert(AGENTS).select('id, name')
  if (agentErr || !agents) throw new Error(`inserting agents failed: ${agentErr?.message}`)
  const agentId: Record<string, string> = Object.fromEntries(agents.map((a) => [a.name, a.id]))
  console.log(`  agents: ${agents.map((a) => a.name).join(', ')}`)

  let messageCount = 0
  const inserted: { key: string; id: string; expect: string }[] = []

  for (const [i, spec] of LEADS.entries()) {
    const targets = [{ agent: 'Wei Ling', suffix: '' }]
    if (spec.key === VOICE_CONTRAST_KEY) targets.push({ agent: 'Terence Koh', suffix: ' (voice B)' })

    for (const t of targets) {
      const aid = agentId[t.agent]!
      const { data: lead, error: leadErr } = await db
        .from('leads')
        .insert({
          agent_id: aid,
          name: spec.name + t.suffix,
          phone: t.suffix ? spec.phone.replace(/\d$/, String(9 - i)) : spec.phone,
          source: spec.source,
          // Trap 4: placeholder only. generate-drafts owns this column.
          state: 'new',
          qualification_status: 'unqualified',
          last_inbound_at: spec.inboundDays === null ? null : ago(spec.inboundDays, 20),
          last_outbound_at: spec.outboundDays === null ? null : ago(spec.outboundDays, 10),
          touch_count: spec.touch_count,
          opted_out: spec.opted_out ?? false,
          created_at: ago(spec.createdDays, 9),
        })
        .select('id')
        .single()
      if (leadErr || !lead) throw new Error(`inserting lead ${spec.key} failed: ${leadErr?.message}`)

      if (spec.messages.length) {
        const rows = spec.messages.map((m) => ({
          lead_id: lead.id,
          agent_id: aid,
          direction: m.direction,
          body: m.body,
          sent_at: ago(m.days, m.hour),
          provider: 'mock',
          provider_msg_id: `seed-${spec.key}${t.suffix ? '-b' : ''}-${m.days}-${m.hour}`,
        }))
        const { error: msgErr } = await db.from('messages').insert(rows)
        if (msgErr) throw new Error(`inserting messages for ${spec.key} failed: ${msgErr.message}`)
        messageCount += rows.length
      }
      if (!t.suffix) inserted.push({ key: spec.key, id: lead.id, expect: spec.expect })
    }
  }

  console.log(`  leads: ${LEADS.length} under Wei Ling + 1 mirrored under Terence Koh`)
  console.log(`  messages: ${messageCount}`)

  // The whole point of this seed is "6 leads across states". Prove it with the
  // real classify() against the rows actually stored, rather than trusting the
  // day-offsets above to still mean what they meant when they were written.
  const { data: check, error: checkErr } = await db
    .from('leads')
    .select('*')
    .in('id', inserted.map((l) => l.id))
  if (checkErr || !check) throw new Error(`re-reading leads failed: ${checkErr?.message}`)

  const byId = new Map(check.map((l) => [l.id, l]))
  let failures = 0
  console.log('\n  state check (classify() on the rows actually stored):')
  for (const { key, id, expect } of inserted) {
    const actual = classify(byId.get(id) as unknown as LeadRow, NOW)
    const ok = actual === expect
    if (!ok) failures++
    console.log(`    ${ok ? 'ok  ' : 'FAIL'} ${key.padEnd(16)} expected ${expect.padEnd(15)} got ${actual}`)
  }
  if (failures) throw new Error(`${failures} lead(s) did not classify as intended`)
  console.log('\nSeed complete.')
}

main().catch((err) => {
  console.error(`\nSeed failed: ${err.message}`)
  process.exit(1)
})
