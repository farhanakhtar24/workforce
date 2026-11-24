import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Status pill over the shadcn Badge: keeps the original lowercase
 * `data-status` attribute on the rendered element (old component contract)
 * while mapping statuses to soft status tints. Unknown statuses fall back to
 * the neutral outline tint — never a fake "ok" color.
 */

const STATUS_TONES: Readonly<Record<string, string>> = {
  pending: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  retrying: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  running: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  completed: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  ready: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  active: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200',
  review: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200',
  timeout: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200',
  dead_letter: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200',
};

export function StatusBadge({
  status,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, 'variant'> & { status: string }): React.ReactElement {
  const tone =
    STATUS_TONES[status] ?? 'border-border bg-background text-muted-foreground';
  return (
    <Badge variant="outline" data-status={status} className={cn('font-semibold tracking-wide', tone, className)} {...props} />
  );
}

export default StatusBadge;
