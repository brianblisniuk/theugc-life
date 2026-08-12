-- 0013_public_intelligence_view.sql
-- Safe public projection of hotel intelligence (DATABASE.md §9, D009, PRD §12).
--
-- Public/anonymous pages read ONLY this view — never the base intelligence or
-- outreach tables. It exposes no creator_id, no pipeline_item_id, no private
-- notes, no financial values, and no raw low-N timestamps. Precise metrics are
-- suppressed until confidence is sufficient (PRD §12.6/§12.7, D012).
--
-- The view is intentionally NOT security_invoker: it runs with the (table-owner)
-- definer's rights so anonymous callers can read the safe aggregate columns
-- without any grant on the underlying hotel_intelligence table.
create view public.hotel_public_intelligence
with (security_invoker = false) as
select
  h.id as hotel_id,
  h.slug as hotel_slug,
  hi.activity_level,
  hi.confidence_level,
  -- Precise reply rate only at strong confidence.
  case
    when hi.confidence_level = 'strong' then hi.reply_rate
    else null
  end as reply_rate,
  -- "Confirmed collaboration" is a boolean derived from qualifying events
  -- (EVENTS.md §7); never an exact contributor-identifying record.
  (hi.collaboration_count > 0) as has_confirmed_collaboration,
  -- Coarse recency band, and only once confidence is at least moderate.
  case
    when hi.confidence_level not in ('moderate', 'strong') then null
    when hi.last_creator_activity_at is null then null
    when hi.last_creator_activity_at >= now() - interval '30 days' then 'past_month'
    when hi.last_creator_activity_at >= now() - interval '90 days' then 'past_quarter'
    else 'older'
  end as recency_band
from public.hotels h
join public.hotel_intelligence hi on hi.hotel_id = h.id;

comment on view public.hotel_public_intelligence is
  'Safe public projection of hotel intelligence. No creator identifiers, no raw low-N data. The ONLY intelligence surface for anonymous pages.';

grant select on public.hotel_public_intelligence to anon, authenticated;
