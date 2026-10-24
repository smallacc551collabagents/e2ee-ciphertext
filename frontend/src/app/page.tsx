import { redirect } from "next/navigation";
import { getSessionResult } from "@/lib/api/server";

export const dynamic = "force-dynamic";
export default async function Home() {
  redirect((await getSessionResult()).status === "anonymous" ? "/login" : "/chat");
}
