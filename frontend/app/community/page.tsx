import type { Metadata } from 'next';
import { PolicyPage } from '@/components/policy-page';

export const metadata: Metadata = {
  title: 'Ziipa Community Rules',
  description: 'Ziipa’s rules for sharing media, reporting content, and blocking accounts.',
};

export default function CommunityPage() {
  return (
    <PolicyPage title="Ziipa Community Rules">
      <section>
        <h2>Respect other people</h2>
        <p>
          Harassment, threats, hate speech, impersonation, and sharing someone
          else’s private information without their permission are prohibited.
          Scams and spam are also prohibited.
        </p>
      </section>
      <section>
        <h2>Share safely and with permission</h2>
        <p>
          Share only material you created or have permission to use. Ziipa
          prohibits sexually explicit content, exploitation, non-consensual
          intimate imagery, child sexual abuse material, and content that
          encourages physical harm or illegal activity.
        </p>
      </section>
      <section>
        <h2>Report or block</h2>
        <p>
          Use Report on a post or comment to flag it for review, or block a
          creator to hide their content. Ziipa may restrict access to content or
          accounts that violate these rules. To report a safety concern or appeal
          a moderation decision, email{' '}
          <a href="mailto:ziipaziipa@gmail.com">ziipaziipa@gmail.com</a>.
        </p>
      </section>
    </PolicyPage>
  );
}
