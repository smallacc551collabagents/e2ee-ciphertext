import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getSessionResult } from "@/lib/api/server";
import { BackendUnavailable } from "@/components/BackendUnavailable";
import { LogoutButton } from "@/components/LogoutButton";

export const dynamic = "force-dynamic";

export default async function PrivateLayout({ children }: { children: ReactNode }) {
  const session = await getSessionResult();
  if (session.status === "unavailable") return <BackendUnavailable />;
  if (session.status === "anonymous") redirect("/login"); // middleware already cleared any stale cookie
  const { user } = session;
  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b bg-white px-4 py-2">
        <Link href="/chat" className="font-semibold">Ciphertext</Link>
        <nav className="flex items-center gap-4 text-sm">
          <span data-testid="current-user" className="text-slate-600">@{user.username}</span>
          <Link href="/settings" className="hover:underline">Settings</Link>
          <LogoutButton className="rounded-md border px-3 py-1 hover:bg-slate-100" />
        </nav>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
