# Zone Sense on Supabase: setup

Supabase holds Zone Sense's accounts (companies, owners and techs) and online approvals. Reports and photos still live only on each phone.

The app needs a sign-in. It's **invitation only**: nobody can sign up. A Zone Sense admin (anyone listed in the `ADMIN_EMAILS` secret) adds a company and its owner from **Settings → Account and team**, and the owner invites their techs there. Each invite is an email with a link that opens the app to choose a password. Once signed in, a phone stays signed in and works offline; it checks with the server whenever it has a connection, so someone removed from a team is signed out the next time they're online.

## Online approvals

"Send for approval" (a report's ⋮ menu) emails the customer a link to `approve.html`. On that page they read the proposal, sign it by typing or drawing, and approve it or decline it. The signed PDF then has their signature, the date and their name in the approval block, and a **signature certificate** page at the end showing who signed, when, from what IP address and device, and a fingerprint of the original PDF. The customer and you both get the signed copy by email, and it appears on the report in the app and in backups.

The app's Supabase address and public key are in `js/config.js`. Do these steps once in the Supabase dashboard:

## 1. Create the tables and storage
**SQL Editor → New query**: paste all of [`schema.sql`](schema.sql) and tap **Run**. You should see "Success. No rows returned". It's safe to run again, and it needs running again whenever it changes.

## 2. Make your sign-in
1. **Authentication → Sign In / Providers**: turn **off** "Allow new users to sign up", then Save. Accounts are only made through invites.
2. **Authentication → Sign In / Providers → Email**: set **Email OTP Expiration** to `86400` (24 hours), so invite and password links last a day.
3. **Authentication → Users → Add user → Create new user**: enter your email and a password, and tick **Auto Confirm User**. This is the one account made by hand; everyone else is invited.

## 3. Add the server function
1. **Edge Functions → Deploy a new function → Via Editor**.
2. Name it exactly `approvals`.
3. Replace the sample code with all of [`functions/approvals/index.ts`](functions/approvals/index.ts), then tap **Deploy function**.
4. Open the function's **Details** (or Settings) and turn **off** "Verify JWT" (it may be called "Enforce JWT verification"), then save. Customers don't sign in, so the function checks your sign-in itself.

## 4. Connect email (Resend)
1. In Resend: **API Keys → Create API key** (Sending access), and copy it.
2. In Supabase: **Edge Functions → Secrets** (Manage secrets) and add:
   - `RESEND_API_KEY`: the key you copied.
   - `ADMIN_EMAILS`: your sign-in email (comma separated for more than one). Zone Sense admins can add companies.
   - `APP_URL` (optional): where invite links open. Defaults to the address in `APPROVE_URL` without `approve.html`, which is `https://app.zonesenseirrigation.com/`.

Until you verify a domain, Resend only delivers to the email address you signed up to Resend with. So for the first test, send a report to yourself.

When you're ready for customers: in Resend, go to **Domains → Add domain** and add the DNS records it shows at your domain host. Then add the secret `RESEND_FROM` set to `Zone Sense <approvals@zonesenseirrigation.com>`. Emails to customers show each company's own name ("Acme Irrigation via Zone Sense") and replies go to the sender's sign-in email.

## 5. Sign in from the app
Open the app and sign in with the email and password from step 2. As an admin without a company, it asks for your company's name and makes you its owner. Then invite techs from **Settings → Account and team**, and send a report for approval from its ⋮ menu.

## How it works
- `approvals` handles every request, using an `action` field: `send`, `status` and `cancel` from the app (signed in), `view`, `sign` and `decline` from the customer's page, and `me`, `team`, `invite`, `remove_member`, `update_company`, `companies`, `create_company` and `reset` for accounts.
- Accounts: `companies` (name, reply-to, plan `free beta`, status and Stripe ids for billing later) and `members` (one company per person, role `owner` or `tech`). Invite and password emails are sent through Resend from the function, with links the app trades for a sign-in, so Supabase's own email settings aren't used.
- Approval emails use the company's name and reply-to address from the database (falling back to the sender's email), never what's typed on a phone, and each person only sees the proposals they sent. It also takes `bug` (Settings → **Report a bug**, no sign-in needed), which emails the report to `djimenez@zonesenseirrigation.com`; set the secret `BUG_REPORT_EMAIL` to send them somewhere else. The customer's page has no sign-in: the random token in the emailed link is what lets them in.
- The `approvals` table has row level security turned on and no policies, so only the function, using the service key, can read or write it.
- Files go in the private `approvals` storage bucket under `<user id>/<approval id>/`: `proposal.pdf`, `logo`, `signature.png` and `signed.pdf`. People only reach them through links that expire.
- The report keeps `report.approval` (status, who, when) and `report.approvalPdf` (the signed copy). The app checks for an answer when you open the report, and when you tap the approval card.
