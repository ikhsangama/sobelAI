import type { Fact } from './types.ts'

export const FACT_KEYS = [
  'transaction_type',   // 'buy' | 'rent' | 'sell'
  'property_type',      // 'hdb' | 'hdb_resale' | 'condo' | 'ec' | 'landed'
  'budget_min',         // number, SGD
  'budget_max',         // number, SGD
  'districts',          // string[] e.g. ['D15','D16']
  'bedrooms',           // number
  'timeline',           // 'immediate' | '1_3_months' | '3_6_months' | '6_12_months' | 'exploring'
  'buyer_profile',      // 'citizen' | 'pr' | 'foreigner'
  'current_housing',    // 'hdb' | 'condo' | 'renting' | 'with_family'
  'purpose',            // 'own_stay' | 'investment'
  'lease_term',         // string, rentals only
  'move_in_date',       // ISO date, rentals only
  'owns_property',      // boolean
  'has_existing_loan',  // boolean
] as const;

/** A lead is `qualified` only when all four are present. */
export const REQUIRED_FOR_QUALIFIED = [
  'transaction_type', 'budget_max', 'districts', 'timeline',
] as const;

export function factGaps(facts: Fact[]): string[] {
  const present = new Set(facts.filter(f => !f.superseded_at).map(f => f.key));
  return REQUIRED_FOR_QUALIFIED.filter(k => !present.has(k));
}
