-- Published catalog for the local E2E run. Auth users are created by the app.
insert into public.destinations (id, name, slug, type, country_code, country_name)
values (
  '11111111-1111-4111-8111-111111111111',
  'E2E Bay',
  'e2e-bay',
  'city',
  'US',
  'United States'
)
on conflict (id) do nothing;

insert into public.hotels (
  id, name, slug, destination_id, country_code, address,
  latitude, longitude, star_rating, star_rating_source, star_rating_confidence,
  active_status
)
values (
  '22222222-2222-4222-8222-222222222222',
  'E2E Harbor House',
  'e2e-harbor-house',
  '11111111-1111-4111-8111-111111111111',
  'US',
  '1 Harbor Road',
  25.7617,
  -80.1918,
  5,
  'owner',
  'confirmed',
  'active'
)
on conflict (id) do nothing;
