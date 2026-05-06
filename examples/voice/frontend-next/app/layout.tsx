import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'actor-ts voice — Next.js',
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
