"use client";
import { setActiveUser, hardReset } from "@/lib/session-guard";
import { useState } from "react";
import { signout } from "@/lib/api/client";
import { closeLocalE2EE, wipeLocalE2EE } from "@/features/chat/data/wipe";

export function LogoutButton({ className = "", removeData = false }: { className?: string; removeData?: boolean }) {
  const [pending, setPending] = useState(false);
  return (
    <button type="button" disabled={pending} className={className}
      onClick={async () => {
        setPending(true);
        setActiveUser(""); // stop every tab of this account from sending with the next account's cookie
        await signout().catch(() => undefined); // backend clears e2ee_session via the first-party proxy
        // Belt and braces: same-origin POST that deletes the cookie locally (never a GET).
        await fetch("/session/expired", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
        if (removeData) await wipeLocalE2EE().catch(() => undefined); // explicit: delete keys, history, caches
        else await closeLocalE2EE().catch(() => undefined); // keep this device so re-login has no new-device screen
        hardReset("/login"); // full navigation clears adapter, timers and in-flight sends
      }}>
      {pending ? "Signing out…" : removeData ? "Log out and remove this browser's data" : "Log out"}
    </button>
  );
}
