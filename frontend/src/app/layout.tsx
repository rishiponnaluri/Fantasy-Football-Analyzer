import type { Metadata } from 'next';
import './globals.css';
import { PlayerQuickViewProvider } from '@/components/player-quick-view';
export const metadata: Metadata = { title: 'Fantasy Football Analyzer', description: 'Real ESPN fantasy football data, projections, and matchup analysis.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth"><body><PlayerQuickViewProvider>{children}</PlayerQuickViewProvider></body></html>;
}
