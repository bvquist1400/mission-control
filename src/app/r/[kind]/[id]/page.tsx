import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { briefMono, briefSans } from '@/components/briefs/fonts';
import { Markdown } from '@/components/markdown/Markdown';
import { TaskRecordPage } from '@/components/portfolio/TaskRecordPage';
import { fetchMissionControlItemById, mapRouteKindToTypedId } from '@/lib/mcp/search';
import { getCanonicalAppUrl } from '@/lib/mcp/config';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { buildTaskPageView } from '@/lib/task-page';
import { loadTaskPageInput } from '@/lib/task-page-queries';
import '@/components/briefs/brief-page.css';
import '@/components/markdown/markdown.css';
import '@/components/portfolio/portfolio.css';

export const metadata: Metadata = { title: 'Record · Baseline' };

interface ReaderPageProps {
  params: Promise<{
    kind: string;
    id: string;
  }>;
}

const KIND_LABELS: Record<string, string> = {
  task: 'Task',
  note: 'Note',
  application: 'Application',
  project: 'Project',
  sprint: 'Sprint',
  stakeholder: 'Stakeholder',
  commitment: 'Commitment',
  email: 'Email',
};

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export default async function ReaderPage({ params }: ReaderPageProps) {
  const { kind, id } = await params;

  if (kind === 'calendar') {
    redirect(`/calendar/events/${encodeURIComponent(id)}`);
  }

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

  // Tasks get the redesigned page (Portfolio slice 2); other records keep the reader.
  const taskInput = kind === 'task' ? await loadTaskPageInput(supabase, user.id, decodeURIComponent(id)) : null;
  if (kind === 'task' && !taskInput) {
    notFound();
  }

  const metadataEntries = Object.entries(item.metadata ?? {}).filter(
    ([key, value]) => key !== 'entity' && key !== 'status_line' && value !== null && value !== undefined && value !== ''
  );
  const simpleEntries = metadataEntries.filter(([, value]) => isPrimitive(value));
  const complexEntries = metadataEntries.filter(
    ([, value]) => !isPrimitive(value) && !(Array.isArray(value) && value.length === 0)
  );
  const status = typeof item.metadata?.status === 'string' ? item.metadata.status : null;
  const owner = item.metadata?.owner === 'brent' || item.metadata?.owner === 'agent' ? item.metadata.owner : null;
  const ownerLabel = typeof item.metadata?.owner_label === 'string' ? item.metadata.owner_label : null;
  const statusLine = typeof item.metadata?.status_line === 'string' ? item.metadata.status_line : null;
  // The text leads with "Where this stands: …" for MCP readers; the page shows it as a box instead.
  const standPrefix = statusLine ? `Where this stands: ${statusLine}` : null;
  const bodyText = standPrefix && item.text.startsWith(standPrefix)
    ? item.text.slice(standPrefix.length).trim()
    : item.text;

  const details = (
    <>
      {simpleEntries.length > 0 || complexEntries.length > 0 ? (
        <details className="pf-details">
          <summary>Details</summary>
          {simpleEntries.length > 0 ? (
            <dl className="pf-dl">
              {simpleEntries.map(([key, value]) => (
                <div key={key}>
                  <dt>{humanizeKey(key)}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {complexEntries.map(([key, value]) => (
            <div key={key} className="pf-raw">
              <span className="tile-k">{humanizeKey(key)}</span>
              <pre>{JSON.stringify(value, null, 2)}</pre>
            </div>
          ))}
          <p className="pf-id mono">{item.id}</p>
        </details>
      ) : (
        <p className="pf-id mono">{item.id}</p>
      )}
    </>
  );

  return (
    <div className={`brief-page pf ${briefSans.variable} ${briefMono.variable}`}>
      <div className={`page pf-record${taskInput ? ' pf-task' : ''}`}>
        <nav className="pf-top" aria-label="Baseline">
          <Link href="/" className="pf-back">
            <span aria-hidden="true">←</span> Baseline
          </Link>
          <Link href="/portfolio" className="pf-toplink">
            Portfolio
          </Link>
        </nav>

        {taskInput ? (
          <TaskRecordPage view={buildTaskPageView(taskInput)} details={details} />
        ) : (
          <>
            <header className="pf-record-head">
              <div className="eyebrow">
                <span className="code">{(KIND_LABELS[kind] ?? kind).toUpperCase()}</span>
                {status ? <span>{status}</span> : null}
                {owner ? <span>{owner === 'brent' ? 'Owner: You' : `Owner: ${ownerLabel ?? 'Agent'}`}</span> : null}
              </div>
              <h1>{item.title}</h1>
              {statusLine ? (
                <div className="pf-stand-box">
                  <span className="mono">WHERE THIS STANDS</span>
                  <span>{statusLine}</span>
                </div>
              ) : null}
            </header>

            <section className="tile pf-record-body" aria-label="Content">
              {bodyText ? <Markdown source={bodyText} /> : <p className="tile-p">No text on this record.</p>}
            </section>

            {details}
          </>
        )}
      </div>
    </div>
  );
}
