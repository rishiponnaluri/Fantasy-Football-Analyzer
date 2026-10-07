import type { Metadata } from 'next';
import { Barlow_Condensed, Manrope } from 'next/font/google';
import './globals.css';
import { PlayerQuickViewProvider } from '@/components/player-quick-view';
const displayFont = Barlow_Condensed({ subsets: ['latin'], weight: ['600', '700', '800'], variable: '--font-sports-display' });
const uiFont = Manrope({ subsets: ['latin'], weight: ['400', '500', '600', '700', '800'], variable: '--font-sports-ui' });
export const metadata: Metadata = { title: 'Fantasy Football Analyzer', description: 'Real ESPN fantasy football data, projections, and matchup analysis.' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" data-scroll-behavior="smooth" className={`${displayFont.variable} ${uiFont.variable}`}><body><PlayerQuickViewProvider>{children}</PlayerQuickViewProvider></body></html>;
}
