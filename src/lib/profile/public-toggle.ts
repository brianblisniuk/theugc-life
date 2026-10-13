/**
 * D096. What the public-profile control should show.
 *
 * `setPublicProfileEnabled` returns the boolean it stored and then
 * `revalidatePath` sends that same boolean back as the server prop. Those
 * two updates can land in one render. The saved result must not invert the
 * prop. Until the prop catches up, the action result is the persisted flag.
 * Once they match, the prop wins, which drops the saved result the way a
 * reset of `useActionState` would.
 */
export type PublicProfileToggleState =
  { result: "saved"; enabled: boolean } | { result: "error" } | null;

export function publicProfileIsOn(
  serverEnabled: boolean,
  state: PublicProfileToggleState,
): boolean {
  if (state?.result === "saved" && state.enabled !== serverEnabled) return state.enabled;
  return serverEnabled;
}
