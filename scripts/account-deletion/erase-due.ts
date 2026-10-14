/**
 * Operator path for due account erasures (D151).
 *
 *   npm run account:erase-due
 *
 * Prints a result code and a count. It does not print emails, tokens, or
 * environment values. There is no scheduler in this repository; run the
 * command when delete_after has arrived.
 */
import { Client } from "pg";

function redact(message: string): string {
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted]");
}

async function main() {
  const connectionString = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL or TEST_DATABASE_URL is required. Values are not printed.");
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query<{
      result: { result?: string; erased?: number } | null;
    }>("select public.erase_due_creator_accounts() as result");
    const row = res.rows[0]?.result;
    console.log(
      JSON.stringify({
        result: row?.result ?? null,
        erased: typeof row?.erased === "number" ? row.erased : null,
      }),
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "erase failed";
  console.error(redact(message));
  process.exit(1);
});
