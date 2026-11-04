import type { Metadata } from 'next';
import { Geist } from 'next/font/google';
import './globals.css';
import { PlayerQuickViewProvider } from '@/components/player-quick-view';
import { PlayerScheduleProvider } from '@/components/player-projection';
import PointerInteractionLayer from '@/components/pointer-interaction-layer';
const uiFont = Geist({ subsets: ['latin'], variable: '--font-sports-ui' });
export const metadata: Metadata = { title: 'Fantasy Football Analyzer', description: 'Real ESPN fantasy football data, projections, and matchup analysis.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" className={uiFont.variable}><body><PointerInteractionLayer/><PlayerScheduleProvider><PlayerQuickViewProvider>{children}</PlayerQuickViewProvider></PlayerScheduleProvider></body></html>;
}
