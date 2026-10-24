import Link from "next/link";

/** E2EE-73: shown when the backend is down (5xx/timeout) instead of redirecting. */
export function BackendUnavailable() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div role="alert" data-testid="backend-unavailable" className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
        <h1 className="text-lg font-semibold">We can’t reach the server</h1>
        <p className="mt-2 text-sm text-slate-600">Your messages are safe. Please try again in a moment.</p>
        <Link href="/chat" prefetch={false} className="mt-6 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          Try again
        </Link>
      </div>
    </main>
  );
}
