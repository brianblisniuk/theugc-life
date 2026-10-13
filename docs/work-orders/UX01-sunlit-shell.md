# UX01 — Sunlit Creator OS shell, onboarding, public profile

**Status:** Binding work order. One PR. Do not merge.  
**Base:** `main` `621bc557762a70242b08a02afca94bca6c08f08d` (merge of PR #64, E05)  
**Branch:** `cursor/ux01-sunlit-creator-os-79af`  
**Migration:** `0055_onboarding_and_public_profile.sql`. `0054` is the previous file and is not edited.

## Principal question

How does the signed-in shell look like Direction A, how does a new creator save a first catalog hotel, and how does a public profile show only basic fields and simple counts, while every feature without a written tier stays Free?

## Locked reading

- Direction A uses the accepted A2 tokens (D047, D048, D053): white background, ink `#111`, Sol `#FFE01B` on primary actions, Archivo 800 headings, dense rows. Primary routes stay D081. Labels are Inicio, Descubrir, Pipeline, Viajes, Perfil. Narrow screens pin those five items to the bottom.
- D095 replaces the Proposed D082 checklist. One destination question, hotels from the catalog, verified name and role only when premium contact access already allows it, otherwise “Contacto genérico” with no email. The checklist is dismissible. No draft trip, because a pipeline item does not require one.
- D096 turns `public_profile_enabled` on from the owner’s profile. `/creators/[username]` reads `read_public_creator_card`. Missing and private are SQL null.
- D097 puts the D087 counts on that card and keeps past collaborations off it. D089–D091 are unchanged.
- D098 makes every inventory entry that had no written tier Free. D056 quotas and premium hotel data stay.

## Out of scope

New prices, Rebill, Gmail send, invented hotels, reply-rate copy on Free cards, and merging this PR.
