'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

function isAuthRequiredError(message: string): boolean {
  return message.toLowerCase().includes('authentication required');
}

export function ErrorBanner({ message }: { message: string }) {
  const pathname = usePathname();
  const authRequired = isAuthRequiredError(message);

  return (
    <div className="rounded-lg border border-danger-border bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
      <p>{message}</p>
      {authRequired && (
        <Link
          href={`/login?next=${encodeURIComponent(pathname || '/')}`}
          className="mt-2 inline-flex rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white transition hover:opacity-90"
        >
          Go to sign in
        </Link>
      )}
    </div>
  );
}
