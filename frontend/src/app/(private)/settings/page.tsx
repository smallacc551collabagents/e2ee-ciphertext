import { getSession } from "@/lib/api/server";
import { LogoutButton } from "@/components/LogoutButton";

export default async function SettingsPage() {
  const user = await getSession();
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h2 className="font-medium">Account</h2>
        <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Username</dt><dd>@{user?.username}</dd>
          <dt className="text-slate-500">Member since</dt><dd>{user ? new Date(user.createdAt).toLocaleDateString() : ""}</dd>
        </dl>
      </section>
      <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200">
        <h2 className="font-medium">Security</h2>
        <p className="mt-2 text-sm">Safety number: <span className="font-mono">00000 00000 00000</span> <em className="text-amber-700">(placeholder)</em></p>
        <p className="mt-1 text-sm text-slate-500">Devices: coming in Phase 2 (later)</p>
      </section>
      <section className="rounded-xl bg-white p-4 ring-1 ring-slate-200 text-sm text-slate-500">
        <h2 className="font-medium text-slate-900">Coming later</h2>
        <ul className="mt-2 list-disc pl-5"><li>Group chats (later)</li><li>Disappearing messages (later)</li></ul>
      </section>
      <LogoutButton className="rounded-md bg-red-600 px-4 py-2 text-white hover:bg-red-700" />
    </main>
  );
}
