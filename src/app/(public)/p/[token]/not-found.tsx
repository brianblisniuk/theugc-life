export default function ShareLinkNotFound() {
  return (
    <div className="space-y-2">
      <h1 className="text-3xl font-semibold tracking-tight text-text">
        This link is not available
      </h1>
      <p className="max-w-prose text-sm text-muted">
        The address is missing, expired, or no longer shared.
      </p>
    </div>
  );
}
