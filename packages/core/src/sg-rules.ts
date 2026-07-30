/**
 * DISTRICTS and AREA_ALIASES are geography — they don't change.
 *
 * No Singapore property POLICY threshold (ABSD rate, LTV ratio, MOP duration,
 * EIP quota) is encoded anywhere in this file, or anywhere in this repo, by
 * design. ELIGIBILITY_TOPICS below only decides which clarifying QUESTION the
 * assistant asks (see guardrail G4 — "no advice"); the system never asserts
 * an eligibility fact or a number tied to one.
 */

export const DISTRICTS = {
  D01: { region: 'CCR', areas: ['Raffles Place', 'Marina', 'Cecil'] },
  D02: { region: 'CCR', areas: ['Tanjong Pagar', 'Anson'] },
  D03: { region: 'RCR', areas: ['Queenstown', 'Tiong Bahru', 'Alexandra'] },
  D04: { region: 'RCR', areas: ['Sentosa', 'Harbourfront', 'Telok Blangah'] },
  D05: { region: 'RCR', areas: ['Clementi', 'Pasir Panjang', 'West Coast'] },
  D06: { region: 'CCR', areas: ['High Street', 'Beach Road', 'City Hall'] },
  D07: { region: 'CCR', areas: ['Bugis', 'Rochor', 'Golden Mile'] },
  D08: { region: 'RCR', areas: ['Little India', 'Farrer Park'] },
  D09: { region: 'CCR', areas: ['Orchard', 'River Valley', 'Somerset'] },
  D10: { region: 'CCR', areas: ['Tanglin', 'Holland', 'Bukit Timah'] },
  D11: { region: 'CCR', areas: ['Newton', 'Novena', 'Watten', 'Thomson'] },
  D12: { region: 'RCR', areas: ['Balestier', 'Toa Payoh', 'Serangoon'] },
  D13: { region: 'RCR', areas: ['Macpherson', 'Braddell', 'Potong Pasir'] },
  D14: { region: 'RCR', areas: ['Geylang', 'Eunos', 'Paya Lebar'] },
  D15: { region: 'RCR', areas: ['East Coast', 'Marine Parade', 'Katong', 'Joo Chiat'] },
  D16: { region: 'OCR', areas: ['Bedok', 'Upper East Coast', 'Siglap'] },
  D17: { region: 'OCR', areas: ['Changi', 'Loyang', 'Flora'] },
  D18: { region: 'OCR', areas: ['Tampines', 'Pasir Ris'] },
  D19: { region: 'OCR', areas: ['Hougang', 'Punggol', 'Sengkang', 'Serangoon Gardens'] },
  D20: { region: 'OCR', areas: ['Ang Mo Kio', 'Bishan', 'Thomson'] },
  D21: { region: 'OCR', areas: ['Upper Bukit Timah', 'Clementi Park', 'Ulu Pandan'] },
  D22: { region: 'OCR', areas: ['Jurong', 'Boon Lay', 'Tuas'] },
  D23: { region: 'OCR', areas: ['Bukit Batok', 'Bukit Panjang', 'Choa Chu Kang', 'Dairy Farm'] },
  D24: { region: 'OCR', areas: ['Lim Chu Kang', 'Tengah'] },
  D25: { region: 'OCR', areas: ['Admiralty', 'Woodlands'] },
  D26: { region: 'OCR', areas: ['Mandai', 'Upper Thomson'] },
  D27: { region: 'OCR', areas: ['Sembawang', 'Yishun'] },
  D28: { region: 'OCR', areas: ['Seletar', 'Yio Chu Kang'] },
} as const;

/** Colloquial → district. Lowercased substring match, longest match wins. */
export const AREA_ALIASES: Record<string, keyof typeof DISTRICTS> = {
  'east coast': 'D15', 'katong': 'D15', 'joo chiat': 'D15', 'marine parade': 'D15',
  'bishan': 'D20', 'amk': 'D20', 'ang mo kio': 'D20',
  'cck': 'D23', 'choa chu kang': 'D23', 'bukit batok': 'D23',
  'tpy': 'D12', 'toa payoh': 'D12',
  'orchard': 'D09', 'river valley': 'D09',
  'holland v': 'D10', 'holland village': 'D10', 'bukit timah': 'D10',
  'tampines': 'D18', 'pasir ris': 'D18',
  'punggol': 'D19', 'sengkang': 'D19', 'hougang': 'D19',
  'yishun': 'D27', 'sembawang': 'D27',
  'woodlands': 'D25', 'admiralty': 'D25',
  'jurong': 'D22', 'boon lay': 'D22',
  'clementi': 'D05', 'west coast': 'D05',
  'tiong bahru': 'D03', 'queenstown': 'D03',
  'bedok': 'D16', 'siglap': 'D16',
  'novena': 'D11', 'newton': 'D11', 'thomson': 'D11',
  'tanjong pagar': 'D02',
  'geylang': 'D14', 'paya lebar': 'D14',
};

export type BuyerProfile = 'citizen' | 'pr' | 'foreigner' | 'unknown';

/**
 * The keywords G4 ("no advice") checks for — if a draft mentions any of
 * these, it must phrase the sentence as a question (see G4).
 *
 * `ask` is documentation of *why* each topic exists, not executable logic.
 * // SPEC-GAP: an earlier draft had a `triggerWhen` field meant to gate which
 * question fill_missing_fact should ask. Nothing in §6.3 or §7.2 consumes a
 * condition language, and building a parser for one is scope this repo
 * doesn't need — fill_missing_fact fills gaps from REQUIRED_FOR_QUALIFIED
 * only (§5). Deleted rather than left unevaluated.
 */
export const ELIGIBILITY_TOPICS = [
  { id: 'mop',       ask: 'whether their HDB has met its Minimum Occupation Period' },
  { id: 'absd',      ask: 'whether they have factored in Additional Buyer\'s Stamp Duty' },
  { id: 'eip',       ask: 'whether the block still has quota under the Ethnic Integration Policy' },
  { id: 'ltv',       ask: 'whether their loan-to-value limit is affected by an existing mortgage' },
  { id: 'lease_min', ask: 'their intended lease term (HDB has a minimum tenancy period)' },
] as const;

/** Flat keyword list G4 scans for — the only part of ELIGIBILITY_TOPICS that's executable. */
export const ELIGIBILITY_KEYWORDS = ['MOP', 'ABSD', 'EIP', 'LTV', 'stamp duty'] as const;

/** Deterministic guardrail: reject the draft outright. Case-insensitive. */
export const BANNED_PHRASES = [
  'guaranteed', 'guarantee', 'sure profit', 'no risk', 'risk-free',
  'will definitely appreciate', 'confirm will appreciate', 'confirm can',
  'you qualify', 'you are eligible', 'you will be eligible',
  'best price in the market', 'last unit', 'only one left',
  'must buy now', 'price will go up next week',
  'i can get you approved', 'financing is not a problem',
];

/**
 * The ONE length limit in the repo. §7.2 and §7.3 both reference this
 * constant by name instead of restating a number — three different numbers
 * (480/400/~400) used to appear across sg-rules.ts and the two prompts,
 * which meant a 430-char draft could pass G1 and still fail tone check for
 * a reason the agent couldn't act on. Fixed by having one source of truth.
 */
export const MAX_DRAFT_CHARS = 400;
export const MIN_DRAFT_CHARS = 40;
export const SGT_OFFSET_HOURS = 8;
