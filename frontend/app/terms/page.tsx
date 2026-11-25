import type { Metadata } from 'next';
import Link from 'next/link';
import { PolicyPage } from '@/components/policy-page';

export const metadata: Metadata = {
  title: 'Ziipa Terms of Use',
  description: 'Terms for using your Ziipa account and sharing media.',
};

export default function TermsPage() {
  return (
    <PolicyPage title="Ziipa Terms of Use">
      <p>Ziipa is operated by Niche Labs LLC.</p>
      <section>
        <h2>Your account</h2>
        <p>
          Use accurate account information, keep your sign-in details private,
          and follow the <Link href="/community">Community Rules</Link>.
          You are responsible for activity on your account. Contact support if
          you think someone else has accessed it.
        </p>
      </section>
      <section>
        <h2>Your media</h2>
        <p>
          You keep ownership of the media you create. Upload only work you own
          or have permission to share. By uploading, you allow Ziipa to store
          and process your media to provide the service. By publishing, you
          also allow Ziipa to show it according to the visibility you choose.
        </p>
      </section>
      <section>
        <h2>Connected services</h2>
        <p>
          Third-party services have their own terms and may have account or
          regional requirements. Review the destination before sharing media
          or broadcasting. You can disconnect services in Ziipa.
        </p>
      </section>
      <section>
        <h2>Manage or close your account</h2>
        <p>
          Manage your settings in Ziipa or use the{' '}
          <Link href="/account-deletion">account deletion page</Link>. For
          account, content, or moderation questions, email{' '}
          <a href="mailto:ziipaziipa@gmail.com">ziipaziipa@gmail.com</a>.
        </p>
      </section>
    </PolicyPage>
  );
}
