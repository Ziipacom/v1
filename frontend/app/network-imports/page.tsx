import type { Metadata } from 'next';
import Link from 'next/link';
import { BrandLogo } from '@/components/brand-logo';
import '@/components/landing/landing.css';
import s from '@/components/network-imports.module.css';

export const metadata: Metadata = {
  title: 'Public network imports — Ziipa',
  description: 'How Ziipa uses public network metadata, your import choices, retention and connection controls.',
};

export default function NetworkImportsNotice() {
  return (
    <main className={`ziipa-landing ${s.page}`}>
      <div className={s.content}>
        <nav className={s.nav} aria-label="Ziipa navigation">
          <BrandLogo />
          <Link href="/portal">Open Ziipa</Link>
        </nav>
        <article>
          <p className={s.eyebrow}>OPTIONAL PUBLIC NETWORK IMPORTS · UPDATED OCTOBER 27, 2026</p>
          <h1>How public imports use data</h1>
          <p className={s.intro}>
            You choose whether to bring public posts into your Ziipa discovery feed.
            Saving a profile shortcut, authorizing read access, selecting an account
            and syncing posts are separate actions. Some integrations remain
            unavailable until their required provider setup and approvals are complete.
          </p>

          <section>
            <h2>What is read and displayed</h2>
            <p>
              An import reads a bounded recent snapshot of public post or video IDs,
              titles, descriptions, author/channel names and identifiers, publication
              times, original post links and available thumbnail URLs. Ziipa uses
              this metadata to show attributed cards alongside Ziipa creations in
              your account. It does not import private home feeds, messages, address
              books or a complete history of your activity.
            </p>
            <p>
              Imported cards open the original post on its network. Importing does
              not download an audio/video file, make it an owned Ziipa upload, grant
              a media license, or publish a post. Optional thumbnails are fetched
              from allowlisted provider image servers and kept only in client memory.
              Loading a thumbnail or opening a network page sends a request to that
              provider, which can receive connection information such as your IP
              address under its own policies. Ziipa does not forward its account
              password or session token to those image or post URLs.
            </p>
          </section>

          <section>
            <h2>Your choices by network</h2>
            <ul>
              <li><strong>YouTube:</strong> Ziipa uses YouTube API Services to read
                a linked channel&apos;s public uploads. Private and unlisted videos
                are excluded. Linking a public channel does not verify that you own
                it and does not authorize access to your Google Account.</li>
              <li><strong>Facebook and Instagram:</strong> separate read-only consent
                permits public posts from an explicitly selected managed, published
                Facebook Page or its linked professional Instagram account.</li>
              <li><strong>TikTok:</strong> separate basic-identity and public-video
                read consent permits the authorized account&apos;s public videos.</li>
              <li><strong>Bluesky:</strong> a linked public profile can provide recent
                public author posts and a bounded public following list. A public
                link does not verify ownership.</li>
            </ul>
            <p>
              Read consent grants no publishing permission. In Connected networks,
              review the setup and consent information, select an authorized import
              target when required, then explicitly choose Sync. On Android, the
              consent handoff opens Ziipa&apos;s portal: sign in to the same Ziipa
              account there, finish consent, and return to refresh import status.
            </p>
          </section>

          <section>
            <h2>Storage and retention</h2>
            <p>
              Meta, TikTok and YouTube imported post metadata and API-derived account
              labels use a temporary server cache scoped to your Ziipa account,
              provider and connection revision. Its validity is at most six hours
              for TikTok and 24 hours for Meta and YouTube. After that deadline,
              Ziipa stops displaying the snapshot; another explicit sync is required.
              These imports have no database snapshot fallback. Bluesky uses its
              existing account-scoped public snapshot, which is replaced by sync
              or removed when you disconnect it.
            </p>
            <p>
              Verified consent/target identifiers and encrypted Meta/TikTok read
              credentials are stored on Ziipa&apos;s server to operate the connection.
              They are separate from publishing credentials and are not placed in
              the app bundle or returned in public cards. Changing a target or
              disconnecting stops access to the former snapshot immediately. Cache
              removal is attempted at that time; if cache cleanup is temporarily
              unavailable, inaccessible cached metadata expires within the limits
              above. This does not guarantee erasure of bytes someone already viewed
              or copied from an external network.
            </p>
          </section>

          <section>
            <h2>Disconnecting and deleting data</h2>
            <p>
              In Ziipa&apos;s Connected networks, open the account and choose Remove
              from Ziipa. This removes its local read connection and stops displaying
              its imported snapshot. It does not delete external posts, disconnect a
              separate Ziipa publishing grant or revoke the provider application&apos;s
              access across all services. To remove that wider access, use the
              provider&apos;s own account controls:
            </p>
            <ul>
              <li><a href="https://myaccount.google.com/connections">Google third-party connections</a>{' '}
                and <a href="https://support.google.com/accounts/answer/13533235">Google&apos;s access-removal guidance</a>.
                Public YouTube channel imports do not create a Google OAuth grant;
                this control is relevant if you separately authorized one.</li>
              <li><a href="https://www.facebook.com/settings?tab=business_tools">Facebook business integration controls</a>{' '}
                for the Meta application used by Facebook/linked Instagram consent.</li>
              <li><a href="https://support.tiktok.com/en/safety-hc/account-and-user-safety/connect-to-third-party-apps">TikTok connected-app permission guidance</a>.</li>
            </ul>
            <p>
              You can export account data and delete your Ziipa account from
              Settings. Account deletion also removes its current local read
              connections and makes their cached imports inaccessible.
              See <Link href="/account-deletion">account deletion</Link>, or contact{' '}
              <a href="mailto:hello@ziipa.com">hello@ziipa.com</a> for data or support questions.
            </p>
          </section>

          <section>
            <h2>YouTube and Google information</h2>
            <p>
              YouTube features use YouTube API Services. YouTube&apos;s services are
              subject to the <a href="https://www.youtube.com/t/terms">YouTube Terms of Service</a>.
              Google describes its handling of information in the{' '}
              <a href="https://policies.google.com/privacy">Google Privacy Policy</a>.
              This page describes Ziipa&apos;s optional public-import feature and its
              data controls.
            </p>
          </section>
        </article>
        <footer className={s.footer}>
          <Link href="/">Back to Ziipa</Link>
          <Link href="/account-deletion">Account deletion</Link>
          <a href="mailto:hello@ziipa.com">Contact support</a>
        </footer>
      </div>
    </main>
  );
}
