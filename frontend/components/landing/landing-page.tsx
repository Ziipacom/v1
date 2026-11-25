'use client';
import { useState } from 'react';
import {
  ArrowUpRight,
  Captions,
  Clapperboard,
  Gamepad2,
  Globe2,
  Layers3,
  Menu,
  Music2,
  Play,
  Radio,
  Scissors,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  X,
} from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { BrandLogo } from '@/components/brand-logo';
import { Button } from '@/components/ui/button';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { HeroAppPreview } from './app-preview';
import './landing.css';

const worlds = [
  { name: 'Videos', icon: Clapperboard },
  { name: 'Music & film', icon: Music2 },
  { name: 'Gaming', icon: Gamepad2 },
  { name: 'Live feeds', icon: Radio },
  { name: 'Marketplace', icon: Store },
];
const faqs = [
  [
    'What is Ziipa?',
    'Ziipa brings media discovery and creator tools into one space. Browse collections, publish your own media, and build feeds around what you want to see.',
  ],
  [
    'How do I get started?',
    'Create an account and verify your email. In Studio, upload your media, save a private draft, and publish it when it’s ready.',
  ],
  [
    'Can I use Ziipa on my phone?',
    'Open Ziipa in your phone’s browser and sign in with your Ziipa account.',
  ],
  [
    'Who can see my creations?',
    'Drafts stay private. You choose what to publish and whether to make your gallery public in Settings.',
  ],
  [
    'What does “your feed, your rules” mean?',
    'Build a feed around a category, tag, creator, or city. You can save and share the feed with other Ziipa members. Your mute and block settings still apply.',
  ],
];

export default function LandingPage() {
  const [mobileMenu, setMobileMenu] = useState(false);
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
            <a href="#creators">For creators</a>
          </nav>
          <div className="zl-nav-actions">
            <Link className="zl-signin" href="/portal">
              Open Ziipa <ArrowUpRight size={15} />
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
            <a href="#creators" onClick={() => setMobileMenu(false)}>
              For creators
            </a>
            <Link href="/portal">
              Open Ziipa <ArrowUpRight size={15} />
            </Link>
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
            Discover video, music, and games. Create and share your own media
            from Ziipa Studio.
          </p>
          <div className="zl-hero-actions">
            <Link className="zl-button" href="/portal?mode=register">
              Create an account <ArrowUpRight size={19} />
            </Link>
            <Link className="zl-watch-link" href="/portal">
              <span>
                <Play size={14} fill="currentColor" />
              </span>
              Open Studio
            </Link>
          </div>
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
            </div>
            <h3>
              Stories worth
              <br />
              stopping for.
            </h3>
            <p>
              Discover video and visual collections. Save the things you love,
              join the conversation, and publish your own Ziipa creations.
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
            </div>
            <div className="zl-feature-bottom">
              <h3>More than a game.</h3>
              <p>
                Discover clips and creations from Ziipa’s gaming community.
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
            </div>
            <h3>Be part of the moment.</h3>
            <p>
              Find live conversations, performances, and behind-the-scenes
              sessions in Live Feed.
            </p>
            <Link href="/portal">
              Open Ziipa <ArrowUpRight size={16} />
            </Link>
          </article>
          <article className="zl-feature zl-feature-small">
            <div className="zl-feature-top">
              <span className="zl-feature-icon">
                <Store />
              </span>
            </div>
            <h3>Make room for your brand.</h3>
            <p>
              Discover products from Ziipa creators or set up your own
              storefront and publish listings.
            </p>
            <Link href="/portal">
              Explore the marketplace <ArrowUpRight size={16} />
            </Link>
          </article>
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
                manual caption, set a playback trim, and publish to the Ziipa
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
                the results and share your feed rules with other Ziipa members.
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
                in discovery. Your personal filters travel across your Ziipa
                feeds.
              </p>
              <Link href="/portal">
                Make it yours <ArrowUpRight size={14} />
              </Link>
            </div>
          </article>
          <article>
            <span>
              <Globe2 />
            </span>
            <div>
              <h3>Share your gallery.</h3>
              <p>
                Choose which published creations appear in your gallery and
                share its link with your audience.
              </p>
              <Link href="/portal">
                Open your profile <ArrowUpRight size={14} />
              </Link>
            </div>
          </article>
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
      <section className="zl-join-section" id="get-started">
        <div className="zl-container zl-join">
          <div>
            <h2>
              Make your first creation.
            </h2>
            <Link className="zl-button" href="/portal?mode=register">
              Create an account <ArrowUpRight size={18} />
            </Link>
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
              <a href="mailto:ziipaziipa@gmail.com">
                ziipaziipa@gmail.com <ArrowUpRight size={13} />
              </a>
            </div>
            <div>
              <h3>Explore Ziipa</h3>
              <a href="#features">The possibilities</a>
              <a href="#creators">For creators</a>
              <Link href="/portal">Creator web app</Link>
            </div>
            <div>
              <h3>Get to know us</h3>
              <a href="#faq">Your questions</a>
              <a href="mailto:ziipaziipa@gmail.com">Contact us</a>
              <Link href="/network-imports">Public imports & data</Link>
            </div>
            <div>
              <h3>Account and privacy</h3>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms of use</Link>
              <Link href="/community">Community rules</Link>
              <Link href="/account-deletion">Account deletion</Link>
            </div>
          </div>
          <div className="zl-footer-bottom">
            <span>
              © {new Date().getFullYear()} Niche Labs LLC. All rights reserved.
            </span>
            <span>Built for curiosity. Open to possibility.</span>
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function UploadIcon() {
  return <Clapperboard />;
}
