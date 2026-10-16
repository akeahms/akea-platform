# Bank feeds: Plaid and Finicity

Once a hotel bank account is connected, its transactions arrive in **Finance → Banking** without anyone uploading anything:

- **When:** the moment the bank reports new activity (through a webhook), plus every night at 5:30 AM Central.
- **Matching:** new transactions are matched automatically to the night-audit deposits, card batches, Amex (net of fees) and bill payments.
- **Corrections:** if the bank corrects or withdraws a transaction, the portal follows. This only applies to transactions nobody has reconciled yet.
- **Balances:** each sync updates the account balance.
- **Expired sign-ins:** if a bank login expires or its password changes, the account shows **Sign in to the bank again** with a **Reconnect** button.

Bank access tokens are kept on the server only, in a table no portal user can read.

## 1. Get keys

| Provider | Where | What you need |
| --- | --- | --- |
| **Plaid** (most US banks) | dashboard.plaid.com → Developers → Keys | Client ID, plus the Sandbox secret (testing) or the Production secret (live) |
| **Finicity / Mastercard Open Banking** (banks Plaid misses) | developer.mastercard.com → Open Banking → your project | Partner ID, Partner Secret, App Key |

Going live:

- **Plaid Production:** complete Plaid's production application (company profile and security questionnaire) and enable the **Transactions** product.
- **Finicity Production:** Mastercard approves the app and turns on production access.

## 2. Add the keys to Supabase

In Supabase, go to **Project → Edge Functions → Secrets** and add:

| Name | Value |
| --- | --- |
| `PLAID_CLIENT_ID` | your Plaid client ID |
| `PLAID_SECRET` | the Sandbox or Production secret |
| `PLAID_ENV` | `sandbox` while testing, `production` when live |
| `FINICITY_PARTNER_ID` | Partner ID |
| `FINICITY_SECRET` | Partner Secret |
| `FINICITY_APP_KEY` | App Key |
| `FINICITY_ENV` | `test` while testing, `production` when live |

You can add Plaid only, Finicity only, or both. The portal shows a button for each provider that has keys. No redeploy is needed.

## 3. Connect an account

1. Go to **Finance → Banking** and choose the account. Add it first with **Add bank account** if it isn't there.
2. In the **Bank feed** card, choose **Connect with Plaid** or **Connect with Finicity**. This needs finance approval rights.
3. Sign in to the bank in the window that opens and pick the account.
4. The first sync pulls up to 2 years of history (Plaid) or 6 months (Finicity) and matches it.

**Test mode:**

- **Plaid sandbox:** pick any bank and sign in with `user_good` / `pass_good`.
- **Finicity test mode:** use the "FinBank" test institution with `profile_02` / `profile_02`.

## Day to day

- **Sync now:** pulls immediately. Finance edit rights.
- **Change account:** use this if the bank shared several accounts and the wrong one was linked. Past transactions are pulled again; duplicates are skipped.
- **Reconnect:** shown when the bank needs a new sign-in.
- **Disconnect:** revokes the bank access. Transactions already imported stay.

## How it's wired

| Piece | Where |
| --- | --- |
| Server function | `supabase/functions/bank-feeds`. Portal actions, the Plaid webhook (`?hook=plaid`, checked with Plaid's signed JWT), the Finicity webhook (`?hook=finicity&token=…`) and the nightly job (`?action=sync_all`). |
| Webhook URLs | Sent to Plaid and Finicity automatically with each connection. There's nothing to paste into their dashboards. |
| Nightly job | `cron.job` named `akea-bank-sync`, 10:30 UTC. Its shared secret is `app_config.bank_webhook_token`, which lives in the database and never in git. |
| Tables | `bank_connections` (server only); `bank_feed_status()` returns the safe status the portal shows. |
| Tests | Normalizers, paging, restart-on-change, corrections, expired logins and webhook-signature checks are covered by a local test with simulated Plaid and Finicity APIs. |
