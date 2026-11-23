import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/noto-kufi-arabic/600.css';
import '@fontsource/noto-kufi-arabic/700.css';
import './globals.css';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/lib/i18n';

export const metadata = { title: 'بُنيان — Bunyan', description: 'منصة البنية المؤسسية للجهات الحكومية — Enterprise architecture platform for government entities' };

// Arabic is the default. This runs before the page paints, so an English user never sees a right-to-left flash.
const setDir = `try{if(localStorage.getItem('bunyan.lang')==='en'){document.documentElement.lang='en';document.documentElement.dir='ltr'}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: setDir }} /></head>
      <body><LocaleProvider>{children}</LocaleProvider></body>
    </html>
  );
}
