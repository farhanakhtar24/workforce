'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search, X, Check, ChevronRight, Lock } from 'lucide-react';
import { Popover, Tooltip } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  filterModels,
  formatModelTooltipLines,
  inputModality,
  MODEL_FIELD_UNKNOWN,
  type ModelDetailsInfo,
  type ModelInfo,
} from '@/lib/models';

/**
 * Reference-style model picker (Farhan): a rich, accessible Radix popover
 * with a search box, the REAL filtered catalog, a selected check, and locked
 * Kimi rows (disabled, with the server's lock reason visible on the row).
 *
 * Hover/focus on a row opens a collision-aware side tooltip with EXACTLY the
 * OpenChamber fields: Provider; Capabilities; Input; Output; Cost
 * ($/1M tokens with real rates, else honest `Not configured`). Details are
 * prefetched lazily (hover/focus/selection); the picker itself carries no
 * detail card — the Session rail holds the selected model's full card.
 */

export interface ModelPickerProps {
  models: ReadonlyArray<ModelInfo>;
  catalogError: string | null;
  loading: boolean;
  value: string | null;
  disabled: boolean;
  saving: boolean;
  /** True while the caller's lazy details fetch for the hovered row is in flight. */
  detailsLoading: boolean;
  /** Hover/focus/selection prefetch (caller-owned cache + seq guard). */
  ensureDetails: (modelId: string) => void;
  getDetails: (modelId: string) => ModelDetailsInfo | null;
  onSelect: (modelId: string) => void;
}

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const rows = filterModels(props.models, query);
  const selected = props.models.find((m) => m.id === props.value) ?? null;
  const triggerLabel =
    selected !== null ? selected.name : props.catalogError !== null ? 'Model unavailable' : 'Model…';

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-56 justify-between gap-1.5 font-normal"
          disabled={props.disabled}
          aria-label={`Model for the next reply: ${triggerLabel}. Opens the model picker.`}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          {props.saving ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 rotate-90 text-muted-foreground" aria-hidden="true" />
          )}
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[22rem] max-w-[92vw] rounded-xl border border-border bg-card p-3 text-card-foreground shadow-md"
          onOpenAutoFocus={(event) => {
            // Radix would focus the first tabbable item; we explicitly focus
            // the SEARCH input on open for a predictable flow.
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <Popover.Close
            className="absolute top-2 right-2 inline-flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
            aria-label="Close model picker"
          >
            <X size={13} aria-hidden="true" />
          </Popover.Close>
          <p className="m-0 mb-2 text-[0.7rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            Model
          </p>
          <div className="relative mb-2">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              ref={searchRef}
              aria-label="Search models"
              placeholder="Search models…"
              className="h-8 pl-7 text-[0.85rem]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && rows.length > 0) {
                  event.preventDefault();
                  const row = rows[0];
                  if (!row.locked && row.id !== props.value) props.onSelect(row.id);
                  setOpen(false);
                }
              }}
            />
          </div>
          {props.catalogError !== null && (
            <p
              role="alert"
              className="m-0 mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
            >
              {props.catalogError}
            </p>
          )}
          <div role="listbox" aria-label="Available models" className="max-h-64 overflow-y-auto overscroll-contain">
            {props.loading && (
              <p
                aria-busy="true"
                className="m-0 flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground"
              >
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                Loading models…
              </p>
            )}
            {!props.loading && rows.length === 0 && (
              <p className="m-0 rounded-md px-2 py-1.5 text-xs text-muted-foreground">
                No models match “{query.trim()}”.
              </p>
            )}
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <li key={row.id}>
                  <Tooltip.Provider delayDuration={150} skipDelayDuration={0}>
                    <Tooltip.Root>
                      <Tooltip.Trigger asChild>
                        <button
                          type="button"
                          aria-selected={row.id === props.value ? 'true' : 'false'}
                          role="option"
                          disabled={row.locked || props.disabled || props.saving}
                          className={cn(
                            'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors',
                            'text-card-foreground hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:outline-ring',
                            row.id === props.value && 'bg-accent font-medium',
                            row.locked && 'cursor-not-allowed opacity-55 hover:bg-transparent',
                          )}
                          onMouseEnter={() => props.ensureDetails(row.id)}
                          onFocus={() => props.ensureDetails(row.id)}
                          onClick={() => {
                            if (row.locked) return;
                            props.ensureDetails(row.id);
                            if (row.id !== props.value) props.onSelect(row.id);
                            setOpen(false);
                          }}
                        >
                          <span className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate">{row.name}</span>
                            <span aria-hidden="true" className="shrink-0 text-muted-foreground">
                              {row.locked ? (
                                <Lock size={12} aria-hidden="true" />
                              ) : row.id === props.value ? (
                                <Check size={13} aria-hidden="true" />
                              ) : null}
                            </span>
                          </span>
                          {/* Server lock reason IS visible on the row itself. */}
                          {row.locked && row.lockReason !== null && row.lockReason !== undefined && (
                            <span className="block truncate text-[0.68rem] font-normal text-destructive">
                              {row.lockReason}
                            </span>
                          )}
                        </button>
                      </Tooltip.Trigger>
                      <Tooltip.Portal>
                        <Tooltip.Content
                          side="right"
                          sideOffset={8}
                          collisionPadding={10}
                          className="z-60 max-w-[17rem] rounded-lg border border-border bg-popover px-3 py-2 text-[0.75rem] text-popover-foreground shadow-md"
                        >
                          <ModelTooltipRow label="Provider" value="Ollama Cloud" />
                          <TooltipLines
                            details={props.getDetails(row.id)}
                            loading={props.detailsLoading}
                          />
                        </Tooltip.Content>
                      </Tooltip.Portal>
                    </Tooltip.Root>
                  </Tooltip.Provider>
                </li>
              ))}
            </ul>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * Tooltip rows re-render per call with the CURRENT fetched details; the
 * tooltip itself stays mounted on hover/focus, so live-arrived details
 * appear without extra wiring. Exactly five fields, honest fallbacks.
 */
function TooltipLines({
  details,
  loading,
}: {
  details: ModelDetailsInfo | null;
  loading: boolean;
}): React.ReactElement {
  // Real details-loading state: while the lazy fetch is in flight with no
  // cached details, the field VALUES show an honest loading note — the
  // five-field layout stays, nothing is fabricated. When details exist (or
  // the fetch resolves without reporting a field), values are real or
  // 'Not reported'.
  const value = (real: string, whenMissing: string): string =>
    details !== null ? real : loading ? 'Loading…' : whenMissing;
  return (
    <>
      <ModelTooltipRow
        label="Capabilities"
        value={value(
          details !== null && details.capabilities !== null && details.capabilities.length > 0
            ? details.capabilities.join(', ')
            : MODEL_FIELD_UNKNOWN,
          'Loading…',
        )}
      />
      <ModelTooltipRow
        label="Input"
        value={value(inputModality(details), 'Loading…')}
      />
      <ModelTooltipRow label="Output" value={value('text', 'Loading…')} />
      <ModelTooltipRow
        label="Cost"
        value={value(formatPricingLine(details), 'Loading…')}
      />
    </>
  );
}

function formatPricingLine(details: ModelDetailsInfo | null): string {
  const price = details !== null ? details.pricing : null;
  return price !== null
    ? `$${price.inputUsdPerMillion} in / $${price.outputUsdPerMillion} out per 1M tokens`
    : 'Not configured';
}

function ModelTooltipRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex justify-between gap-3 py-0.5">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right break-words">{value}</span>
    </div>
  );
}

export default ModelPicker;
