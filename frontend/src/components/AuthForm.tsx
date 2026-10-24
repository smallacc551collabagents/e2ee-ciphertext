"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { ApiError, signin, signup } from "@/lib/api/client";
import { safeNext } from "@/lib/safe-next";
import { credentialsSchema, PASSWORD_MIN } from "@/lib/api/schemas";

type Mode = "login" | "signup";
type FieldErrors = Partial<Record<"username" | "password", string>>;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useSearchParams();
  const id = useId();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const isSignup = mode === "signup";

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const parsed = credentialsSchema.safeParse({ username: fd.get("username"), password: fd.get("password") });
    if (!parsed.success) {
      const f = parsed.error.flatten().fieldErrors;
      setFieldErrors({ username: f.username?.[0], password: f.password?.[0] });
      return;
    }
    setFieldErrors({});
    setPending(true);
    try {
      await (isSignup ? signup : signin)(parsed.data);
      router.replace(safeNext(params.get("next")));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-sm ring-1 ring-slate-200">
        <h1 className="text-2xl font-semibold">{isSignup ? "Create your account" : "Sign in"}</h1>
        <p className="mt-1 flex items-center gap-1 text-sm text-slate-500">
          <span aria-hidden>🔒</span> Your private keys stay on your devices
        </p>
        <form className="mt-6 space-y-4" onSubmit={onSubmit} noValidate aria-busy={pending}>
          {error && (
            <div role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</div>
          )}
          <div>
            <label htmlFor={`${id}-u`} className="block text-sm font-medium">Username</label>
            <input id={`${id}-u`} name="username" autoComplete="username" required
              aria-invalid={Boolean(fieldErrors.username)} aria-describedby={fieldErrors.username ? `${id}-ue` : undefined}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {fieldErrors.username && <p id={`${id}-ue`} className="mt-1 text-xs text-red-600">{fieldErrors.username}</p>}
          </div>
          <div>
            <label htmlFor={`${id}-p`} className="block text-sm font-medium">Password</label>
            <input id={`${id}-p`} name="password" type="password" required minLength={PASSWORD_MIN}
              autoComplete={isSignup ? "new-password" : "current-password"}
              aria-invalid={Boolean(fieldErrors.password)} aria-describedby={fieldErrors.password ? `${id}-pe` : undefined}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {fieldErrors.password && <p id={`${id}-pe`} className="mt-1 text-xs text-red-600">{fieldErrors.password}</p>}
          </div>
          <button type="submit" disabled={pending}
            className="w-full rounded-md bg-indigo-600 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-60">
            {pending ? (isSignup ? "Creating account…" : "Signing in…") : isSignup ? "Create account" : "Sign in"}
          </button>
        </form>
        <p className="mt-6 text-center text-sm text-slate-600">
          {isSignup ? "Already have an account? " : "New here? "}
          <Link className="font-medium text-indigo-600 hover:underline" href={isSignup ? "/login" : "/signup"}>
            {isSignup ? "Sign in" : "Create an account"}
          </Link>
        </p>
      </div>
    </main>
  );
}
