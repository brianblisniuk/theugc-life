-- 0055 — UX01. D095 onboarding state, D096–D097 public creator card.
--
-- 0054 is the signup-trigger grant and is not edited.
-- D089–D091 (the hotel share link) are not changed. This file does not
-- alter creator_share_links, field opt-ins, or read_creator_share_profile.
--
-- Onboarding state is owner-only. It is not a column on creator_profiles,
-- because a public profile row is world-readable and must not carry the
-- chosen destination or the dismissed checklist.
--
-- A pipeline item does not require a trip (save_hotel_to_pipeline). This
-- migration does not create a draft trip and does not consume the Free
-- active-trip allowance.
--
-- read_public_creator_card returns the basic editable profile and the same
-- five creator-recorded counts as creator_personal_counts, and only when
-- public_profile_enabled is true. A missing username and a private profile
-- both return SQL null, which is not a zero. The payload has no hotel name,
-- contact, amount, deal, past collaboration, or portfolio asset.

create table public.creator_onboarding_state (
  creator_id uuid primary key references public.creator_profiles(id) on delete cascade,
  destination_id uuid references public.destinations(id),
  checklist_dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creator_onboarding_state is
  'D095. Owner-only destination choice and checklist dismissal. Not the public profile. A missing row means the destination step is not done.';

comment on column public.creator_onboarding_state.destination_id is
  'Destination used to show relevant published hotels. The creator can change it. It is not a trip.';

comment on column public.creator_onboarding_state.checklist_dismissed_at is
  'When set, the home checklist is hidden. The steps remain derived from rows.';

create trigger creator_onboarding_state_set_updated_at
  before update on public.creator_onboarding_state
  for each row execute function public.set_updated_at();

alter table public.creator_onboarding_state enable row level security;

create policy creator_onboarding_state_all
  on public.creator_onboarding_state
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.creator_onboarding_state from public, anon, authenticated;
grant select, insert, update on table public.creator_onboarding_state to authenticated;
grant select, insert, update, delete on table public.creator_onboarding_state to service_role;

-- ---------------------------------------------------------------------------
-- Social public card. SECURITY DEFINER so the counts can be read without
-- granting anon access to pipeline, collaborations, or mail. The function
-- never selects those row bodies: only integer counts for one public profile.
-- ---------------------------------------------------------------------------
create or replace function public.read_public_creator_card(p_username text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_name text;
  v_username text;
  v_bio text;
  v_city text;
  v_country text;
  v_photo text;
  v_language text;
  v_languages text[];
  v_niches text[];
  v_formats text[];
  v_instagram_url text;
  v_instagram_handle text;
  v_tiktok_url text;
  v_tiktok_handle text;
  v_youtube_url text;
  v_website text;
  v_outreach integer;
  v_replies integer;
  v_agreements integer;
  v_completed integer;
  v_done integer;
begin
  if p_username is null or char_length(btrim(p_username)) < 3 or char_length(p_username) > 80 then
    return null;
  end if;

  select cp.id, cp.display_name, cp.username::text, cp.bio, cp.home_city, cp.home_country,
         cp.profile_photo_url, cp.primary_language, cp.languages, cp.creator_niches,
         cp.content_formats, cp.instagram_url, cp.instagram_handle, cp.tiktok_url,
         cp.tiktok_handle, cp.youtube_url, cp.website_url
    into v_creator, v_name, v_username, v_bio, v_city, v_country, v_photo, v_language,
         v_languages, v_niches, v_formats, v_instagram_url, v_instagram_handle,
         v_tiktok_url, v_tiktok_handle, v_youtube_url, v_website
    from public.creator_profiles cp
   where cp.public_profile_enabled = true
     and lower(cp.username::text) = lower(btrim(p_username));

  if v_creator is null then
    return null;
  end if;

  select count(distinct oe.pipeline_item_id)::integer into v_outreach
    from public.outreach_events oe
   where oe.creator_id = v_creator
     and oe.source = 'manual_creator'
     and oe.event_type in ('pitch_sent', 'followup_sent');

  select count(distinct oe.pipeline_item_id)::integer into v_replies
    from public.outreach_events oe
   where oe.creator_id = v_creator
     and oe.source = 'manual_creator'
     and oe.event_type = 'reply_received';

  select count(*)::integer into v_agreements
    from public.collaborations c
   where c.creator_id = v_creator;

  select count(*)::integer into v_completed
    from public.collaborations c
   where c.creator_id = v_creator
     and c.status = 'completed';

  select count(*)::integer into v_done
    from public.collaboration_deliverables d
   where d.creator_id = v_creator
     and d.status = 'approved';

  return jsonb_build_object(
    'display_name', v_name,
    'username', v_username,
    'bio', v_bio,
    'home_city', v_city,
    'home_country', v_country,
    'profile_photo_url', v_photo,
    'primary_language', v_language,
    'languages', to_jsonb(coalesce(v_languages, array[]::text[])),
    'creator_niches', to_jsonb(coalesce(v_niches, array[]::text[])),
    'content_formats', to_jsonb(coalesce(v_formats, array[]::text[])),
    'instagram_url', v_instagram_url,
    'instagram_handle', v_instagram_handle,
    'tiktok_url', v_tiktok_url,
    'tiktok_handle', v_tiktok_handle,
    'youtube_url', v_youtube_url,
    'website_url', v_website,
    'outreach', v_outreach,
    'replies', v_replies,
    'agreements', v_agreements,
    'completed_collaborations', v_completed,
    'deliverables_done', v_done
  );
end;
$$;

comment on function public.read_public_creator_card(text) is
  'D096–D097. Public card for a profile the creator turned on. SQL null when missing or private, which is not zero. Counts are creator-recorded outcomes only. No hotel name, contact, amount, rate, or past collaboration. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_public_creator_card(text) from public;
grant execute on function public.read_public_creator_card(text) to anon, authenticated, service_role;
