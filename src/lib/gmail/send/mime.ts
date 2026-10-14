/**
 * One text/plain RFC822 message. The From address is the connected mailbox,
 * never a value from the browser. A carriage return or line feed in a header
 * is rejected before the message is built.
 */

const HEADER_BREAK = /[\r\n]/;

export class MimeRejected extends Error {
  constructor(readonly field: "from" | "to" | "subject") {
    super(`mime_rejected: ${field}`);
    this.name = "MimeRejected";
  }
}

function encodeSubject(subject: string): string {
  if (/^[\t\x20-\x7e]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

export function buildPlainMessage(input: {
  from: string;
  to: string;
  subject: string;
  body: string;
}): string {
  if (HEADER_BREAK.test(input.from)) throw new MimeRejected("from");
  if (HEADER_BREAK.test(input.to)) throw new MimeRejected("to");
  if (HEADER_BREAK.test(input.subject)) throw new MimeRejected("subject");

  const body = input.body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  return [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodeSubject(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join("\r\n");
}

export function encodeRawMessage(rfc822: string): string {
  return Buffer.from(rfc822, "utf8").toString("base64url");
}
