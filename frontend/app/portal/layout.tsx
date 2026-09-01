import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Creator portal — Ziipa', description: 'Your Ziipa creator workspace for media, custom feeds, and local publishing.', robots: {index: false, follow: false} };
export default function PortalLayout({children}: {children: React.ReactNode}) { return children; }
