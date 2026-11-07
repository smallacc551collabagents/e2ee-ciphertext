"use client";
import { useEffect } from "react";
import { installLiveReceipts } from "./live";

/** Starts heartbeat + privacy for the signed-in account (chat and settings). Idempotent. */
export function ReceiptsBoot({ userId, username }: { userId: string; username: string }) {
  if (typeof window !== "undefined" && userId) installLiveReceipts({ id: userId, username });
  useEffect(() => { if (userId) installLiveReceipts({ id: userId, username }); }, [userId, username]);
  return null;
}
