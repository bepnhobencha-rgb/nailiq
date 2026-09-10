'use client';
import { useState, type CSSProperties } from 'react';
import { bookingEn } from '@/shared/i18n/booking/en';
import { bookingVi } from '@/shared/i18n/booking/vi';
import { BookingFlowErrorBoundary } from '@/components/booking/BookingFlowErrorBoundary';
import { buildBookingThemeVars } from '@/shared/booking/bookingThemeVars';
import type { BookingSalonMeta } from '@/shared/booking/loadBookingServices';

// Boundary only reads salon.id. No real salon or booking data is loaded.
const salon = { id: 'qa-boundary-synthetic' } as BookingSalonMeta;
function Flow({onConfirm,persistent}:{onConfirm:()=>void;persistent:boolean}) {
  const [crashed,setCrashed] = useState(false);
  if (crashed || persistent) throw new Error('QA synthetic booking render failure');
  return <section aria-label="Synthetic booking flow">
    <p>Booking flow ready</p>
    <button onClick={()=>setCrashed(true)}>Simulate render failure</button>
    <button onClick={()=>{onConfirm();setCrashed(true);}}>Simulate confirmation then render failure</button>
  </section>;
}
export default function Fixture() {
  const [language,setLanguage] = useState<'en'|'vi'>('en');
  const [theme,setTheme] = useState<'light'|'dark'>('light');
  const [committed,setCommitted] = useState(0);
  const [persistent,setPersistent] = useState(false);
  return <main style={{...buildBookingThemeVars('#D4AF37',theme),minHeight:'100vh',padding:16,background:'var(--booking-bg)',color:'var(--booking-text)'} as CSSProperties}>
    <aside aria-label="QA controls" className="mx-auto max-w-xl space-y-3">
      <h1>Local booking error fixture</h1>
      <p>Synthetic component state only. No real booking, Auth, database or provider.</p>
      <label>Language <select aria-label="Language" value={language} onChange={e=>setLanguage(e.target.value as 'en'|'vi')}><option value="en">English</option><option value="vi">Tiếng Việt</option></select></label>
      <label>Theme <select aria-label="Theme" value={theme} onChange={e=>setTheme(e.target.value as 'light'|'dark')}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <label><input type="checkbox" checked={persistent} onChange={e=>setPersistent(e.target.checked)}/> Persistent render failure</label>
      <p data-testid="synthetic-confirmations">Synthetic confirmations: {committed}</p>
    </aside>
    <div className="mx-auto max-w-xl" lang={language}>
      <BookingFlowErrorBoundary shopSlug="qa-boundary" salon={salon} messages={(language === "vi" ? bookingVi : bookingEn).errorBoundary}>
        <Flow onConfirm={()=>setCommitted(n=>n+1)} persistent={persistent}/>
      </BookingFlowErrorBoundary>
    </div>
  </main>;
}
