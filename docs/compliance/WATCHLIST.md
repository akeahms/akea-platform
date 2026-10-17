# US compliance watchlist

What the Akea AI Suite depends on, where each rule lives in the code, and where to check for changes.
The monthly compliance review (a scheduled task) works through this list, records what it found in
`CHANGELOG.md`, and opens a pull request for anything that needs a change. Nothing is published to
customers until a person approves the pull request (and, for legal wording, a Texas attorney reviews it).

## Where things live

| What | File(s) |
| --- | --- |
| Legal documents (Terms, Subscription Agreement, Privacy, DPA, AUP, Disclaimers, Cookies, Accessibility) | `web/site/legal.json` |
| Version everyone must accept (change all three together; a new version makes every user and Principal accept again) | `web/site/legal.json` → `version`, `web/src/legal.tsx` → `LEGAL_VERSION`, `mobile/src/lib/legal.ts` → `LEGAL_VERSION`, database `public.legal_version()` (new migration) |
| In-app page notices | `web/src/App.tsx` → `PAGE_NOTES` |
| Overtime rules (federal + CA, AK, CO daily) | database `public.payroll_hours_v2()` (migration `20261017_23`) and the note in `web/src/pages/workforce.tsx` |
| Record keeping (no deletes, punch change log) | migration `20261017_23` (`_keep_records`, `time_punch_changes`) |
| Password rules | `supabase/functions/set-password/index.ts`, `web/src/security.tsx`, `private.password_problems()` |
| Subprocessor list | `web/site/legal.json` → `dpa` section 5 (30 days' notice to customers before adding one) |
| Email footer | `supabase/functions/daily-snapshot/snapshot.ts` |

## Laws and standards to watch

**Wage and hour (Workforce)**
- FLSA: 29 U.S.C. 201 et seq.; 29 CFR 516 (records), 29 CFR 778 (overtime, regular rate), 29 CFR 785 (hours worked, rounding). Source: dol.gov/agencies/whd, Federal Register.
- Exempt salary threshold (29 CFR 541): currently enforced at the 2019 level after the 2024 rule was vacated; watch for a new rule.
- State daily overtime and premiums: California (Labor Code 510, meal/rest premiums 226.7, IWC Wage Order 5 for hotels), Alaska (AS 23.10.060), Colorado (COMPS Order), Nevada (NRS 608.018); new state laws on daily overtime.
- Predictive scheduling / fair workweek ordinances (e.g. San Francisco, Los Angeles hotel workers, Seattle, Chicago, NYC, Oregon, Philadelphia, Evanston).
- Minimum wage changes (federal, state, local; hotel-worker minimum wages such as Los Angeles) — affects estimates only.
- Child labor hour limits (federal and state).

**Privacy and security (all departments)**
- State consumer privacy laws: CA (CCPA/CPRA and CPPA regulations, incl. risk-assessment, cybersecurity audit and ADMT rules), TX (TDPSA), VA, CO, CT, UT, OR, MT, IA, DE, NH, NJ, TN, MN, MD, IN, KY, RI and any new state law; effective dates.
- State data-breach notification laws (all 50 states) and timelines.
- FTC Act Section 5 guidance, FTC Safeguards Rule scope, COPPA rule changes.
- CAN-SPAM; state email/SMS rules if texting is added (TCPA).
- AI laws: Colorado AI Act (SB 24-205, effective date changes), California ADMT regulations, Texas TRAIGA, NYC Local Law 144 (automated employment decisions), Illinois HB 3773.
- Biometric laws (Illinois BIPA, Texas CUBI, Washington) — only if biometric clock-in is ever added.

**Finance and accounting**
- IRS record retention (26 CFR 1.6001), Form 1099-NEC/MISC thresholds (One Big Beautiful Bill Act raised the 1099 threshold to $2,000 for payments after 2025 — verify current), W-9/TIN rules, backup withholding.
- UCC Articles 3 and 4 (check fraud responsibility), Nacha rules (if ACH is added), check-printing standards (ANSI X9.100-160 MICR) — not currently printed.
- State sales and hotel occupancy tax changes (rates shown in reports only).
- Securities: SEC Regulation D / general solicitation, state blue-sky rules for investor communications; investment-adviser definitions.
- PCI DSS (only if card data is ever stored; it isn't).

**Antitrust (market data, pricing)**
- Sherman Act Section 1 cases on algorithmic pricing in hotels (e.g. Gibson v. Cendyn, 9th Cir. 2025; Atlantic City casino-hotel cases) and DOJ/FTC guidance on information sharing.
- California AB 325 and SB 763 (Cartwright Act amendments on common pricing algorithms, effective 2026) and similar bills in other states and cities.
- The Services must not recommend prices or pool customers' non-public pricing data; AUP and Disclaimers say so.

**Accessibility**
- ADA Title III case law, DOJ ADA Title II web rule (WCAG 2.1 AA, April 2026/2027 deadlines for public entities), WCAG updates.

**Contracts and consumer protection**
- Federal Arbitration Act case law and AAA rule changes (Commercial, Consumer, Mass Arbitration supplementary rules and fees).
- Texas law on limitation periods (Tex. Civ. Prac. & Rem. Code 16.070: no shorter than 2 years), conspicuousness and express-negligence rules for releases and indemnities.
- State automatic-renewal laws (California ARL, others) for subscription billing.
- FTC "click-to-cancel" / negative option rule status.
- Export controls and OFAC sanctions lists.

**Third parties**
- STR / CoStar data licence terms; Plaid, Finicity, Intuit, Anthropic, Supabase, Render, Postmark, Expo terms and subprocessor changes; Apple App Store and Google Play policy updates (account deletion, privacy labels).

## Patents

There is no automatic way to guarantee non-infringement. The monthly review notes newly granted US patents or lawsuits that mention hotel-operations, time-clock, bank-reconciliation, check-printing or natural-language-reporting software, and flags them for patent counsel. A freedom-to-operate opinion from a registered patent attorney is the only reliable check.
