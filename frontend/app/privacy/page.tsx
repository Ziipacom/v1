import type { Metadata } from 'next';
import Link from 'next/link';
import { PolicyPage } from '@/components/policy-page';

export const metadata: Metadata = {
  title: 'Ziipa Privacy Policy',
  description: 'How Ziipa uses account information, media, and device permissions.',
};

export default function PrivacyPage() {
  return (
    <PolicyPage title="Ziipa Privacy Policy">
      <p>
        Niche Labs LLC operates Ziipa. For privacy questions or help with your
        data, email <a href="mailto:ziipaziipa@gmail.com">ziipaziipa@gmail.com</a>.
      </p>
      <section>
        <h2>Information Ziipa uses</h2>
        <p>
          We use your name, email, password hash, account settings, and session
          information to provide and protect your account. We store the media,
          edits, posts, comments, feeds, bookmarks, and preferences you save.
          We use reports and account activity to investigate abuse and keep the
          service reliable. Account email is used for verification, password
          recovery, and account support.
        </p>
      </section>
      <section>
        <h2>Who can see what you share</h2>
        <p>
          Drafts and private media are available to your account. Other people
          can see published content according to your visibility settings.
          Turning on a public gallery or starting a public broadcast makes the
          media you select available to viewers. Connecting a network and
          authorizing a post or relay are separate choices.
        </p>
        <p>
          If you import public posts from a connected account, Ziipa stores a
          snapshot of the public information you authorize it to read. Read
          more about <Link href="/network-imports">public network imports</Link>.
        </p>
      </section>
      <section>
        <h2>Optional permissions and services</h2>
        <p>
          Ziipa requests access to your camera, microphone, media library, or
          calendar when you choose to use a feature that needs it. You can
          change device permissions in your device settings. If you enable
          notifications, Ziipa stores a delivery subscription for that device.
          Remove a registered device in notification settings to stop Ziipa
          sending to it.
        </p>
        <p>
          Hosting, storage, and email providers process the data needed to
          deliver those services. Livepeer processes media when you start a
          broadcast. When you enable AI title and description autofill, a small
          photo or video preview is sent to the selected inference service.
          Public posts you send to other networks are also subject to those
          networks’ policies.
        </p>
        <p>
          When you connect a wallet, Ziipa uses its public address and supported
          network to identify it. If you choose to publish on a blockchain or
          public IPFS, those records and copies may remain available after you
          delete your Ziipa account. Keep your wallet recovery phrase private.
        </p>
      </section>
      <section>
        <h2>Your account and data</h2>
        <p>
          In Settings, you can change privacy preferences, remove connections,
          export your account data, or delete your account. You can also use the
          <Link href="/account-deletion"> account deletion page</Link>. Deletion
          removes your account and associated content from Ziipa’s active
          service. If media cleanup fails, Ziipa queues it for retry. Content
          previously copied or shared to an outside service is managed there.
        </p>
      </section>
    </PolicyPage>
  );
}
