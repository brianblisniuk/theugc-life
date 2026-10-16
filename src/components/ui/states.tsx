export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="v12-state" role="status">
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="v12-state" role="status" aria-busy="true" aria-live="polite">
      <h2>{label}</h2>
      <div className="v12-skel" aria-hidden="true">
        <span className="v12-skel-line" />
        <span className="v12-skel-line v12-skel-line-short" />
        <span className="v12-skel-line" />
      </div>
    </div>
  );
}

export function ErrorState({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry?: () => void;
}) {
  return (
    <div className="v12-state v12-state-danger" role="alert">
      <h2>{title}</h2>
      <p>{description}</p>
      {onRetry ? (
        <button type="button" className="v12-btn" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function LockedState({
  title = "Locked",
  description = "This stays hidden until your plan allows it. Nothing is blurred in the page.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="v12-state v12-state-locked">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  );
}

export function InsufficientCreditsState({
  description = "This action needs a credit. Your balance is unchanged until it succeeds.",
}: {
  description?: string;
}) {
  return (
    <div className="v12-state v12-state-warn" role="status">
      <h2>Insufficient credits</h2>
      <p>{description}</p>
    </div>
  );
}

export function DisconnectedEmailState({
  description = "Gmail is not connected. You can still record activity by hand. A manual note is not a verified message.",
}: {
  description?: string;
}) {
  return (
    <div className="v12-state v12-state-warn" role="status">
      <h2>Disconnected email</h2>
      <p>{description}</p>
    </div>
  );
}

export function InsufficientDataState({
  description = "There is not enough evidence to publish a figure. This is not zero.",
}: {
  description?: string;
}) {
  return (
    <div className="v12-state" role="status">
      <h2>Insufficient data</h2>
      <p>{description}</p>
    </div>
  );
}
