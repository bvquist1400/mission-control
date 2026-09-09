'use client';

import { FormEvent, Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { createSupabaseBrowserClient } from '@/lib/supabase';
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";

type LoginMethod = 'magic-link' | 'password';

function normalizeNextPath(input: string | null): string {
  if (!input || !input.startsWith('/')) {
    return '/';
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
  const [method, setMethod] = useState<LoginMethod>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);
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

      setCheckingSession(false);

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

  async function handlePasswordLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (signInError) {
        throw signInError;
      }

      router.replace(nextPath);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  }

  async function handleMagicLink(event: FormEvent<HTMLFormElement>) {
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

  if (checkingSession) {
    return (
      <div className="space-y-6">
        <PageHeader title="Sign in" description="Checking session..." />
        <section className="max-w-md rounded-card border border-stroke bg-panel p-6">
          <p className="text-sm text-muted-foreground">Loading...</p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sign in"
        description="Sign in to access Baseline."
      />

      <section className="max-w-md rounded-card border border-stroke bg-panel p-6">
        {/* Method toggle */}
        <div className="mb-6 flex rounded-lg border border-stroke p-1">
          <Button variant="toggle" active={method === 'password'} className="flex-1"
            onClick={() => { setMethod('password'); setError(null); setMessage(null); }}>
            Password
          </Button>
          <Button variant="toggle" active={method === 'magic-link'} className="flex-1"
            onClick={() => { setMethod('magic-link'); setError(null); setMessage(null); }}>
            Magic Link
          </Button>
        </div>

        {method === 'password' ? (
          <form className="space-y-4" onSubmit={handlePasswordLogin}>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                tone="muted"
                className="mt-1"
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-foreground">
                Password
              </label>
              <Input
                tone="muted"
                className="mt-1"
                id="password"
                type="password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
              />
            </div>
            <Button variant="primary" size="lg" className="w-full" type="submit" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>
        ) : (
          <form className="space-y-4" onSubmit={handleMagicLink}>
            <div>
              <label htmlFor="magic-email" className="block text-sm font-medium text-foreground">
                Email
              </label>
              <Input
                tone="muted"
                className="mt-1"
                id="magic-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <Button variant="primary" size="lg" className="w-full" type="submit" disabled={loading}>
              {loading ? 'Sending link...' : 'Send magic link'}
            </Button>
          </form>
        )}

        {message ? (
          <p className="mt-4 rounded-lg border border-success-border bg-success-soft px-3 py-2 text-sm text-success">{message}</p>
        ) : null}
        {error || authError ? (
          <p className="mt-4 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger">{error ?? authError}</p>
        ) : null}

        <p className="mt-4 text-xs text-muted-foreground">
          After sign-in, you will be redirected to{' '}
          <code className="rounded bg-panel-muted px-1.5 py-0.5 text-xs">{nextPath}</code>
        </p>
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
