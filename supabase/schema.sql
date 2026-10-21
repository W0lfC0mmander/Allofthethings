-- Zone Sense's database: run this in Supabase (SQL Editor > New query > paste > Run).
-- It's safe to run again: it only adds what's missing, so run it after every update to it.
--
-- Online approvals
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

-- Companies and their teams. Zone Sense is invitation only: a Zone Sense admin adds a company
-- and its owner, and the owner invites their techs. Each person belongs to one company. Like
-- approvals, only the Edge Function reads or writes these tables.
create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  reply_to text,                          -- where customers' replies go; empty means the sender
  -- For billing later (Stripe). Everyone starts on the free beta.
  plan text not null default 'free beta',
  status text not null default 'active' check (status in ('active', 'past_due', 'paused', 'cancelled')),
  stripe_customer_id text,
  stripe_subscription_id text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.companies enable row level security;

create table if not exists public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'tech' check (role in ('owner', 'tech')),
  status text not null default 'invited' check (status in ('invited', 'active')),
  invited_by uuid references auth.users (id) on delete set null,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  reset_sent_at timestamptz
);
create index if not exists members_company on public.members (company_id);
alter table public.members enable row level security;

alter table public.approvals add column if not exists company_id uuid references public.companies (id) on delete set null;
alter table public.approvals add column if not exists reply_to text;
create index if not exists approvals_company on public.approvals (company_id);

-- Lets the function find an account by email. Only the function (service role) may call it.
create or replace function public.user_id_for_email(e text) returns uuid
language sql stable security definer set search_path = ''
as $$ select id from auth.users where lower(email) = lower(e) limit 1 $$;
revoke all on function public.user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.user_id_for_email(text) to service_role;
