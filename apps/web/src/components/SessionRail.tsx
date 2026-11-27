'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { AgentAvatar } from '@/components/AgentAvatar';
import { Button } from '@/components/ui/button';
import { fetchDelegations, delegationStatusLabel, type Delegation } from '@/lib/delegations';
import { childChatUrlFor } from '@/lib/delegations';
import { resolveApiBaseUrl } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  latestAssistantUsage,
  contextModelPercent,
  detailsModelPercentSource,
  countToolParts,
  railBucketLine,
  RAIL_EMPTY_TURN_TEXT,
  RAIL_PROVIDER_LABEL,
  type RailMessageLike,
  type RailUsage,
} from '@/lib/session-rail';
import {
  MODEL_PROVIDER_LABEL,
  MODEL_FIELD_UNKNOWN,
  type ModelCatalogResult,
  type ModelDetailsInfo,
} from '@/lib/models';
import {
  formatUsageBucket,
  formatUsageCost,
  formatUsageTotals,
  type UsageSummary,
} from '@/lib/chat-usage';
import type { WebAgentMode, WebAgentSlug } from '@/lib/agents';

/**
 * RIGHT session context rail (Farhan's request 5) — REAL data only:
 * - Model: provider + selected model + agent + mode + bounded latest-request
 *   context percentage (latest assistant `metadata.usage.inputTokens` over
 *   the LATEST ASSISTANT'S ACTUAL model's real `contextLength` — the model
 *   that served the reply, never the selected next-turn model; unknown when
 *   either side is missing or the cached details do not match the usage's
 *   model id).
 * - Usage: exact session input/output/total, per-model buckets, configured
 *   estimate or the honest reason (never $0).
 * - Latest turn: input/output/total of the newest assistant reply.
 * - Tools: count derived from the latest assistant's actual parts.
 * - Sub-agents: real delegation rows for THIS chat with target/mode/status +
 *   child links; polls only while rows are pending/running and the tab is
 *   visible, non-overlapping, sequence-guarded, stops on error.
 *
 * Unavailable OpenChamber-style metrics (cache hits, monthly quotas,
 * tokens/sec, elapsed/model timing, files changed) are omitted, never
 * fabricated.
 */

const DELEGATION_POLL_MS = 2000;

export interface SessionRailProps {
  apiBaseUrl: string;
  slug: WebAgentSlug;
  chatId: string;
  mode: WebAgentMode;
  catalog: ModelCatalogResult | null;
  currentModel: string | null;
  /** Details of the LATEST ASSISTANT'S ACTUAL model (or null until loaded). */
  details: ModelDetailsInfo | null;
  usage: UsageSummary | null;
  usageError: string | null;
  onReloadUsage: () => void;
  messages: ReadonlyArray<RailMessageLike>;
  className?: string;
}

export function SessionRail(props: SessionRailProps): React.ReactElement {
  // Never mix models: divide by the context of the model that ACTUALLY
  // served the latest request (details.modelId must match usage.modelId);
  // anything else renders as Not reported until real details arrive.
  const latest = railUsageLatest(props.messages);
  const context = contextModelPercent(
    latest,
    detailsModelPercentSource(props.details, latest?.modelId ?? null),
  );
  const toolCount = railToolCount(props.messages);

  return (
    <section
      aria-label="Session context"
      className={cn(
        'flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain rounded-t-2xl border-t border-x border-border bg-card px-3 pb-3 pt-2.5 text-[0.8rem] text-card-foreground shadow-sm min-w-0',
        props.className,
      )}
    >
      <p className="m-0 mb-1 flex items-center justify-between text-[0.7rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
        Session
      </p>

      {/* Model + agent + mode + provider + bounded context %. */}
      <RailSection title="Model">
        <dl className="m-0 text-[0.8rem]">
          <div className="flex justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="truncate text-right">{MODEL_PROVIDER_LABEL}</dd>
          </div>
          <div className="flex justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="truncate text-right" title={props.currentModel ?? undefined}>
              {props.currentModel ?? MODEL_FIELD_UNKNOWN}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="flex items-center gap-1 truncate text-right">
              <AgentAvatar agent={props.slug} size={14} />
              {props.slug}
            </dd>
          </div>
          <div className="flex justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">Mode</dt>
            <dd className="text-right">{props.mode === 'plan' ? 'Plan' : 'Action'}</dd>
          </div>
          <div className="flex justify-between gap-2 py-0.5">
            <dt className="text-muted-foreground">Context (latest request)</dt>
            <dd className="tabular-nums text-right">
              {context === null ? 'Not reported' : `${context}%`}
            </dd>
          </div>
        </dl>
      </RailSection>

      {/* Session usage (exact, honest cost). */}
      <RailSection
        title="Usage"
        trailing={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Refresh session usage"
            title="Refresh session usage"
            onClick={props.onReloadUsage}
          >
            <RefreshCw size={12} aria-hidden="true" />
          </button>
        }
      >
        {props.usage !== null ? (
          <>
            <p className="m-0 mb-1" aria-label="Exact session token totals">
              {formatUsageTotals(props.usage)}
            </p>
            {props.usage.models.length > 0 && (
              <ul className="m-0 mb-1 list-none p-0">
                {props.usage.models.map((bucket) => (
                  <li key={bucket.modelId} className="m-0 py-0.5 break-words">
                    {formatUsageBucket(bucket)}
                  </li>
                ))}
              </ul>
            )}
            <p className="m-0">{renderCost(props.usage)}</p>
          </>
        ) : (
          <p role="status" aria-live="polite" className="m-0">
            {props.usageError !== null ? props.usageError : `${RAIL_PROVIDER_LABEL} usage loading…`}
          </p>
        )}
      </RailSection>

      {/* Latest turn (real per-message metadata). */}
      <RailSection title="Latest turn">
        {latest !== null ? (
          <dl className="m-0 text-[0.8rem]">
            <div className="flex justify-between gap-2 py-0.5">
              <dt className="text-muted-foreground">Input</dt>
              <dd className="tabular-nums">{latest.inputTokens.toLocaleString('en-US')}</dd>
            </div>
            <div className="flex justify-between gap-2 py-0.5">
              <dt className="text-muted-foreground">Output</dt>
              <dd className="tabular-nums">{latest.outputTokens.toLocaleString('en-US')}</dd>
            </div>
            {latest.totalTokens !== null && (
              <div className="flex justify-between gap-2 py-0.5">
                <dt className="text-muted-foreground">Total</dt>
                <dd className="tabular-nums">{latest.totalTokens.toLocaleString('en-US')}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="m-0 text-muted-foreground">{RAIL_EMPTY_TURN_TEXT}</p>
        )}
      </RailSection>

      {/* Tools derived from real parts. */}
      <RailSection title="Tools">
        <p className="m-0" aria-label="Tool calls in the latest assistant reply">
          {toolCount === 0 ? 'None in the latest reply' : `${toolCount} call${toolCount === 1 ? '' : 's'} in the latest reply`}
        </p>
      </RailSection>

      {/* Sub-agents (real rows, bounded poll). */}
      <RailSection title="Sub-agents">
        <RailDelegations apiBaseUrl={props.apiBaseUrl} chatId={props.chatId} />
      </RailSection>

      <p className="m-0 border-t border-border pt-2 text-[0.68rem] text-muted-foreground">
        Real data only — cache, quotas, speed and timing are not reported by the API.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function renderCost(usage: UsageSummary): string {
  const cost = formatUsageCost(usage);
  return cost.kind === 'estimated' ? cost.value : cost.text;
}

function railUsageLatest(messages: ReadonlyArray<RailMessageLike>): RailUsage | null {
  return latestAssistantUsage(messages);
}

function railToolCount(messages: ReadonlyArray<RailMessageLike>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      return countToolParts(messages[index].parts);
    }
  }
  return 0;
}

function contextLengthOf(currentModel: string | null, details: ModelDetailsInfo | null): number | null {
  if (currentModel === null || details === null) return null;
  if (details.modelId !== currentModel) return null;
  return details.contextLength;
}

function RailSection({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="border-b border-border py-2.5 first:pt-0.5">
      <p className="m-0 mb-1.5 flex items-center justify-between text-[0.68rem] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {title}
        {trailing}
      </p>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/**
 * Real delegation rows for THIS chat (parent-keyed REST), polled only while a
 * row is pending/running and the tab is visible; non-overlapping requests,
 * sequence-guarded, stops on error (same discipline as the Delegations page).
 */
function RailDelegations({ apiBaseUrl, chatId }: { apiBaseUrl: string; chatId: string }): React.ReactElement {
  const [rows, setRows] = useState<ReadonlyArray<Delegation>>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);
  const pollInFlight = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current;
    const result = await fetchDelegations({ apiBaseUrl, parentChatId: chatId, limit: 50 });
    if (seq !== requestSeq.current) return;
    if (result.ok) {
      setRows(result.delegations);
      setState('ready');
      setError(null);
    } else {
      setState('error');
      setError(result.error);
    }
  }, [apiBaseUrl, chatId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = rows.some((row) => row.status === 'pending' || row.status === 'running');
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void refresh().finally(() => {
        pollInFlight.current = false;
      });
    }, DELEGATION_POLL_MS);
    return () => {
      clearInterval(timer);
      pollInFlight.current = false;
    };
  }, [hasActive, refresh]);

  if (state === 'error') {
    return (
      <p role="alert" className="m-0 text-[0.72rem] text-destructive">
        {error ?? 'Delegations are temporarily unavailable.'}
      </p>
    );
  }
  if (state === 'loading' && rows.length === 0) {
    return (
      <p aria-busy="true" className="m-0 flex items-center gap-1.5 text-[0.72rem] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" aria-hidden="true" />
        Loading delegations…
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="m-0 text-[0.72rem] text-muted-foreground">No delegations from this chat yet.</p>;
  }
  return (
    <ul className="m-0 list-none p-0" aria-label="Delegations from this chat">
      {rows.map((row) => {
        const child = childChatUrlFor(row.childChatId, row.targetAgent);
        return (
          <li key={row.id} className="m-0 mb-1 rounded-md border border-border bg-muted/50 px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <AgentAvatar agent="orchestrator" size={14} />
              <span aria-hidden="true" className="text-muted-foreground">→</span>
              <AgentAvatar agent={row.targetAgent} size={14} />
              <span className="min-w-0 flex-1 truncate font-medium">{row.targetAgent}</span>
              <span className="shrink-0 text-[0.62rem] uppercase">{delegationStatusLabel(row.status)}</span>
            </div>
            <p className="m-0 mt-0.5 flex items-center justify-between gap-2 text-[0.62rem] text-muted-foreground">
              <span>{row.mode}</span>
              <span className="tabular-nums">depth {row.depth}</span>
            </p>
            {child !== null && (
              <a
                className="mt-1 inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                href={child.href}
              >
                <ExternalLink size={11} aria-hidden="true" />
                Open child chat
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

