"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { signout } from "@/lib/api/client";

export function LogoutButton({ className = "" }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <button type="button" disabled={pending} className={className}
      onClick={async () => {
        setPending(true);
        await signout().catch(() => undefined); // backend clears e2ee_session via the first-party proxy
        // Belt and braces: same-origin POST that deletes the cookie locally (never a GET).
        await fetch("/session/expired", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
        router.replace("/login");
        router.refresh();
      }}>
      {pending ? "Signing out…" : "Log out"}
    </button>
  );
}
