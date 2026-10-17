import type { Metadata } from "next";

import { SignupScreen } from "@/components/signup-screen";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect?: string }>;
}) {
  const { redirect } = await searchParams;
  return <SignupScreen redirectTo={redirect} />;
}
