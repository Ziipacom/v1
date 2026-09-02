import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Ziipa — More than a feed. A world of yours.',
  description:
    'Discover video, music, gaming, and creator tools in Ziipa. Explore the interactive demo, try the creator web preview, and join the mobile app waitlist.',
  icons: { icon: '/brand/ziipa-logo.png' },
  metadataBase: new URL('https://ziipa.com'),
  openGraph: {
    title: 'Ziipa — More than a feed. A world of yours.',
    description:
      'Explore media discovery, creator tools, and a world of possibilities. Try the Ziipa web preview.',
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
      'Explore media discovery, creator tools, and the Ziipa web preview.',
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
      <body>{children}</body>
    </html>
  );
}
