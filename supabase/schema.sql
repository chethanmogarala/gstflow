-- GSTFlow MVP schema for Supabase (Postgres).
-- Run once in the Supabase dashboard: SQL Editor > New query > paste > Run.
-- Every table carries firm_id, and row-level security limits each user to the firms they belong to.

create extension if not exists pgcrypto;

-- ---------- firms and people ----------

create table public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table public.firm_members (
  firm_id uuid not null references public.firms on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now(),
  primary key (firm_id, user_id)
);

create table public.firm_invites (
  firm_id uuid not null references public.firms on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  created_at timestamptz not null default now(),
  primary key (firm_id, email)
);

create or replace function public.is_member(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.firm_members where firm_id = f and user_id = auth.uid());
$$;

create or replace function public.is_admin(f uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.firm_members where firm_id = f and user_id = auth.uid() and role = 'admin');
$$;

-- Creates a firm and makes the caller its admin.
create or replace function public.create_firm(firm_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  insert into public.firms (name) values (firm_name) returning id into new_id;
  insert into public.firm_members (firm_id, user_id, email, role)
    values (new_id, auth.uid(), coalesce(auth.jwt() ->> 'email', ''), 'admin');
  return new_id;
end;
$$;

-- Turns any invites for the caller's email into memberships.
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare my_email text := lower(coalesce(auth.jwt() ->> 'email', '')); n integer;
begin
  if auth.uid() is null or my_email = '' then return 0; end if;
  insert into public.firm_members (firm_id, user_id, email, role)
    select firm_id, auth.uid(), my_email, role from public.firm_invites where lower(email) = my_email
    on conflict do nothing;
  get diagnostics n = row_count;
  delete from public.firm_invites where lower(email) = my_email;
  return n;
end;
$$;

-- ---------- clients and periods ----------

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms on delete cascade,
  name text not null,
  gstin text not null,
  mode text not null default 'register' check (mode in ('register', '2b_first')),
  column_map jsonb,
  created_at timestamptz not null default now(),
  unique (firm_id, gstin)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms on delete cascade,
  client_id uuid not null references public.clients on delete cascade,
  gstin text not null,
  name text,
  registration_status text not null default 'Active',
  cancelled_on date,
  category text,
  unique (client_id, gstin)
);

create table public.periods (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms on delete cascade,
  client_id uuid not null references public.clients on delete cascade,
  period text not null check (period ~ '^(0[1-9]|1[0-2])[0-9]{4}$'),
  status text not null default 'draft' check (status in ('draft', 'in_review', 'final')),
  register_file text,
  b2b_file text,
  run_at timestamptz,
  summary jsonb,
  created_at timestamptz not null default now(),
  unique (client_id, period)
);

-- Every register row and every GSTR-2B record, as imported.
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms on delete cascade,
  period_id uuid not null references public.periods on delete cascade,
  side text not null check (side in ('register', '2b')),
  source text not null check (source in ('register', 'carry_forward', '2b', 'manual')),
  line integer,
  supplier text,
  gstin text not null,
  invoice text not null,
  inv_date date,
  taxable numeric(14, 2) not null default 0,
  igst numeric(14, 2) not null default 0,
  cgst numeric(14, 2) not null default 0,
  sgst numeric(14, 2) not null default 0,
  rcm boolean not null default false,
  ledger text
);
create index on public.documents (period_id);

-- One row per reconciliation outcome, with the reviewer's decision.
create table public.results (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms on delete cascade,
  period_id uuid not null references public.periods on delete cascade,
  reg_doc uuid references public.documents on delete cascade,
  b2b_doc uuid references public.documents on delete cascade,
  status text not null check (status in ('matched', 'probable', 'only_in_register', 'only_in_2b')),
  rule text not null,
  reason text not null,
  risks jsonb not null default '[]',
  ims_suggested text,
  ims_why text,
  ims_final text,
  mark text check (mark in ('have', 'ask', 'not')),
  decision text,
  note text,
  decided_by text,
  decided_at timestamptz
);
create index on public.results (period_id);

create table public.audit_log (
  id bigserial primary key,
  firm_id uuid not null references public.firms on delete cascade,
  client_id uuid references public.clients on delete cascade,
  period_id uuid references public.periods on delete cascade,
  user_id uuid default auth.uid(),
  user_email text,
  action text not null,
  detail text,
  at timestamptz not null default now()
);
create index on public.audit_log (period_id);

-- ---------- row-level security ----------

alter table public.firms enable row level security;
alter table public.firm_members enable row level security;
alter table public.firm_invites enable row level security;
alter table public.clients enable row level security;
alter table public.suppliers enable row level security;
alter table public.periods enable row level security;
alter table public.documents enable row level security;
alter table public.results enable row level security;
alter table public.audit_log enable row level security;

create policy "members read their firm" on public.firms for select using (public.is_member(id));
create policy "admins rename their firm" on public.firms for update using (public.is_admin(id));

create policy "members see colleagues" on public.firm_members for select using (public.is_member(firm_id));
create policy "admins remove members" on public.firm_members for delete using (public.is_admin(firm_id) and user_id <> auth.uid());

create policy "admins manage invites" on public.firm_invites for all
  using (public.is_admin(firm_id)) with check (public.is_admin(firm_id));

create policy "members manage clients" on public.clients for all
  using (public.is_member(firm_id)) with check (public.is_member(firm_id));
create policy "members manage suppliers" on public.suppliers for all
  using (public.is_member(firm_id)) with check (public.is_member(firm_id));
create policy "members manage periods" on public.periods for all
  using (public.is_member(firm_id)) with check (public.is_member(firm_id));
create policy "members manage documents" on public.documents for all
  using (public.is_member(firm_id)) with check (public.is_member(firm_id));
create policy "members manage results" on public.results for all
  using (public.is_member(firm_id)) with check (public.is_member(firm_id));

-- The audit trail can be added to and read, never edited or deleted.
create policy "members read audit" on public.audit_log for select using (public.is_member(firm_id));
create policy "members add audit" on public.audit_log for insert with check (public.is_member(firm_id) and user_id = auth.uid());

grant execute on function public.create_firm(text) to authenticated;
grant execute on function public.accept_invites() to authenticated;
