# Sprint 1C — Dubai Pilot Selection

This document identifies the property cohort only. It intentionally contains no contact email data.

## Cohort

- `ae-dubai-taj-dubai` — Taj Dubai
- `ae-dubai-ciel-dubai-marina-vignette-collection-by-ihg` — Ciel Dubai Marina, Vignette Collection by IHG
- `ae-dubai-five-jumeirah-village-dubai` — Five Jumeirah Village Dubai
- `ae-dubai-five-palm-jumeirah-dubai` — Five Palm Jumeirah Dubai
- `ae-dubai-five-luxe` — Five Luxe
- `ae-dubai-park-regis-kris-kin-hotel-dubai` — Park Regis Kris Kin Hotel Dubai
- `ae-dubai-al-habtoor-polo-resort` — Al Habtoor Polo Resort
- `ae-dubai-paramount-hotel-dubai` — Paramount Hotel Dubai
- `ae-dubai-lapita-dubai-parks-and-resorts-autograph-collection` — Lapita, Dubai Parks and Resorts, Autograph Collection
- `ae-dubai-tryp-by-wyndham-dubai` — TRYP by Wyndham Dubai
- `ae-dubai-paramount-hotel-midtown` — Paramount Hotel Midtown
- `ae-dubai-marco-polo-hotel` — Marco Polo Hotel
- `ae-dubai-the-first-collection-dubai-marina` — The First Collection Dubai Marina
- `ae-dubai-donatello-hotel` — Donatello Hotel
- `ae-dubai-hyatt-regency-dubai-creek-heights` — Hyatt Regency Dubai Creek Heights
- `ae-dubai-kempinski-mall-of-the-emirates` — Kempinski Mall Of The Emirates
- `ae-dubai-pullman-dubai-downtown` — Pullman Dubai Downtown
- `ae-dubai-bab-al-shams-a-rare-finds-desert-resort-dubai` — Bab Al Shams, A Rare Finds Desert Resort, Dubai
- `ae-dubai-waldorf-astoria-dubai-international-financial-centre` — Waldorf Astoria Dubai International Financial Centre
- `ae-dubai-fairmont-the-palm` — Fairmont The Palm
- `ae-dubai-park-hyatt-dubai` — Park Hyatt Dubai
- `ae-dubai-four-seasons-hotel-dubai-international-financial-cen` — Four Seasons Hotel Dubai International Financial Centre
- `ae-dubai-hyatt-centric-jumeirah-dubai` — Hyatt Centric Jumeirah Dubai
- `ae-dubai-25hours-hotel-dubai-one-central` — 25hours Hotel Dubai One Central
- `ae-dubai-shangri-la-dubai` — Shangri-La Dubai
- `ae-dubai-the-h-dubai` — The H Dubai
- `ae-dubai-four-seasons-resort-dubai-at-jumeirah-beach` — Four Seasons Resort Dubai At Jumeirah Beach
- `ae-dubai-mandarin-oriental-jumeira-dubai` — Mandarin Oriental Jumeira, Dubai
- `ae-dubai-sofitel-dubai-the-obelisk` — Sofitel Dubai The Obelisk
- `ae-dubai-mandarin-oriental-downtown-dubai` — Mandarin Oriental Downtown, Dubai

## Selection constraints

All 30 are Dubai/AE, 4–5 star in the source, have an official property source URL, and have at least one verified official property-scoped endpoint. Known duplicate-property/data-quality-flag rows and Group HQ rows were excluded.

The pilot intentionally includes repeated contact endpoints across distinct hotels where legitimate. Email is never a hotel identity key.

Five high-value named contacts from the source were held out because the source marked them verified but did not retain the primary source URL. They may be recovered in a later provenance-enrichment pass rather than weakening the first pilot.

Two source `brand_name` values showed an internal conflict with the property identity/official source domain; those brand fields are blank in the pilot instead of being guessed.

## Canonical transformation

The private pilot workbook is already normalized to `HOTEL_DATA_CONTRACT.md`. Sprint 1C should consume it as canonical-standard input, not reconstruct it from the original 655-property workbook.
