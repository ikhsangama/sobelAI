# QA Test Suite Specification: Eval Fixtures (`packages/eval/fixtures`)

This document serves as the **Standardized QA Test Case Specification** for the 12 evaluation test fixtures used by the **`pnpm eval`** harness.

> ⚠️ **Notice on JSON Format:**  
> Standard `.json` fixture files cannot contain inline `//` comments due to `JSON.parse()`. This `README.md` is the authoritative QA reference specifying pre-conditions, inputs, and expected outcomes for every test case.

---

## 📐 Standardized QA Test Case Template

Every test case in this suite follows a uniform 5-part QA specification:

1. **Test Objective:** The specific functionality, boundary condition, or regression risk being tested.
2. **Pre-conditions & Input Data:** Lead status, source, touch count, and historical chat messages.
3. **Expected Fact Extraction (`facts_extracted` & `facts_absent`):** Exact facts that must be mined vs facts that must NOT be inferred.
4. **Expected Pipeline Decisions:** Lead state classification, winning priority rule, and action strategy.
5. **Expected Draft Assertions:** Anti-hallucination (`G3`) and tone quality rules (`toneCheck`).

---

## 📚 Standardized QA Test Specifications (F01 – F20)

---

### `F01_cold_buyer_21d` — Cold Buyer (21 Days Silent)
* **Test Objective:** Verify fact extraction, missing fact gap detection, and strategy selection for a cold lead silent for 21 days.
* **Pre-conditions & Input Data:** 
  * Lead: Marcus (`source: propertyguru`, `touch_count: 1`, `days_silent: 21`).
  * Inbound Chat: *"hi saw ur listing, im looking at katong area, budget around 1.5m for a 3 bedder"*.
  * Outbound Chat: *"Hi Marcus! Sure, I have a few options in D15. When are you looking to move?"*.
* **Expected Fact Extraction:**
  * `facts_extracted`: `districts: ["D15"]`, `budget_max: 1500000`, `bedrooms: 3`, `transaction_type: "buy"`.
  * `facts_absent`: `timeline` (Buyer never mentioned move-in date; must not infer).
* **Expected Pipeline Decisions:**
  * `state`: `cold`
  * `rule_fired`: `gap_fill` (Priority 60)
  * `strategy`: `fill_missing_fact` (Ask for missing timeline)
* **Expected Draft Assertions:** `no_hallucinated_entities: true`, `tone_acceptable: true`.
* **Multi-Agent Coverage:** Tested against both Primary Agent (Wei Ling - Casual) and Secondary Agent (Terence Koh - Formal). *Assertions are 100% agent-invariant.*

---

### `F02_cold_buyer_complete` — Cold Buyer (All Facts Complete)
* **Test Objective:** Verify strategy selection when all key facts are already known and no fact gaps remain.
* **Pre-conditions & Input Data:** 
  * Lead: Priya (`source: 99co`, `touch_count: 1`, `days_silent: 21`).
  * Inbound Chat: *"hi, buying. budget max 1.2m, looking at D19 only. 3 bedroom, hoping to move in the next 3 months"*.
  * Outbound Chat: *"noted Priya! ill shortlist some and revert"*.
* **Expected Fact Extraction:**
  * `facts_extracted`: `districts: ["D19"]`, `budget_max: 1200000`, `bedrooms: 3`, `timeline: "3 months"`.
  * `facts_absent`: `[]` (All 4 facts present).
* **Expected Pipeline Decisions:**
  * `state`: `cold`
  * `rule_fired`: `listing_hook` (Priority 50)
  * `strategy`: `new_listing_hook` (Recommend new unit options)
* **Expected Draft Assertions:** `no_hallucinated_entities: true`, `tone_acceptable: true`.

---

### `F03_new_ad_lead` — New Lead from Meta Ad Form
* **Test Objective:** Verify instant qualification greeting generation for brand new leads from digital ad forms.
* **Pre-conditions & Input Data:** 
  * Lead: Jonathan Lim (`source: meta_ad`, `touch_count: 0`, `last_inbound_at: null`, `created_at: <1 hour ago`).
  * Messages: `[]` (No WhatsApp messages yet).
* **Expected Fact Extraction:** `facts_extracted: []`.
* **Expected Pipeline Decisions:**
  * `state`: `new`
  * `rule_fired`: `new_ad_lead` (Priority 75)
  * `strategy`: `instant_qualify` (Send initial qualifying greeting)
* **Expected Draft Assertions:** `no_hallucinated_entities: true`, `tone_acceptable: true`.

---

### `F05_opt_out` — Opt-Out Keyword Detection
* **Test Objective:** Verify permanent lead suppression when an opt-out keyword is sent by the buyer.
* **Pre-conditions & Input Data:** 
  * Lead: Kelvin Ong (`source: propertyguru`, `touch_count: 1`).
  * Inbound Chat: *"stop messaging me, found already"*.
* **Expected Keyword Detection:** Keyword `stop messaging` matched ➔ Sets `opted_out: true`.
* **Expected Pipeline Decisions:**
  * `state`: `do_not_contact`
  * `rule_fired`: `hard_suppress` (Priority 100)
  * `strategy`: `suppress` (No draft created)
* **Expected Draft Assertions:** `no_draft: true`.

---

### `F07_snoozed` — Snooze Request Handling
* **Test Objective:** Verify temporal suppression when a lead explicitly requests a delayed follow-up.
* **Pre-conditions & Input Data:** 
  * Lead: Rachel Goh (`source: manual`, `snooze_until: +30 days`).
  * Inbound Chat: *"busy now, call me next month"*.
* **Expected Keyword Detection:** Keyword `call me next month` matched ➔ Sets `snooze_until: +30 days`.
* **Expected Pipeline Decisions:**
  * `state`: `cold` (or `dormant`)
  * `rule_fired`: `snoozed` (Priority 95)
  * `strategy`: `suppress` (AI stays silent during snooze window)
* **Expected Draft Assertions:** `no_draft: true`.

---

### `F08_warm_human_handles` — Active Inbound Reply Protection
* **Test Objective:** Verify that AI stays silent when a lead actively replies, allowing the human agent to converse directly.
* **Pre-conditions & Input Data:** 
  * Lead: Siti Rahman (`source: referral`, `touch_count: 1`, `daysSinceInbound: 0`).
  * Inbound Chat: *"hi Wei Ling, can we view the D15 unit this Saturday?"*.
* **Expected Pipeline Decisions:**
  * `state`: `warm` (Active conversation < 7 days)
  * `rule_fired`: `warm_human_handles` (Priority 80)
  * `strategy`: `suppress` (AI does not interrupt active chat)
* **Expected Draft Assertions:** `no_draft: true`.

---

### `F09_touch_cap` — Maximum Touch Cap Enforcement
* **Test Objective:** Verify anti-spam protection when maximum consecutive outbound attempts are reached without reply.
* **Pre-conditions & Input Data:** 
  * Lead: Marcus (`touch_count: 4`, `max_touches: 4`).
  * History: 4 consecutive outbound messages sent by agent with zero buyer replies.
* **Expected Pipeline Decisions:**
  * `state`: `cold`
  * `rule_fired`: `touch_cap` (Priority 90)
  * `strategy`: `suppress` (Halt automated outreach to prevent spamming)
* **Expected Draft Assertions:** `no_draft: true`.

---

### `F12_budget_under_1m` — One-Sided Budget Asymmetry Guard
* **Test Objective:** Verify that "under 1m" extracts `budget_max` only and does NOT invent a `budget_min`.
* **Pre-conditions & Input Data:** 
  * Lead: Tan Ah Kow (`source: propertyguru`).
  * Inbound Chat: *"looking for condo under 1m in east side"*.
* **Expected Fact Extraction:**
  * `facts_extracted`: `budget_max: 1000000`.
  * `facts_absent`: `budget_min` (Must NOT infer a lower bound).
* **Expected Pipeline Decisions:**
  * `state`: `cold`
  * `rule_fired`: `gap_fill` (Priority 60)
  * `strategy`: `fill_missing_fact`

---

### `F14_contradicts_budget` — Fact History & Superseding Audit
* **Test Objective:** Verify that an updated budget value supersedes the old row while preserving history.
* **Pre-conditions & Input Data:** 
  * Lead: Priya (`source: 99co`).
  * Message 1 (Past): *"budget max 1.0m"*.
  * Message 2 (New): *"actually budget 1.5m now"*.
* **Expected Fact Extraction:**
  * Active `budget_max`: `1500000`.
  * History: Old `1000000` row marked `superseded_at = now()`.
* **Expected Pipeline Decisions:** `rule_fired: gap_fill`, `strategy: fill_missing_fact`.

---

### `F18_anti_inference_tampines` — Residence vs Target Location Anti-Inference
* **Test Objective:** Verify that a buyer's current residence is NOT falsely extracted as their target purchase location.
* **Pre-conditions & Input Data:** 
  * Lead: Jonathan Lim.
  * Inbound Chat: *"i stay in tampines, looking to buy in the east"*.
* **Expected Fact Extraction:**
  * `facts_extracted`: `[]` (or general east region).
  * `facts_absent`: `districts` containing `D18` (Tampines must NOT be inferred as target).
* **Expected Pipeline Decisions:** `rule_fired: gap_fill`, `strategy: fill_missing_fact`.

---

### `F19_no_budget_no_district` — Entity Hallucination Guard (Empty Context)
* **Test Objective:** Verify that AI does not invent prices or districts when chat history is completely vague.
* **Pre-conditions & Input Data:** 
  * Lead: Marcus.
  * Inbound Chat: *"hi can you send me some good options to view?"*.
* **Expected Fact Extraction:** `facts_extracted: []`.
* **Expected Draft Assertions:**
  * `no_hallucinated_entities: true` (Draft MUST NOT contain any price $ or district DXX).

---

### `F20_price_not_stated` — Price Hallucination Guard (Unstated Dollar Amount)
* **Test Objective:** Verify that AI does not invent a dollar figure when buyer asks about pricing without naming an amount.
* **Pre-conditions & Input Data:** 
  * Lead: Rachel Goh.
  * Inbound Chat: *"is the price negotiable for this listing?"*.
* **Expected Fact Extraction:** `facts_absent: ["budget_max", "budget_min"]`.
* **Expected Draft Assertions:**
  * `no_hallucinated_entities: true` (Draft MUST NOT fabricate a specific dollar figure).
