-- 0062_unlock_saves_pipeline.sql
-- F05b (D108). Do not edit 0057. 0061 is left for F01.
--
-- A successful contact unlock writes the caller's pipeline row in the same
-- transaction as the debit. A refused unlock writes nothing. The Free
-- open-relationship allowance is the existing save_hotel_to_pipeline rule.
-- The number below is FREE_LIMITS.savedHotels. Authenticated callers cannot
-- supply it. A pipeline item does not require a trip (D095).

create or replace function public.unlock_hotel_contact(
  p_hotel_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  -- D042. tests/credits/config.test.ts fails if this drifts from FREE_LIMITS.savedHotels.
  v_free_saved_hotels constant integer := 10;
  v_cost integer;
  v_charge boolean;
  v_ttl integer;
  v_balance integer;
  v_cache public.contact_cache%rowtype;
  v_has_cache boolean;
  v_servable boolean;
  v_ledger_id uuid;
  v_email text;
  v_save jsonb;
  v_preview text;
  v_pipeline_added boolean := false;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_hotel_id is null
     or p_idempotency_key is null
     or char_length(btrim(p_idempotency_key)) < 1
     or char_length(p_idempotency_key) > 200 then
    raise exception 'hotel and idempotency key are required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.credit_unlock'),
    pg_catalog.hashtext(v_uid::text)
  );

  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return jsonb_build_object('status', 'hotel_missing', 'email', null, 'pipeline_added', false);
  end if;

  select unlock_cost, charge_on_not_found, cache_ttl_days
    into v_cost, v_charge, v_ttl
  from public.credit_config
  where id;

  if v_cost is null or v_ttl is null or v_charge is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  -- cache_ttl_days stays required config. It does not expire a stored address.
  select * into v_cache from public.contact_cache where hotel_id = p_hotel_id;
  v_has_cache := found;
  v_servable := v_has_cache
    and v_cache.status = 'found'
    and not v_cache.reported_invalid
    and nullif(btrim(coalesce(v_cache.email, '')), '') is not null;

  if exists (
    select 1 from public.contact_unlocks u
    where u.user_id = v_uid and u.hotel_id = p_hotel_id
  ) then
    -- A repeat open does not debit. If the bug left no pipeline row at all,
    -- add one. A closed cycle is a record and is not reopened here.
    if v_servable and not exists (
      select 1
        from public.pipeline_items pi
        join public.creator_profiles cp on cp.id = pi.creator_id
       where cp.user_id = v_uid
         and pi.hotel_id = p_hotel_id
    ) then
      v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
      v_pipeline_added := v_save->>'result' = 'created';
    end if;
    if v_servable then
      return jsonb_build_object(
        'status', 'already_unlocked',
        'email', v_cache.email,
        'balance', public.credit_balance(v_uid),
        'pipeline_added', v_pipeline_added
      );
    end if;
    return jsonb_build_object(
      'status', 'already_unlocked',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if exists (
    select 1 from public.credit_ledger l
    where l.user_id = v_uid and l.idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object('status', 'idempotent_replay', 'email', null, 'pipeline_added', false);
  end if;

  -- Probe the allowance before any contact status is returned. A full Free
  -- pipeline is the same answer for every hotel, so it cannot be used to
  -- learn which hotels have an email. A created row is rolled back: not_found,
  -- needs_provider, and insufficient credits must not keep it.
  v_preview := null;
  begin
    v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
    v_preview := v_save->>'result';
    if v_preview = 'created' then
      raise exception 'unlock pipeline preview' using errcode = 'P0001';
    end if;
  exception
    when sqlstate 'P0001' then
      v_preview := 'would_create';
  end;

  if v_preview = 'limit_reached' then
    return jsonb_build_object(
      'status', 'pipeline_limit',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false,
      'limit', v_free_saved_hotels
    );
  end if;

  if v_preview is null or v_preview not in ('would_create', 'already_saved') then
    return jsonb_build_object('status', 'error', 'email', null, 'pipeline_added', false);
  end if;

  if not v_has_cache then
    return jsonb_build_object(
      'status', 'needs_provider',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'invalid' or v_cache.reported_invalid then
    return jsonb_build_object(
      'status', 'not_found',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'not_found' and not v_charge then
    return jsonb_build_object(
      'status', 'not_found',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'found' and not v_servable then
    return jsonb_build_object(
      'status', 'needs_provider',
      'email', null,
      'pipeline_added', false
    );
  end if;

  v_balance := public.credit_balance(v_uid);
  if v_balance < v_cost then
    return jsonb_build_object(
      'status', 'insufficient_credits',
      'email', null,
      'balance', v_balance,
      'pipeline_added', false
    );
  end if;

  if v_servable then
    v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
    v_preview := v_save->>'result';
    if v_preview = 'limit_reached' then
      return jsonb_build_object(
        'status', 'pipeline_limit',
        'email', null,
        'balance', v_balance,
        'pipeline_added', false,
        'limit', v_free_saved_hotels
      );
    end if;
    if v_preview is null or v_preview not in ('created', 'already_saved') then
      return jsonb_build_object('status', 'error', 'email', null, 'pipeline_added', false);
    end if;
    v_pipeline_added := v_preview = 'created';
  end if;

  insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
  values (v_uid, -v_cost, 'unlock', p_hotel_id::text, p_idempotency_key)
  returning id into v_ledger_id;

  insert into public.contact_unlocks (user_id, hotel_id, ledger_id)
  values (v_uid, p_hotel_id, v_ledger_id);

  update public.contact_cache
     set first_unlocked_at = coalesce(first_unlocked_at, pg_catalog.now())
   where hotel_id = p_hotel_id
     and first_unlocked_at is null;

  v_email := case when v_cache.status = 'found' then v_cache.email else null end;

  return jsonb_build_object(
    'status', case when v_email is null then 'not_found' else 'unlocked' end,
    'email', v_email,
    'balance', v_balance - v_cost,
    'pipeline_added', case when v_email is null then false else v_pipeline_added end
  );
end;
$$;

comment on function public.unlock_hotel_contact(uuid, text) is
  'Atomic per-user unlock. A revealed email also saves the hotel on the caller pipeline in the same transaction, or refuses with no debit when the Free allowance is full (D108). Already owned costs nothing. A stored found email is a hit at any age. A missing cache row returns needs_provider and does not debit. An invalid cache returns no email and does not debit a new user.';

revoke all on function public.unlock_hotel_contact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.unlock_hotel_contact(uuid, text) to authenticated, service_role;

-- Emails for pipeline cards. Only hotels this caller unlocked, or staff.
-- Another user's unlock is not a row. No raw provider payload.

create or replace function public.read_own_unlocked_contacts(p_hotel_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('hotel_id', c.hotel_id, 'email', c.email)
      order by c.hotel_id
    ),
    '[]'::jsonb
  )
  from public.contact_cache c
  where p_hotel_ids is not null
    and c.hotel_id = any (p_hotel_ids)
    and c.status = 'found'
    and not c.reported_invalid
    and nullif(btrim(coalesce(c.email, '')), '') is not null
    and (
      public.is_admin_or_editor()
      or exists (
        select 1
          from public.contact_unlocks u
         where u.user_id = auth.uid()
           and u.hotel_id = c.hotel_id
      )
    );
$$;

comment on function public.read_own_unlocked_contacts(uuid[]) is
  'Cache emails for hotels this user unlocked, or for admin/editor. Other users'' unlocks are absent. No raw provider payload.';

revoke all on function public.read_own_unlocked_contacts(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.read_own_unlocked_contacts(uuid[]) to authenticated, service_role;
