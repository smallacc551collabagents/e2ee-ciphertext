import { getSession } from "@/lib/api/server";
import { LogoutButton } from "@/components/LogoutButton";
import { DeleteAccount } from "@/components/DeleteAccount";
import { avatarColor, initials } from "@/features/chat/format";

const NAV = ["Profile", "Privacy", "Devices", "Notifications", "Appearance"] as const;
const PRIVACY = ["Read receipts", "Typing indicators", "Disappearing messages"] as const;

function Soon() {
  return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">Coming soon</span>;
}

export default async function SettingsPage() {
  const user = await getSession(); // layout guarantees a session
  const name = user?.username ?? "";
  return (
    <main className="mx-auto flex max-w-5xl gap-6 p-4 md:p-8">
      <nav aria-label="Settings sections" className="hidden w-48 shrink-0 md:block">
        <h1 className="mb-4 text-2xl font-semibold">Settings</h1>
        <ul className="space-y-1 text-sm">
          {NAV.map((n) => (
            <li key={n}><a href={`#${n.toLowerCase()}`} className="block rounded-lg px-3 py-2 text-slate-700 hover:bg-slate-100">{n}</a></li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 space-y-6">
        <h1 className="text-2xl font-semibold md:hidden">Settings</h1>
        <section id="profile" aria-labelledby="profile-h" className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <h2 id="profile-h" className="font-semibold">Profile</h2>
          <div className="mt-4 flex items-center gap-4">
            <div aria-hidden className={`flex h-14 w-14 items-center justify-center rounded-full text-lg font-semibold text-white ${avatarColor(name)}`}>{initials(name)}</div>
            <div>
              <p className="font-medium" data-testid="settings-username">{name}</p>
              <p className="text-sm text-slate-500">@{name}</p>
              {user && <p className="text-xs text-slate-400">Member since {new Date(user.createdAt).toLocaleDateString()}</p>}
            </div>
          </div>
        </section>
        <section id="privacy" aria-labelledby="privacy-h" className="rounded-2xl bg-white p-5 ring-1 ring-slate-200">
          <div className="flex items-center justify-between"><h2 id="privacy-h" className="font-semibold">Privacy</h2><Soon /></div>
          <ul className="mt-3 divide-y divide-slate-100">
            {PRIVACY.map((p) => (
              <li key={p} className="flex items-center justify-between py-3 text-sm">
                <span>{p}</span>
                <input type="checkbox" role="switch" aria-label={p} disabled className="h-5 w-9 cursor-not-allowed" />
              </li>
            ))}
          </ul>
        </section>
        <section id="devices" aria-labelledby="devices-h" className="rounded-2xl bg-white p-5 ring-1 ring-slate-200" data-testid="devices-coming-soon">
          <div className="flex items-center justify-between"><h2 id="devices-h" className="font-semibold">Linked devices &amp; keys</h2><Soon /></div>
          <p className="mt-2 text-sm text-slate-500">Device list, key fingerprints and safety numbers will appear here once end-to-end encryption is enabled. Private keys never leave this device.</p>
        </section>
        <section id="notifications" className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"><div className="flex items-center justify-between"><h2 className="font-semibold">Notifications</h2><Soon /></div></section>
        <section id="appearance" className="rounded-2xl bg-white p-5 ring-1 ring-slate-200"><div className="flex items-center justify-between"><h2 className="font-semibold">Appearance</h2><Soon /></div></section>
        <p className="rounded-2xl bg-blue-50 p-4 text-sm text-blue-800">Verify safety numbers with your contacts to make sure nobody is intercepting your messages.</p>
        <LogoutButton className="rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-700" />
        <section id="danger" aria-labelledby="danger-h" className="rounded-2xl bg-white p-5 ring-1 ring-red-200">
          <h2 id="danger-h" className="mb-3 font-semibold text-red-700">Delete account</h2>
          <DeleteAccount />
        </section>
      </div>
    </main>
  );
}
