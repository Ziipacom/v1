import type { Metadata } from 'next';
import './globals.css';
import { PlatformNotice } from '@/components/platform-notice';
export const metadata: Metadata = {
  title: 'Ziipa — More than a feed. A world of yours.',
  description:
    'Discover video, music, and games. Create, edit, and share your media in Ziipa Studio.',
  icons: { icon: { url: '/brand/ziipa-favicon.png', type: 'image/png', sizes: '1080x1080' } },
  metadataBase: new URL('https://ziipa.com'),
  openGraph: {
    title: 'Ziipa — More than a feed. A world of yours.',
    description:
      'Discover video, music, and games. Create, edit, and share your media in Ziipa Studio.',
    type: 'website',
    images: [
      {
        url: '/brand/ziipa-logo.png',
        width: 9446,
        height: 3104,
      },
    ],
  },
  twitter: {
    card: 'summary',
    title: 'Ziipa — More than a feed. A world of yours.',
    description:
      'Create, edit, and share your media in Ziipa Studio.',
    images: ['/brand/ziipa-logo.png'],
  },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body><PlatformNotice />{children}</body>
    </html>
  );
}
