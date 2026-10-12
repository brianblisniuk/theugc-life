-- ===========================================================================
-- 0045 — B07.1: commercial-meaning follow-ups
-- ===========================================================================
-- D072 / D074. Next free migration number on main
-- 161e4c0d7694b3e12b3b496c1393037b2d0e57a5. Does not edit 0044.
--
-- 1. agreement_observed is rejected unless the STORED eligible body is an
--    explicit booking confirmation. A caller-supplied
--    explicit_booking_confirmation flag is not evidence. A one-sided accept
--    stays negotiating.
-- 2. Creator reads mark the machine interpretation stale when the B06
--    classification/chronology fingerprint the attempt was bound to no longer
--    matches the live observation. Human decisions are not rewritten.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Clean text used only to test the booking-confirmation bar. It follows the
-- same plain/HTML preference, quote cut, and valediction split as
-- src/lib/gmail/outreach/text-transform.ts. It is not a second source of
-- stored text; B04 text parts remain the evidence.
-- ---------------------------------------------------------------------------
create or replace function private.gmail_commercial_classifier_clean_text(
  p_text text,
  p_is_html boolean
)
returns text
language plpgsql
immutable
set search_path = public, private, pg_temp
as $clean$
declare
  v_source text;
  v_lines text[];
  v_cut integer;
  i integer;
  n integer;
  v_kept text;
  v_after text;
  v_line text;
begin
  if p_text is null then
    return null;
  end if;

  v_source := p_text;
  if p_is_html then
    v_source := regexp_replace(v_source, '<blockquote\M.*', '', 'i');
    v_source := regexp_replace(v_source, '<style.*?</style>', ' ', 'gi');
    v_source := regexp_replace(v_source, '<script.*?</script>', ' ', 'gi');
    v_source := regexp_replace(v_source, '<br\s*/?>', E'\n', 'gi');
    v_source := regexp_replace(v_source, '</(p|div|tr|li|table|h[1-6])\s*>', E'\n', 'gi');
    v_source := regexp_replace(v_source, '<[^>]+>', ' ', 'g');
    v_source := replace(v_source, '&nbsp;', ' ');
    v_source := replace(v_source, '&amp;', '&');
    v_source := replace(v_source, '&lt;', '<');
    v_source := replace(v_source, '&gt;', '>');
    v_source := regexp_replace(v_source, '[ \t]+', ' ', 'g');
    v_lines := regexp_split_to_array(v_source, E'\n');
    for i in 1..coalesce(array_length(v_lines, 1), 0) loop
      v_lines[i] := btrim(v_lines[i]);
    end loop;
    v_source := btrim(regexp_replace(array_to_string(v_lines, E'\n'), E'\n{3,}', E'\n\n', 'g'));
  end if;

  v_lines := regexp_split_to_array(v_source, E'\r?\n');
  n := coalesce(array_length(v_lines, 1), 0);
  v_cut := null;
  for i in 1..n loop
    v_line := v_lines[i];
    if v_line ~ '^-- ?$'
       or v_line ~* '^\s*On\s.+\swrote:\s*$'
       or v_line ~* '^\s*-{2,}\s*Original Message\s*-{2,}\s*$'
       or v_line ~* '^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$'
       or v_line ~* '^\s*From:\s.+$'
       or v_line ~ '^\s*>'
    then
      v_cut := i;
      exit;
    end if;
  end loop;

  if v_cut is null then
    v_kept := btrim(v_source);
  elsif v_cut = 1 then
    v_kept := '';
  else
    v_kept := btrim(array_to_string(v_lines[1:v_cut - 1], E'\n'));
  end if;

  v_lines := regexp_split_to_array(v_kept, E'\r?\n');
  n := coalesce(array_length(v_lines, 1), 0);
  v_cut := null;
  for i in 1..n loop
    if v_lines[i] ~* '^\s*(thanks( so much| a lot| in advance)?|thank you|best( regards| wishes)?|kind regards|warm(ly)?( regards)?|regards|sincerely|cheers|talk soon|looking forward( to hearing from you)?)[,!.]?\s*$' then
      if i = n then
        v_after := '';
      else
        v_after := btrim(array_to_string(v_lines[i + 1:n], E'\n'));
      end if;
      if v_after <> '' then
        v_cut := i;
        exit;
      end if;
    end if;
  end loop;

  if v_cut is null then
    return nullif(v_kept, '');
  elsif v_cut = 1 then
    return null;
  end if;
  return nullif(btrim(array_to_string(v_lines[1:v_cut - 1], E'\n')), '');
end;
$clean$;

create or replace function private.gmail_commercial_text_is_explicit_booking(p_clean text)
returns boolean
language sql
immutable
set search_path = public, private, pg_temp
as $booking$
  -- Same phrases as BOOKING_CONFIRMATION in src/lib/gmail/commercial/rules.ts.
  -- "Confirmed" alone does not match. Acceptance language ("we accept") does not match.
  select p_clean is not null
     and lower(regexp_replace(p_clean, '\s+', ' ', 'g')) ~ (
       '\yyour stay is confirmed\y|\ystay is confirmed for\y|\yreservation is confirmed\y|\yyou''?re booked\y'
     );
$booking$;

create or replace function private.gmail_commercial_stored_text_is_explicit_booking(
  p_mail_account_id uuid,
  p_provider_message_id text
)
returns boolean
language sql
stable
set search_path = public, private, pg_temp
as $stored$
  with parts as (
    select tp.mime_type, tp.decoded_text, tp.part_path
      from private.gmail_normalized_messages m
      join private.gmail_normalized_text_parts tp on tp.normalized_message_id = m.id
     where m.mail_account_id = p_mail_account_id
       and m.provider_message_id = p_provider_message_id
       and tp.decode_status in ('decoded', 'empty_decoded')
       and tp.decoded_text is not null
  ),
  chosen as (
    select mime_type, decoded_text
      from parts
     where mime_type = 'text/plain'
     order by part_path
     limit 1
  ),
  fallback as (
    select mime_type, decoded_text
      from parts
     where mime_type = 'text/html'
       and not exists (select 1 from chosen)
     order by part_path
     limit 1
  ),
  body as (
    select mime_type, decoded_text from chosen
    union all
    select mime_type, decoded_text from fallback
  )
  select coalesce(
    private.gmail_commercial_text_is_explicit_booking(
      private.gmail_commercial_classifier_clean_text(
        (select decoded_text from body),
        coalesce((select mime_type = 'text/html' from body), false)
      )
    ),
    false
  );
$stored$;

-- The fingerprint the attempt was bound to: B06 class, classification version,
-- relation (chronology) version, text-transform version, observation identity,
-- and whether that observation is still current.
create or replace function private.gmail_commercial_b06_fingerprint_drifted(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns boolean
language sql
stable
set search_path = public, private, pg_temp
as $drift$
  select exists (
    select 1
      from private.gmail_commercial_message_current mc
      join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
      left join private.gmail_reply_message_observations o
        on o.mail_account_id = ma.mail_account_id
       and o.provider_message_id = ma.provider_message_id
     where mc.mail_account_id = p_mail_account_id
       and mc.provider_thread_id = p_provider_thread_id
       and (
         o.id is distinct from ma.b06_observation_id
         or o.response_class is distinct from ma.b06_response_class
         or o.classification_rule_version is distinct from ma.b06_classification_rule_version
         or o.relation_rule_version is distinct from ma.b06_relation_rule_version
         or o.text_transform_version is distinct from ma.b06_text_transform_version
         or (
           ma.b06_observation_id is not null
           and ma.current_normalized_message_id is not null
           and coalesce(o.current_normalized_message_id is not null, false) = false
         )
       )
  );
$drift$;

create or replace function private.gmail_commercial_mark_b06_fingerprint_stale(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns void
language plpgsql
set search_path = public, private, pg_temp
as $mark$
declare
  v_prev text;
begin
  v_prev := current_setting('b07.machine_writer', true);
  perform set_config('b07.machine_writer', 'on', true);

  update private.gmail_commercial_message_current mc
     set stale = true,
         stale_reason = 'b06_fingerprint',
         updated_at = now()
   where mc.mail_account_id = p_mail_account_id
     and (p_provider_thread_id is null or mc.provider_thread_id = p_provider_thread_id)
     and not mc.stale
     and private.gmail_commercial_b06_fingerprint_drifted(mc.mail_account_id, mc.provider_thread_id);

  update private.gmail_commercial_thread_current tc
     set stale = true,
         stale_reason = 'b06_fingerprint',
         updated_at = now()
   where tc.mail_account_id = p_mail_account_id
     and (p_provider_thread_id is null or tc.provider_thread_id = p_provider_thread_id)
     and not tc.stale
     and private.gmail_commercial_b06_fingerprint_drifted(tc.mail_account_id, tc.provider_thread_id);

  perform set_config('b07.machine_writer', coalesce(v_prev, ''), true);
end;
$mark$;


create or replace function public.gmail_commercial_commit_interpretation(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_schema_version text,
  p_transform_version text,
  p_rule_version text,
  p_expected_input_digest text,
  p_messages jsonb,
  p_thread jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owner uuid;
  v_may text;
  v_thread private.gmail_normalized_threads%rowtype;
  v_eligibility text;
  v_digest text;
  v_state text;
  v_compensation text;
  v_evidence text;
  v_eligible_count integer;
  v_payload_count integer;
  v_distinct_count integer;
  v_set_mismatch boolean;
  v_bad_shape boolean;
  v_latest_signals jsonb;
  v_already boolean;
begin
  if p_schema_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_rule_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_transform_version !~ '^[a-z][a-z0-9_.+]{0,160}$' then
    raise exception 'invalid commercial schema/transform/rule version'
      using errcode = 'invalid_parameter_value';
  end if;

  select m.user_id into v_owner
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_may := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may <> 'ok' then
    return jsonb_build_object('result', v_may);
  end if;

  -- Upgrade the share lock from the fence to an exclusive lock so a human
  -- correction and a second commit serialize on this account.
  perform 1 from public.mail_accounts where id = p_mail_account_id for update;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id
   for key share;
  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  if v_eligibility = 'not_eligible' then
    perform set_config('b07.machine_writer', 'on', true);
    update private.gmail_commercial_message_current
       set stale = true, stale_reason = 'b05_not_eligible', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    update private.gmail_commercial_thread_current
       set stale = true, stale_reason = 'b05_not_eligible', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    return jsonb_build_object('result', 'not_eligible');
  end if;

  perform 1
    from private.gmail_normalized_messages m
   where m.mail_account_id = p_mail_account_id
     and m.normalized_thread_id = p_normalized_thread_id
   for key share;

  v_digest := private.gmail_commercial_input_digest(
    p_mail_account_id, p_normalized_thread_id,
    p_schema_version, p_transform_version, p_rule_version
  );
  if v_digest is distinct from p_expected_input_digest then
    -- No new attempt. The previous current row must stop being presented as current.
    perform set_config('b07.machine_writer', 'on', true);
    update private.gmail_commercial_message_current c
       set stale = true,
           suppressed = c.suppressed or exists (
             select 1
               from private.gmail_commercial_message_attempts a
              where a.id = c.current_attempt_id
                and a.current_normalized_message_id is null
           ),
           stale_reason = 'stale_source',
           updated_at = now()
     where c.mail_account_id = p_mail_account_id
       and c.provider_thread_id = v_thread.provider_thread_id;
    update private.gmail_commercial_thread_current
       set stale = true, stale_reason = 'stale_source', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    perform set_config('b07.machine_writer', '', true);
    return jsonb_build_object('result', 'stale_source', 'current_input_digest', v_digest);
  end if;

  if p_thread is null or jsonb_typeof(p_thread) <> 'object' then
    raise exception 'thread payload must be an object' using errcode = 'check_violation';
  end if;
  v_state := p_thread->>'commercial_state';
  v_compensation := p_thread->>'compensation_structure';
  v_evidence := p_thread->>'evidence_strength';
  if v_compensation not in ('paid','in_kind','hybrid','unpaid','other','unknown')
     or v_evidence not in ('strong','moderate','weak','insufficient_evidence')
     or (v_state is not null and v_state not in (
       'unresolved','engaged','negotiating','agreement_observed','declined_observed','ambiguous'
     ))
  then
    raise exception 'unknown commercial thread vocabulary' using errcode = 'check_violation';
  end if;

  select count(*)::int into v_eligible_count
    from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
   where r.eligible;

  with payload as (
    select elem->>'provider_message_id' as provider_message_id
      from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
  ),
  eligible as (
    select r.provider_message_id
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
     where r.eligible
  )
  select
    (select count(*)::int from payload),
    (select count(distinct provider_message_id)::int from payload),
    exists (select 1 from eligible e where not exists (
      select 1 from payload p where p.provider_message_id = e.provider_message_id))
    or exists (select 1 from payload p where not exists (
      select 1 from eligible e where e.provider_message_id = p.provider_message_id))
    into v_payload_count, v_distinct_count, v_set_mismatch;

  if v_payload_count <> v_distinct_count or v_set_mismatch then
    raise exception 'commercial payload is not exactly the eligible message set'
      using errcode = 'check_violation';
  end if;

  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
     where elem->>'disposition' not in ('positive','negative','neutral','mixed','ambiguous')
        or elem->>'evidence_strength' not in ('strong','moderate','weak','insufficient_evidence')
        or not private.gmail_commercial_signals_json_ok(elem->'signals')
        or ((elem->'signals') @> '["redirect"]'::jsonb and (elem->'signals') @> '["rejection"]'::jsonb)
  ) into v_bad_shape;
  if v_bad_shape then
    raise exception 'unknown commercial message vocabulary or redirect combined with rejection'
      using errcode = 'check_violation';
  end if;

  if v_eligible_count = 0 then
    if v_state is not null or v_compensation <> 'unknown' or v_evidence <> 'insufficient_evidence' then
      raise exception 'an empty eligible set is not a commercial state, unpaid, or ghosted'
        using errcode = 'check_violation';
    end if;
  end if;

  if v_state = 'declined_observed' then
    select elem->'signals' into v_latest_signals
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
      join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
        on elem->>'provider_message_id' = r.provider_message_id
     where r.eligible
     order by r.internal_date desc, r.provider_message_id desc
     limit 1;
    if v_latest_signals is null
       or not (v_latest_signals @> '["rejection"]'::jsonb)
       or v_latest_signals @> '["redirect"]'::jsonb
       or v_latest_signals @> '["timing_constraint"]'::jsonb
    then
      raise exception 'declined_observed requires a latest eligible rejection without redirect or timing_constraint'
        using errcode = 'check_violation';
    end if;
  end if;

  -- D072: agreement_observed is both-party evidence. The caller boolean
  -- explicit_booking_confirmation is not evidence. The stored eligible body
  -- must itself be an explicit booking confirmation (the same phrases the
  -- rules engine uses), there must be an earlier creator-sent message, an
  -- agreement signal, and no later eligible rejection. A one-sided accept
  -- stays negotiating.
  if v_state = 'agreement_observed' then
    if not exists (
      select 1
        from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
        join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
          on elem->>'provider_message_id' = r.provider_message_id
       where r.eligible
         and private.gmail_commercial_stored_text_is_explicit_booking(
               p_mail_account_id, r.provider_message_id)
         and (elem->'signals') @> '["agreement"]'::jsonb
         and exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) sent
            where sent.provider_sent and sent.internal_date < r.internal_date
         )
         and not exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) later
             join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) later_elem
               on later_elem->>'provider_message_id' = later.provider_message_id
            where later.eligible
              and (later.internal_date, later.provider_message_id)
                  > (r.internal_date, r.provider_message_id)
              and (later_elem->'signals') @> '["rejection"]'::jsonb
         )
    ) then
      raise exception 'agreement_observed requires stored explicit booking text, an agreement signal, an earlier creator-sent message, and no later rejection'
        using errcode = 'check_violation';
    end if;
  end if;

  -- DIGEST EQUALITY SHORT-CIRCUIT. Same digest and a non-stale current
  -- projection covering exactly the eligible set: zero new attempts.
  select
    exists (
      select 1 from private.gmail_commercial_thread_current c
       where c.mail_account_id = p_mail_account_id
         and c.provider_thread_id = v_thread.provider_thread_id
         and c.input_digest = v_digest
         and not c.stale
    )
    and (
      select count(*)::int
        from private.gmail_commercial_message_current c
        join private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
          on r.provider_message_id = c.provider_message_id and r.eligible
       where c.mail_account_id = p_mail_account_id
         and c.input_digest = v_digest
         and not c.stale
         and not c.suppressed
    ) = v_eligible_count
    and not exists (
      select 1 from private.gmail_commercial_message_current c
       where c.mail_account_id = p_mail_account_id
         and c.provider_thread_id = v_thread.provider_thread_id
         and not c.suppressed
         and not exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
            where r.provider_message_id = c.provider_message_id and r.eligible
         )
    )
    into v_already;

  if v_already then
    return jsonb_build_object('result', 'already_current', 'input_digest', v_digest, 'committed', false);
  end if;

  perform set_config('b07.machine_writer', 'on', true);

  with payload as (
    select
      elem->>'provider_message_id' as provider_message_id,
      elem->>'disposition' as disposition,
      coalesce((
        select array_agg(s.value order by s.value)
          from jsonb_array_elements_text(elem->'signals') s(value)
      ), '{}'::text[]) as signals,
      elem->>'evidence_strength' as evidence_strength
    from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
  ),
  inserted as (
    insert into private.gmail_commercial_message_attempts (
      user_id, mail_account_id, provider_message_id, provider_thread_id, normalized_thread_id,
      current_normalized_message_id, b06_observation_id, b06_response_class,
      b06_classification_rule_version, b06_relation_rule_version, b06_text_transform_version,
      axis_a_basis, axis_a_event_id, axis_a_event_seq, source_payload_sha256, input_digest,
      schema_version, transform_version, engine_kind, rule_version,
      disposition, signals, evidence_strength
    )
    select
      p_user_id, p_mail_account_id, r.provider_message_id, v_thread.provider_thread_id,
      p_normalized_thread_id, r.normalized_message_id, r.b06_observation_id, r.b06_response_class,
      r.b06_classification_rule_version, r.b06_relation_rule_version, r.b06_text_transform_version,
      r.axis_basis, r.axis_event_id, r.axis_event_seq, r.source_payload_sha256, v_digest,
      p_schema_version, p_transform_version, 'rules', p_rule_version,
      py.disposition, py.signals, py.evidence_strength
    from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
    join payload py on py.provider_message_id = r.provider_message_id
    where r.eligible
    returning id, provider_message_id
  )
  insert into private.gmail_commercial_message_current (
    user_id, mail_account_id, provider_message_id, provider_thread_id,
    current_attempt_id, input_digest, stale, stale_reason, suppressed
  )
  select p_user_id, p_mail_account_id, i.provider_message_id, v_thread.provider_thread_id,
         i.id, v_digest, false, null, false
    from inserted i
  on conflict (mail_account_id, provider_message_id) do update
    set provider_thread_id = excluded.provider_thread_id,
        current_attempt_id = excluded.current_attempt_id,
        input_digest = excluded.input_digest,
        stale = false,
        stale_reason = null,
        suppressed = false,
        updated_at = now();

  update private.gmail_commercial_message_current c
     set stale = true, suppressed = true, stale_reason = 'not_eligible', updated_at = now()
   where c.mail_account_id = p_mail_account_id
     and c.provider_thread_id = v_thread.provider_thread_id
     and not exists (
       select 1
         from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
        where r.provider_message_id = c.provider_message_id and r.eligible
     );

  with inserted as (
    insert into private.gmail_commercial_thread_attempts (
      user_id, mail_account_id, provider_thread_id, normalized_thread_id, input_digest,
      schema_version, transform_version, engine_kind, rule_version,
      commercial_state, compensation_structure, evidence_strength
    )
    values (
      p_user_id, p_mail_account_id, v_thread.provider_thread_id, p_normalized_thread_id, v_digest,
      p_schema_version, p_transform_version, 'rules', p_rule_version,
      v_state, v_compensation, v_evidence
    )
    returning id
  )
  insert into private.gmail_commercial_thread_current (
    user_id, mail_account_id, provider_thread_id, current_attempt_id, input_digest, stale, stale_reason
  )
  select p_user_id, p_mail_account_id, v_thread.provider_thread_id, i.id, v_digest, false, null
    from inserted i
  on conflict (mail_account_id, provider_thread_id) do update
    set current_attempt_id = excluded.current_attempt_id,
        input_digest = excluded.input_digest,
        stale = false,
        stale_reason = null,
        updated_at = now();

  return jsonb_build_object('result', 'ok', 'input_digest', v_digest, 'committed', true);
end;
$$;

create or replace function public.gmail_commercial_read_thread(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- An in-place B06 class/version/currentness change does not wait for the
  -- next machine commit. The read marks the bound interpretation stale.
  perform private.gmail_commercial_mark_b06_fingerprint_stale(p_mail_account_id, p_provider_thread_id);

  return jsonb_build_object(
    'result', 'ok',
    'machine', (
      select jsonb_build_object(
        'commercial_state', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.commercial_state
        end,
        'compensation_structure', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.compensation_structure
        end,
        'evidence_strength', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.evidence_strength
        end,
        'stale', c.stale or a.normalized_thread_id is null or exists (
          select 1
            from private.gmail_commercial_message_current mc
            join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
           where mc.mail_account_id = c.mail_account_id
             and mc.provider_thread_id = c.provider_thread_id
             and ma.current_normalized_message_id is null
        ),
        'input_digest', c.input_digest,
        'engine_kind', a.engine_kind,
        'rule_version', a.rule_version,
        'schema_version', a.schema_version,
        'transform_version', a.transform_version,
        'attempt_id', a.id
      )
      from private.gmail_commercial_thread_current c
      join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id
        and c.provider_thread_id = p_provider_thread_id
        and c.user_id = v_user
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', c.provider_message_id,
        'disposition', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else a.disposition
        end,
        'signals', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else to_jsonb(a.signals)
        end,
        'evidence_strength', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else a.evidence_strength
        end,
        'stale', c.stale or a.current_normalized_message_id is null,
        'suppressed', c.suppressed or a.current_normalized_message_id is null,
        'engine_kind', a.engine_kind,
        'rule_version', a.rule_version
      ) order by c.provider_message_id)
      from private.gmail_commercial_message_current c
      join private.gmail_commercial_message_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id
        and c.provider_thread_id = p_provider_thread_id
        and c.user_id = v_user
    ), '[]'::jsonb),
    'human_messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', d.provider_message_id,
        'axis', d.axis,
        'is_cleared', d.is_cleared,
        'reply_nature', d.reply_nature,
        'disposition', d.disposition,
        'signals', d.signals,
        'event_seq', d.current_event_seq
      ) order by d.provider_message_id, d.axis)
      from private.gmail_commercial_message_decisions d
      where d.mail_account_id = p_mail_account_id
        and d.user_id = v_user
        and (
          d.provider_message_id in (
            select m.provider_message_id from private.gmail_normalized_messages m
             where m.mail_account_id = p_mail_account_id
               and m.normalized_thread_id in (
                 select t.id from private.gmail_normalized_threads t
                  where t.mail_account_id = p_mail_account_id
                    and t.provider_thread_id = p_provider_thread_id
               )
          )
          or d.provider_message_id in (
            select a.provider_message_id from private.gmail_commercial_message_attempts a
             where a.mail_account_id = p_mail_account_id
               and a.provider_thread_id = p_provider_thread_id
          )
        )
    ), '[]'::jsonb),
    'human_thread', coalesce((
      select jsonb_agg(jsonb_build_object(
        'axis', d.axis,
        'is_cleared', d.is_cleared,
        'business_outcome', d.business_outcome,
        'lost_reason', d.lost_reason,
        'compensation_structure', d.compensation_structure,
        'event_seq', d.current_event_seq
      ) order by d.axis)
      from private.gmail_commercial_thread_decisions d
      where d.mail_account_id = p_mail_account_id
        and d.provider_thread_id = p_provider_thread_id
        and d.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.gmail_commercial_status(p_mail_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- An in-place B06 class/version/currentness change does not wait for the
  -- next machine commit. The read marks the bound interpretation stale.
  perform private.gmail_commercial_mark_b06_fingerprint_stale(p_mail_account_id, null);

  return jsonb_build_object(
    'result', 'ok',
    'threads', (select count(*) from private.gmail_commercial_thread_current c
                 where c.mail_account_id = p_mail_account_id and c.user_id = v_user),
    'message_attempts', (select count(*) from private.gmail_commercial_message_attempts a
                          where a.mail_account_id = p_mail_account_id and a.user_id = v_user),
    'stale_threads', (select count(*) from private.gmail_commercial_thread_current c
                       where c.mail_account_id = p_mail_account_id and c.user_id = v_user and c.stale),
    'human_events', (select count(*) from private.gmail_commercial_creator_decision_events e
                      where e.mail_account_id = p_mail_account_id and e.user_id = v_user)
  );
end;
$$;

create or replace function public.gmail_commercial_list_threads(p_mail_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- An in-place B06 class/version/currentness change does not wait for the
  -- next machine commit. The read marks the bound interpretation stale.
  perform private.gmail_commercial_mark_b06_fingerprint_stale(p_mail_account_id, null);

  return jsonb_build_object(
    'result', 'ok',
    'threads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_thread_id', c.provider_thread_id,
        'commercial_state', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.commercial_state
        end,
        'stale', c.stale or a.normalized_thread_id is null or exists (
          select 1
            from private.gmail_commercial_message_current mc
            join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
           where mc.mail_account_id = c.mail_account_id
             and mc.provider_thread_id = c.provider_thread_id
             and ma.current_normalized_message_id is null
        )
      ) order by c.provider_thread_id)
      from private.gmail_commercial_thread_current c
      join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id and c.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function private.gmail_commercial_classifier_clean_text(text, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.gmail_commercial_text_is_explicit_booking(text)
  from public, anon, authenticated, service_role;
revoke all on function private.gmail_commercial_stored_text_is_explicit_booking(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.gmail_commercial_b06_fingerprint_drifted(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function private.gmail_commercial_mark_b06_fingerprint_stale(uuid, text)
  from public, anon, authenticated, service_role;
