/**
 * Re-exports the D095 first-run checklist. The old Proposed D082 module path
 * stays so existing imports keep resolving.
 */
export {
  FIRST_RUN_COPY,
  FIRST_RUN_HREFS,
  POST_ONBOARDING_PATH,
  gmailProbe,
  greeting,
  homeView,
  ownedExistence,
  remainingRequired,
  resolveOwnProfile,
} from "./first-run";

export type { FirstRunFacts, FirstRunStep, HomeView, Probe } from "./first-run";
