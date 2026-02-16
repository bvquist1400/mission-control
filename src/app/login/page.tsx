'use client';

import { FormEvent, Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { createSupabaseBrowserClient } from '@/lib/supabase';

function normalizeNextPath(input: string | null): string {
  if (!input || !input.startsWith('/')) {
    return '/calendar';
  }

  return input;
}

function formatAuthError(input: string | null): string | null {
  if (!input) {
    return null;
  }

  if (input === 'missing_code') {
    return 'Sign-in link was missing an auth code. Request a new link.';
  }

  if (input === 'auth_failed') {
    return 'Unable to complete sign-in. Request a new link.';
  }

  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nextPath = useMemo(() => normalizeNextPath(searchParams.get('next')), [searchParams]);
  const authError = useMemo(() => formatAuthError(searchParams.get('error')), [searchParams]);

  useEffect(() => {
    let active = true;

    async function checkSession() {
      const supabase = createSupabaseBrowserClient();
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!active) {
        return;
      }

      if (sessionError) {
        setError(sessionError.message);
        return;
      }

      if (data.session) {
        router.replace(nextPath);
      }
    }

    checkSession();

    return () => {
      active = false;
    };
  }, [nextPath, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const emailRedirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(nextPath)}`;
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo,
        },
      });

      if (otpError) {
        throw otpError;
      }

      setMessage('Check your email for a sign-in link.');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to send sign-in link');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sign in"
        description="Sign in with your work email to access calendar data securely."
      />

      <section className="max-w-xl rounded-card border border-stroke bg-panel p-6">
        <form className="space-y-4" onSubmit={handleSubmit}>
          <label htmlFor="email" className="block text-sm font-medium text-foreground">
            Work email
          </label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-lg border border-stroke bg-white px-3 py-2 text-sm text-foreground outline-none focus:border-accent"
            placeholder="name@company.com"
            autoComplete="email"
          />

          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? 'Sending link...' : 'Send magic link'}
          </button>
        </form>

        {message ? <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p> : null}
        {error || authError ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error ?? authError}</p>
        ) : null}

        <p className="mt-4 text-xs text-muted-foreground">
          Calendar access requires an authenticated session. After sign-in, you will return to{' '}
          <code className="rounded bg-panel-muted px-1.5 py-0.5 text-xs">{nextPath}</code>.
        </p>

        <div className="mt-4">
          <Link href="/calendar" className="text-sm font-semibold text-accent underline underline-offset-2">
            Back to calendar
          </Link>
        </div>
      </section>
    </div>
  );
}

function LoginFallback() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Sign in"
        description="Sign in with your work email to access calendar data securely."
      />
      <section className="max-w-xl rounded-card border border-stroke bg-panel p-6">
        <p className="text-sm text-muted-foreground">Loading sign-in form...</p>
      </section>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}
