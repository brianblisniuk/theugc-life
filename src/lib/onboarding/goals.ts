/**
 * Getting Started routes (D095).
 *
 * The four intentions are links to screens that already exist. They do not
 * store a new goal and they do not mark a step done.
 */
export const ONBOARDING_GOALS = [
  {
    id: "trip",
    title: "I’m planning a trip",
    detail: "Choose a destination from the catalog. Dates stay optional.",
    href: "/app/onboarding#destination",
  },
  {
    id: "explore",
    title: "I’m exploring opportunities",
    detail: "Look through published hotels. Nothing is saved until you save it.",
    href: "/app/discover",
  },
  {
    id: "conversations",
    title: "I already have conversations",
    detail: "Open Inbox. A mailbox connection lives on Account and Profile.",
    href: "/app/inbox",
  },
  {
    id: "portfolio",
    title: "I need a stronger portfolio",
    detail: "Your profile stays private until you turn a field on.",
    href: "/app/profile",
  },
] as const;

export type OnboardingGoalId = (typeof ONBOARDING_GOALS)[number]["id"];

const ALLOWED = new Set<string>([
  "/app/onboarding#destination",
  "/app/discover",
  "/app/inbox",
  "/app/profile",
]);

export function onboardingGoalsAreInternal(): boolean {
  return ONBOARDING_GOALS.every((goal) => ALLOWED.has(goal.href) && goal.href.startsWith("/app"));
}
