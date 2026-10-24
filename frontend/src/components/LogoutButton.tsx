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
        await signout().catch(() => undefined);
        router.replace("/session/expired"); // also clears the cookie locally
      }}>
      {pending ? "Signing out…" : "Log out"}
    </button>
  );
}
