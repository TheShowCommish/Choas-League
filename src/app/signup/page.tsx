"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      // Picked up by the handle_new_user trigger to seed the profile.
      options: { data: { display_name: displayName.trim() } },
    });

    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }

    // With email confirmation switched on there is no session yet.
    if (!data.session) {
      setNotice("Check your email for a confirmation link, then sign in.");
      setBusy(false);
      return;
    }

    router.replace("/leagues");
    router.refresh();
  }

  return (
    <main className="mx-auto w-full max-w-sm flex-1 px-4 py-12">
      <h1 className="h1 mb-1">Create an account</h1>
      <p className="muted mb-6">
        One login per manager. Your commissioner will give you a join code.
      </p>

      <form onSubmit={onSubmit} className="card space-y-4">
        <div>
          <label className="label" htmlFor="name">
            Display name
          </label>
          <input
            id="name"
            className="input"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div>
          <label className="label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="muted mt-1 text-xs">At least 8 characters.</p>
        </div>

        {error && <p className="error-box">{error}</p>}
        {notice && <p className="ok-box">{notice}</p>}

        <button className="btn btn-primary w-full" disabled={busy}>
          {busy ? "Creating..." : "Create account"}
        </button>

        <p className="muted text-center">
          Already have one?{" "}
          <Link href="/login" className="text-accent underline">
            Sign in
          </Link>
        </p>
      </form>
    </main>
  );
}
