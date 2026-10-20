-- Online approvals: run this once in Supabase (SQL Editor > New query > paste > Run).
-- Each row is one proposal sent to a customer to sign. Only the "approvals" Edge Function
-- reads or writes it (with the service role key), so row level security is on with no
-- policies: the app and the customer page can't touch the table directly.

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,            -- the secret in the customer's link
  owner uuid not null references auth.users (id) on delete cascade,
  owner_email text not null,
  status text not null default 'sent' check (status in ('sent', 'approved', 'declined', 'cancelled')),

  company_name text,
  accent text,
  logo_path text,
  property text,
  report_name text,
  report_date text,
  customer_name text,
  customer_email text not null,
  message text,
  estimate jsonb,                         -- { lines: [{ issue, qty, amount }], subtotal, discount, discountLabel, total, unpriced, itemized }

  pdf_path text not null,
  pdf_name text,
  pdf_sha256 text not null,
  signed_pdf_path text,

  sent_at timestamptz not null default now(),
  viewed_at timestamptz,
  decided_at timestamptz,
  signer_name text,
  signature_method text,                  -- 'typed' or 'drawn'
  signature_path text,
  signer_ip text,
  signer_agent text,
  decline_reason text
);

create index if not exists approvals_owner on public.approvals (owner);
alter table public.approvals enable row level security;

-- Proposal PDFs, signatures and signed copies. Private: files are only reached through
-- short-lived links the Edge Function hands out.
insert into storage.buckets (id, name, public)
values ('approvals', 'approvals', false)
on conflict (id) do nothing;
