import { redirect } from "next/navigation";
import { getSession } from "@/lib/api/server";

export const dynamic = "force-dynamic";
export default async function Home() {
  redirect((await getSession()) ? "/chat" : "/login");
}
