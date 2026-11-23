import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/noto-kufi-arabic/600.css';
import '@fontsource/noto-kufi-arabic/700.css';
import './globals.css';
import type { ReactNode } from 'react';

export const metadata = { title: 'بُنيان — منصة البنية المؤسسية', description: 'منصة البنية المؤسسية للجهات الحكومية' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
