'use client';
import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Captions,
  Clapperboard,
  Gamepad2,
  Globe2,
  Hexagon,
  Layers3,
  Menu,
  Music2,
  Play,
  Radio,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Store,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { BrandLogo } from '@/components/brand-logo';
import { WaitlistForm } from '@/components/waitlist-form';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { HeroAppPreview, InteractiveWalkthrough } from './app-preview';
import './landing.css';

type Platform = 'iOS' | 'Android';
const worlds = [
  { name: 'Videos', icon: Clapperboard },
  { name: 'Music & film', icon: Music2 },
  { name: 'Gaming', icon: Gamepad2 },
  { name: 'Live feeds', icon: Radio },
  { name: 'NFTs', icon: Hexagon },
  { name: 'Marketplace', icon: Store },
];
const faqs = [
  [
    'What is Ziipa?',
    'Ziipa brings media discovery and creator tools into one space. The web preview lets you browse collections, upload and publish locally, create custom feeds, and choose personal content filters. Gaming, live, NFT, and marketplace experiences are part of the wider product vision.',
  ],
  [
    'Can I use Ziipa today?',
    'Yes. Open the web app and create a local Ziipa account. You can upload media, save drafts, add a manual caption, set playback trims, publish to signed-in local members, leave comments, and build custom feeds. This is a local development preview, not a public production network.',
  ],
  [
    'Is Ziipa available on iOS and Android?',
    'Mobile apps are planned. App Store and Google Play download links have not been added yet. You can explore the responsive web app now or join the waitlist for future beta invitations.',
  ],
  [
    'Which features are still coming?',
    'AT Protocol identity and federation, live broadcasting, adaptive streaming, AI editing, licensed sound libraries, wallet payments, creator subscriptions, NFT minting, and marketplace checkout still require production integrations. They are not active in the local preview.',
  ],
  [
    'What does “your feed, your rules” mean?',
    'The current feed builder lets you combine a content category with tag, creator-name, and declared-city filters. You can preview matching creations, save the rules, and share them with members on this local installation. Personal safety filters still apply.',
  ],
];

function DownloadButtons({
  onSelect,
  compact = false,
}: {
  onSelect: (p: Platform) => void;
  compact?: boolean;
}) {
  return (
    <div className={`zl-download-buttons ${compact ? 'compact' : ''}`}>
      <Button
        variant="outline"
        onClick={() => onSelect('iOS')}
        aria-label="Download Ziipa for iOS — coming soon"
      >
        <Smartphone size={compact ? 16 : 23} />
        <span>
          {!compact && <small>COMING SOON FOR</small>}
          <strong>iOS</strong>
        </span>
        {compact && <small>SOON</small>}
      </Button>
      <Button
        variant="outline"
        onClick={() => onSelect('Android')}
        aria-label="Download Ziipa for Android — coming soon"
      >
        <Play size={compact ? 15 : 22} />
        <span>
          {!compact && <small>COMING SOON FOR</small>}
          <strong>Android</strong>
        </span>
        {compact && <small>SOON</small>}
      </Button>
    </div>
  );
}

export default function LandingPage() {
  const [mobileMenu, setMobileMenu] = useState(false);
  const [platform, setPlatform] = useState<Platform | null>(null);
  return (
    <main className="ziipa-landing" id="top">
      <a className="zl-skip" href="#main-content">
        Skip to content
      </a>
      <header className="zl-header">
        <div className="zl-container zl-nav">
          <BrandLogo />
          <nav aria-label="Main navigation">
            <a href="#features">The possibilities</a>
            <a href="#in-action">See it in action</a>
            <a href="#creators">For creators</a>
          </nav>
          <div className="zl-nav-actions">
            <DownloadButtons compact onSelect={setPlatform} />
            <Link className="zl-signin" href="/portal">
              Open web app <ArrowUpRight size={15} />
            </Link>
          </div>
          <Button
            className="zl-menu"
            variant="ghost"
            aria-label={mobileMenu ? 'Close navigation' : 'Open navigation'}
            aria-expanded={mobileMenu}
            onClick={() => setMobileMenu(!mobileMenu)}
          >
            {mobileMenu ? <X size={22} /> : <Menu size={22} />}
          </Button>
        </div>
        {mobileMenu && (
          <nav className="zl-mobile-nav" aria-label="Mobile navigation">
            <a href="#features" onClick={() => setMobileMenu(false)}>
              The possibilities
            </a>
            <a href="#in-action" onClick={() => setMobileMenu(false)}>
              See it in action
            </a>
            <a href="#creators" onClick={() => setMobileMenu(false)}>
              For creators
            </a>
            <Link href="/portal">
              Open web app <ArrowUpRight size={15} />
            </Link>
            <DownloadButtons compact onSelect={setPlatform} />
          </nav>
        )}
      </header>
      <section className="zl-hero zl-container" id="main-content">
        <div className="zl-hero-copy">
          <span className="zl-eyebrow">
            <i /> ONE WORLD. ENDLESS POSSIBILITIES.
          </span>
          <h1>
            More than a feed.
            <br />A world <em>of yours.</em>
          </h1>
          <p>
            Find your people. Share your creativity. Explore video, music,
            gaming, and what comes next — all in one connected space.
          </p>
          <div className="zl-hero-actions">
            <Link className="zl-button" href="/portal">
              Explore Ziipa <ArrowUpRight size={19} />
            </Link>
            <a className="zl-watch-link" href="#in-action">
              <span>
                <Play size={14} fill="currentColor" />
              </span>
              See how it works
            </a>
          </div>
          <div className="zl-hero-availability">
            <span>
              <Globe2 size={14} /> Try the web preview
            </span>
            <i />
            <span>iOS & Android coming soon</span>
          </div>
          <p className="zl-hero-disclosure">
            Creator tools available locally. Live broadcasts, wallets, and
            on-chain features are in development.
          </p>
        </div>
        <HeroAppPreview />
      </section>
      <section className="zl-world-strip">
        <div className="zl-container">
          <span>FOLLOW YOUR CURIOSITY</span>
          <div>
            {worlds.map(({ name, icon: Icon }) => (
              <a href="#features" key={name}>
                <Icon size={19} />
                {name}
              </a>
            ))}
          </div>
        </div>
      </section>
      <section className="zl-section zl-container" id="features">
        <div className="zl-section-heading">
          <div>
            <span className="zl-eyebrow">SIX WAYS TO FIND YOUR THING</span>
            <h2>
              Different passions.
              <br />
              <em>One creative world.</em>
            </h2>
          </div>
          <p>
            From the next video you love to the next idea you bring to life.
            There’s room for every side of you.
          </p>
        </div>
        <div className="zl-feature-grid">
          <article className="zl-feature zl-feature-video">
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Clapperboard />
              </span>
              <span className="zl-status available">WEB PREVIEW</span>
            </div>
            <h3>
              Stories worth
              <br />
              stopping for.
            </h3>
            <p>
              Discover video and visual collections. Save the things you love,
              join the conversation, and publish your own local creations.
            </p>
            <Link href="/portal">
              Explore video <ArrowUpRight size={16} />
            </Link>
            <div className="zl-video-cards" aria-hidden="true">
              <div>
                <Image
                  unoptimized
                  width={900}
                  height={600}
                  src="/media/ocean.jpg"
                  alt=""
                />
                <span>A different perspective.</span>
              </div>
              <div>
                <Image
                  unoptimized
                  width={1200}
                  height={1800}
                  src="/media/dj.jpg"
                  alt=""
                />
                <span>Find your frequency.</span>
                <Play size={20} />
              </div>
              <div>
                <Image
                  unoptimized
                  width={900}
                  height={600}
                  src="/media/gaming.jpg"
                  alt=""
                />
              </div>
            </div>
          </article>
          <article className="zl-feature zl-feature-music">
            <Image
              unoptimized
              width={1200}
              height={1800}
              className="zl-feature-photo"
              src="/media/dj.jpg"
              alt="A DJ at a purple-lit mixing desk"
              loading="lazy"
            />
            <div className="zl-feature-overlay" />
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Music2 />
              </span>
              <span className="zl-status">COLLECTIONS PREVIEW</span>
            </div>
            <div className="zl-feature-bottom">
              <h3>Find your frequency.</h3>
              <p>
                Music, film, and creative inspiration. A place for the sounds
                and stories that move you.
              </p>
              <Link href="/portal">
                Music & film <ArrowUpRight size={16} />
              </Link>
            </div>
          </article>
          <article className="zl-feature zl-feature-gaming">
            <Image
              unoptimized
              width={900}
              height={600}
              className="zl-feature-photo"
              src="/media/gaming.jpg"
              alt="Gaming screens and a community gaming space"
              loading="lazy"
            />
            <div className="zl-feature-overlay" />
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Gamepad2 />
              </span>
              <span className="zl-status">CHANNELS PREVIEW</span>
            </div>
            <div className="zl-feature-bottom">
              <h3>More than a game.</h3>
              <p>
                Discover gaming communities and plan your channel. Gameplay
                broadcasting is on the roadmap.
              </p>
              <Link href="/portal">
                Explore gaming <ArrowUpRight size={16} />
              </Link>
            </div>
          </article>
          <article className="zl-feature zl-feature-small">
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Radio />
              </span>
              <span className="zl-status planned">PLANNED</span>
            </div>
            <h3>Be part of the moment.</h3>
            <p>
              Live conversations, performances, and behind-the-scenes access.
              Live broadcasting is not connected yet.
            </p>
            <Link href="/portal">
              Live feed concepts <ArrowUpRight size={16} />
            </Link>
          </article>
          <article className="zl-feature zl-feature-small">
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Hexagon />
              </span>
              <span className="zl-status planned">CONCEPT PREVIEW</span>
            </div>
            <h3>Collect a little possibility.</h3>
            <p>
              Explore digital collection concepts and draft your own. Wallets,
              token ownership, and minting come later.
            </p>
            <Link href="/portal">
              Discover collections <ArrowUpRight size={16} />
            </Link>
          </article>
          <article className="zl-feature zl-feature-small">
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Store />
              </span>
              <span className="zl-status planned">LISTINGS PREVIEW</span>
            </div>
            <h3>Make room for your brand.</h3>
            <p>
              Create a local product listing and shape your storefront.
              Checkout, inventory, and seller payouts are still to come.
            </p>
            <Link href="/portal">
              Explore the marketplace <ArrowUpRight size={16} />
            </Link>
          </article>
        </div>
      </section>
      <section className="zl-demo-section" id="in-action">
        <div className="zl-container">
          <div className="zl-section-heading centered">
            <span className="zl-eyebrow">LESS EXPLAINING. MORE EXPLORING.</span>
            <h2>
              From “what if” to <em>watch this.</em>
            </h2>
            <p>
              Take a little tour of your next creative space.
              <br />
              Pause the walkthrough and try the demo controls yourself.
            </p>
          </div>
          <InteractiveWalkthrough />
          <div className="zl-demo-cta">
            <span>Ready to make it real?</span>
            <Link href="/portal">
              Step inside the web app <ArrowRight size={17} />
            </Link>
          </div>
        </div>
      </section>
      <section className="zl-section zl-container" id="creators">
        <div className="zl-section-heading">
          <div>
            <span className="zl-eyebrow">
              YOU BRING THE IDEA. WE MAKE ROOM.
            </span>
            <h2>
              Built for the creator
              <br />
              <em>in you.</em>
            </h2>
          </div>
          <p>
            A workspace for your media, your creative process, and the
            communities you want to build.
          </p>
        </div>
        <div className="zl-capabilities">
          <article>
            <span>
              <UploadIcon />
            </span>
            <div>
              <h3>From upload to your next post.</h3>
              <p>
                Upload video, audio, or images. Save a private draft, add a
                manual caption, set a playback trim, and publish to the local
                community.
              </p>
              <div className="zl-capability-tags">
                <span>
                  <Scissors size={12} /> Trim preview
                </span>
                <span>
                  <Captions size={12} /> Manual captions
                </span>
                <span>
                  <Layers3 size={12} /> Drafts
                </span>
              </div>
            </div>
          </article>
          <article>
            <span>
              <SlidersHorizontal />
            </span>
            <div>
              <h3>Your feed. Your rules.</h3>
              <p>
                Curate by category, tags, creator, and declared city. Preview
                the results and share your feed rules with other local members.
              </p>
              <div className="zl-capability-tags">
                <span>#music</span>
                <span>#gaming</span>
                <span>#yourworld</span>
              </div>
            </div>
          </article>
          <article>
            <span>
              <ShieldCheck />
            </span>
            <div>
              <h3>Space to set your boundaries.</h3>
              <p>
                Save what you love. Mute words and hide creators you don’t want
                in discovery. Your personal filters travel across your local
                feeds.
              </p>
              <Link href="/portal">
                Make it yours <ArrowUpRight size={14} />
              </Link>
            </div>
          </article>
          <article className="zl-capability-future">
            <span>
              <Wallet />
            </span>
            <div>
              <div className="zl-future-label">ON THE ROADMAP</div>
              <h3>More possibilities for creators.</h3>
              <p>
                Portable AT Protocol identity, live broadcasts, AI editing,
                tips, subscriptions, and creator commerce. These production
                integrations are still ahead.
              </p>
              <a href="#faq">
                What’s available now? <ArrowUpRight size={14} />
              </a>
            </div>
          </article>
        </div>
      </section>
      <section className="zl-vision-section" id="vision">
        <div className="zl-container zl-vision">
          <span className="zl-vision-symbol">
            <Globe2 size={45} />
          </span>
          <span className="zl-eyebrow">THE NEXT CHAPTER OF THE WEB</span>
          <h2>
            Your creativity shouldn’t
            <br />
            have <em>boundaries.</em>
          </h2>
          <p>
            We’re building toward a world where identity is portable,
            communities choose their feeds, and creators have more ways to grow.
            The journey starts with a space that puts you first.
          </p>
          <div>
            <span>
              <Users size={16} /> Community-led
            </span>
            <span>
              <SlidersHorizontal size={16} /> Choice by design
            </span>
            <span>
              <Sparkles size={16} /> Creator-first
            </span>
          </div>
          <small>
            Our direction for Ziipa. Federation and financial services are not
            enabled in this local preview.
          </small>
        </div>
      </section>
      <section className="zl-section zl-container zl-faq" id="faq">
        <div>
          <span className="zl-eyebrow">A LITTLE MORE ABOUT ZIIPA</span>
          <h2>
            Curious?
            <br />
            <em>You’re in good company.</em>
          </h2>
          <p>Here’s what to know before you step inside.</p>
        </div>
        <Accordion>
          {faqs.map(([question, answer]) => (
            <AccordionItem key={question}>
              <AccordionTrigger>{question}</AccordionTrigger>
              <AccordionContent>{answer}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>
      <section className="zl-join-section" id="waitlist">
        <div className="zl-container zl-join">
          <div>
            <span className="zl-eyebrow">
              <i /> THIS IS JUST THE BEGINNING
            </span>
            <h2>
              Your next chapter.
              <br />
              <em>Make it Ziipa.</em>
            </h2>
            <p>
              Try the web app today, or join the waitlist for what comes next.
              We’d love to have you along for the journey.
            </p>
            <Link className="zl-button" href="/portal">
              Open the web app <ArrowUpRight size={18} />
            </Link>
            <DownloadButtons onSelect={setPlatform} />
          </div>
          <div className="zl-waitlist-form">
            <WaitlistForm />
          </div>
        </div>
      </section>
      <footer className="zl-footer">
        <div className="zl-container">
          <div className="zl-footer-top">
            <div>
              <BrandLogo />
              <p>
                A world of endless possibilities.
                <br />
                And a place for you in it.
              </p>
              <a href="mailto:hello@ziipa.com">
                hello@ziipa.com <ArrowUpRight size={13} />
              </a>
            </div>
            <div>
              <h3>Explore Ziipa</h3>
              <a href="#features">The possibilities</a>
              <a href="#in-action">See it in action</a>
              <a href="#creators">For creators</a>
              <Link href="/portal">Creator web app</Link>
            </div>
            <div>
              <h3>Get to know us</h3>
              <a href="#vision">Our vision</a>
              <a href="#faq">Your questions</a>
              <a href="#waitlist">Join the waitlist</a>
              <a href="mailto:hello@ziipa.com">Contact us</a>
            </div>
            <div className="zl-footer-download">
              <h3>Your world, wherever you go.</h3>
              <DownloadButtons onSelect={setPlatform} />
              <span>
                Mobile apps coming soon.
                <br />
                The responsive web preview is ready to explore.
              </span>
            </div>
          </div>
          <div className="zl-footer-bottom">
            <span>
              © {new Date().getFullYear()} Ziipa Inc. All rights reserved.
            </span>
            <span>Built for curiosity. Open to possibility.</span>
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
      </footer>
      <Dialog
        open={platform !== null}
        onOpenChange={(open) => {
          if (!open) setPlatform(null);
        }}
      >
        <DialogContent className="zl-download-dialog">
          <span className="zl-download-dialog-icon">
            <Smartphone size={32} />
          </span>
          <DialogTitle>Ziipa for {platform} is on its way.</DialogTitle>
          <DialogDescription>
            Mobile downloads aren’t available yet. Explore the responsive web
            app now, or join the waitlist for future beta invitations.
          </DialogDescription>
          <Link className="zl-button" href="/portal">
            Try the web app <ArrowUpRight size={16} />
          </Link>
          <a
            className="zl-dialog-waitlist"
            href="#waitlist"
            onClick={() => setPlatform(null)}
          >
            Join the waitlist <ArrowRight size={15} />
          </a>
          <small>
            No App Store or Google Play listing is connected to this preview.
          </small>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function UploadIcon() {
  return <Clapperboard />;
}
