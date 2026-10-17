import type { Inline, LegalDocument } from "@/lib/legal/documents";

function InlineRun({ parts }: { parts: Inline[] }) {
  return parts.map((part, index) => {
    if (typeof part === "string") return <span key={index}>{part}</span>;
    if ("strong" in part) {
      return (
        <strong key={index} className="font-semibold text-text">
          {part.strong}
        </strong>
      );
    }
    if ("code" in part) {
      return (
        <code key={index} className="font-mono text-[13px] text-text">
          {part.code}
        </code>
      );
    }
    return (
      <a
        key={index}
        href={part.href}
        className="text-text underline decoration-border underline-offset-2 hover:decoration-accent"
      >
        {part.link}
      </a>
    );
  });
}

/**
 * Public legal article. Midnight tokens only: canvas text, heading ink, and
 * the lime accent as a link underline. No login and no extra script hosts.
 */
export function LegalArticle({
  document,
  languageSwitch,
}: {
  document: LegalDocument;
  languageSwitch: { href: string; label: string };
}) {
  return (
    <>
      <p className="mb-6 text-sm">
        <a href={languageSwitch.href} className="text-muted hover:text-text">
          {languageSwitch.label}
        </a>
      </p>
      <article lang={document.lang} className="max-w-3xl text-[15px] leading-relaxed text-muted">
        <h1 className="text-3xl font-semibold tracking-tight text-text">{document.h1}</h1>
        <p className="mt-3">
          <em>
            <InlineRun parts={document.updated} />
          </em>
        </p>
        {document.blocks.map((block, index) => {
          if ("h2" in block) {
            return (
              <h2 key={index} className="mt-8 text-lg font-semibold text-text">
                {block.h2}
              </h2>
            );
          }
          if ("ul" in block) {
            return (
              <ul key={index} className="mt-3 list-disc space-y-2 pl-5">
                {block.ul.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <InlineRun parts={item} />
                  </li>
                ))}
              </ul>
            );
          }
          return (
            <p key={index} className="mt-3">
              <InlineRun parts={block.p} />
            </p>
          );
        })}
      </article>
    </>
  );
}
