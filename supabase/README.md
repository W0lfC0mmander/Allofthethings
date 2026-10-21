# Online approvals: one-time setup

"Send for approval" (a report's ⋮ menu) emails the customer a link to `approve.html`. On that page they read the proposal, sign it by typing or drawing, and approve it or decline it. The signed PDF then has their signature, the date and their name in the approval block, and a **signature certificate** page at the end showing who signed, when, from what IP address and device, and a fingerprint of the original PDF. The customer and you both get the signed copy by email, and it appears on the report in the app and in backups.

The app's Supabase address and public key are in `js/config.js`. Do these steps once in the Supabase dashboard:

## 1. Create the table and storage
**SQL Editor → New query**: paste all of [`schema.sql`](schema.sql) and tap **Run**. You should see "Success. No rows returned".

## 2. Make your sign-in
1. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up", then Save. Only accounts you add yourself can send emails.
2. **Authentication → Users → Add user → Create new user**: enter your email and a password, and tick **Auto Confirm User**.

## 3. Add the server function
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `approvals`.
3. Replace the sample code with all of [`functions/approvals/index.ts`](functions/approvals/index.ts), then tap **Deploy function**.
4. Open the function's **Details** (or Settings) and turn **off** "Verify JWT" (it may be called "Enforce JWT verification"), then save. Customers don't sign in, so the function checks your sign-in itself.

## 4. Connect email (Resend)
1. In Resend: **API Keys → Create API key** (Sending access), and copy it.
2. In Supabase: **Edge Functions → Secrets** (Manage secrets) and add:
   - `RESEND_API_KEY`: the key you copied.
   - `ALLOWED_EMAILS` (optional, recommended): your sign-in email. Only this account can send.

Until you verify a domain, Resend only delivers to the email address you signed up to Resend with. So for the first test, send a report to yourself.

When you're ready for customers: in Resend, go to **Domains → Add domain** and add the DNS records it shows at your domain host. Then add the secret `RESEND_FROM` set to something like `Acme Irrigation <approvals@zonesenseirrigation.com>`.

## 5. Sign in from the app
Go to **Settings → Online approvals** and sign in with the email and password from step 2. Then open a report, tap ⋮ and choose **Send for approval**.

## How it works
- `approvals` handles every request, using an `action` field: `send`, `status` and `cancel` from the app (signed in), and `view`, `sign` and `decline` from the customer's page. The customer's page has no sign-in: the random token in the emailed link is what lets them in.
- The `approvals` table has row level security turned on and no policies, so only the function, using the service key, can read or write it.
- Files go in the private `approvals` storage bucket under `<user id>/<approval id>/`: `proposal.pdf`, `logo`, `signature.png` and `signed.pdf`. People only reach them through links that expire.
- The report keeps `report.approval` (status, who, when) and `report.approvalPdf` (the signed copy). The app checks for an answer when you open the report, and when you tap the approval card.
