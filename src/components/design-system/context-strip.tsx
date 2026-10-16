export function ContextStrip({
  title,
  detail,
  aside,
}: {
  title: string;
  detail?: string;
  aside?: React.ReactNode;
}) {
  return (
    <div className="v12-context">
      <div>
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
      </div>
      {aside}
    </div>
  );
}
