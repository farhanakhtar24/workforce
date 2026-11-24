import type { Metadata, Viewport } from 'next';
import { ThemeProvider } from 'next-themes';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Workforce',
    template: '%s · Workforce',
  },
  description:
    'A local agent workspace: streaming chat with four agents plus memory, work documents, delegations and schedules.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Light/dark via `next-themes` with the class attribute: system default,
 * persisted localStorage, and the injected pre-paint script prevents theme
 * flash / hydration mismatch (`suppressHydrationWarning` on <html> is the
 * documented next-themes contract).
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
