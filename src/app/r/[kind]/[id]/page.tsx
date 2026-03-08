import { notFound, redirect } from 'next/navigation';
import { fetchMissionControlItemById, mapRouteKindToTypedId } from '@/lib/mcp/search';
import { getCanonicalAppUrl } from '@/lib/mcp/config';
import { createSupabaseServerClient } from '@/lib/supabase/server';

interface ReaderPageProps {
  params: Promise<{
    kind: string;
    id: string;
  }>;
}

function prettyPrint(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

export default async function ReaderPage({ params }: ReaderPageProps) {
  const { kind, id } = await params;
  const typedId = mapRouteKindToTypedId(kind, decodeURIComponent(id));
  if (!typedId) {
    notFound();
  }

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/r/${kind}/${id}`)}`);
  }

  const item = await fetchMissionControlItemById(
    supabase,
    user.id,
    typedId,
    getCanonicalAppUrl()
  );

  if (!item) {
    notFound();
  }

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Mission Control Record</p>
        <h1 className="text-3xl font-semibold text-foreground">{item.title}</h1>
        <p className="font-mono text-xs text-muted-foreground">{item.id}</p>
      </header>

      <section className="rounded-card border border-stroke bg-panel p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">Content</h2>
        <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">{prettyPrint(item.text)}</pre>
      </section>

      {item.metadata ? (
        <section className="rounded-card border border-stroke bg-panel p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">Metadata</h2>
          <pre className="whitespace-pre-wrap break-words font-mono text-sm text-foreground">
            {prettyPrint(item.metadata)}
          </pre>
        </section>
      ) : null}
    </main>
  );
}
