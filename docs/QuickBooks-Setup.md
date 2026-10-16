# QuickBooks Online

Each hotel connects to its own QuickBooks Online company. Every morning at 6:45 AM Central, after the night audits and bank feeds have come in, Akea sends four kinds of entries:

| What | In QuickBooks |
| --- | --- |
| **Night audit revenue** | One journal entry per day (document number `NA-YYYYMMDD`).<br>Credits: room, F&B and other revenue, and tax collected.<br>Debits: card payments (card clearing), cash, and direct bill (receivable).<br>The difference goes to the guest ledger. |
| **Approved bills** | A Bill on the mapped expense account. The vendor is found by name or created. |
| **Bill payments** | A Bill Payment linked to that bill, paid from the mapped bank account. |
| **Manual journal entries** | A Journal Entry with the same lines. |

How sending works:

- **Never twice.** Each item is recorded once it has been sent, and every request carries an idempotency key, so a retry can't create a duplicate.
- **Nothing before your start date.** You set the date the first sync starts from.
- **Failures retry.** Items that fail, or that are waiting for an account mapping, are tried again on every sync.
- **Edits after sending aren't re-sent.** If you change something in Akea after it reached QuickBooks, correct it in QuickBooks too.

## 1. Create the Intuit app (one time)

1. At developer.intuit.com, create an app with the **QuickBooks Online and Payments** platform and the **Accounting** scope.
2. Under **Keys & credentials**, add this **Redirect URI**, in both Development and Production:
   `https://rqyvjloptxdfojaxjirq.supabase.co/functions/v1/quickbooks/callback`
3. Copy the Client ID and Client Secret.
   - **Testing:** use the Development keys with a sandbox company.
   - **Live:** complete Intuit's production questionnaire to get Production keys.

## 2. Add the keys to Supabase

Go to **Project → Edge Functions → Secrets**:

| Name | Value |
| --- | --- |
| `QBO_CLIENT_ID` | Client ID |
| `QBO_CLIENT_SECRET` | Client Secret |
| `QBO_ENV` | `sandbox` while testing, `production` when live |

## 3. Connect each hotel

1. Go to **Finance → Accounting → QuickBooks** and pick the hotel.
2. Click **Connect to QuickBooks** and sign in to Intuit. This needs finance approval rights.
3. Choose the hotel's company.
4. **Account mapping:** press **Auto-match**, then fill in anything left. Starred accounts are used by the nightly revenue journal and must be mapped.
5. **What gets sent:** set **Send activity from** to the day after your last closed month in QuickBooks.
6. Press **Sync now**, or wait for the morning run.

## Day to day

- **Sync log:** shows what reached QuickBooks. "Map accounts" means an Akea account has no QuickBooks account yet; map it and the item goes out on the next sync.
- **Reconnect:** appears if the connection is removed on the QuickBooks side or expires (100 days without use).
- **Disconnect:** revokes Akea's access. Everything already sent stays in QuickBooks, and the mapping is kept.

## How it's wired

| Piece | Where |
| --- | --- |
| Server function | `supabase/functions/quickbooks`: sign-in redirect (`/callback`), portal actions, and the nightly run (`?action=sync_all`). |
| Tables | `qbo_connections` (tokens, server only), `qbo_settings`, `qbo_accounts`, `qbo_account_map`, `qbo_vendor_map`, `qbo_sync_log`. |
| Nightly job | `cron.job` named `akea-qbo-sync`, 11:45 UTC. Its secret is `app_config.qbo_job_token`. |
| Tests | The revenue journal (checked against the Hampton Cleburne 10/14/2026 audit), mapping, auto-match, token refresh, vendor creation, bill → payment ordering and expired connections, all with a simulated Intuit API. |
