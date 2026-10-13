-- 0059_star_rating_provenance.sql
-- D106. Hotelbeds category codes that already mean exactly 4 or exactly 5
-- may be stored as a provisional, publishable star_rating. Existing classified
-- rows are owner-confirmed. RLS is not modified: hotels_select and
-- hotels_write stay as 0012 left them. No privilege statement is added.
--
-- hotelbeds_code is the idempotency key for scripts/import-hotelbeds. It is
-- not the canonical primary key (D063). hotels.id stays the canonical id.

alter table public.hotels
  add column star_rating_source text,
  add column star_rating_confidence text,
  add column needs_category_review boolean not null default false,
  add column hotelbeds_code text;

alter table public.hotels
  add constraint hotels_star_rating_source_check
    check (star_rating_source is null or star_rating_source in ('owner', 'hotelbeds')),
  add constraint hotels_star_rating_confidence_check
    check (
      star_rating_confidence is null
      or star_rating_confidence in ('confirmed', 'provisional')
    ),
  add constraint hotels_star_rating_provenance_pair_check
    check (
      (star_rating_source is null and star_rating_confidence is null)
      or (star_rating_source = 'owner' and star_rating_confidence = 'confirmed')
      or (star_rating_source = 'hotelbeds' and star_rating_confidence = 'provisional')
    );

create unique index hotels_hotelbeds_code_uidx
  on public.hotels (hotelbeds_code)
  where hotelbeds_code is not null;

comment on column public.hotels.star_rating_source is
  'D106. owner = a classification already on the row (backfilled as confirmed). hotelbeds = the reviewed Hotelbeds category, provisional.';
comment on column public.hotels.star_rating_confidence is
  'D106. confirmed pairs with owner. provisional pairs with hotelbeds.';
comment on column public.hotels.needs_category_review is
  'D106. Cheap flag when the Hotelbeds name or type suggests an apartment, residence, or villa complex. Default false. Does not by itself unpublish the row.';
comment on column public.hotels.hotelbeds_code is
  'D106 import idempotency key. Nullable. Not the canonical primary key.';

-- Rows that already carry a classification become owner-confirmed. Rows with
-- no star_rating are left unset. A Hotelbeds provisional pair is not a target
-- of this update because those rows do not exist yet; the source predicate
-- keeps a later re-run from overwriting one.
update public.hotels
   set star_rating_source = 'owner',
       star_rating_confidence = 'confirmed'
 where star_rating is not null
   and star_rating_source is null
   and star_rating_confidence is null;
