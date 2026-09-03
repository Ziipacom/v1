'use client';
import { useEffect, useRef, useState, type RefObject } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  Bookmark,
  Captions,
  Check,
  ChevronRight,
  Compass,
  Gamepad2,
  Heart,
  Hexagon,
  Layers3,
  Menu,
  MessageCircle,
  Music2,
  Pause,
  Play,
  Plus,
  Radio,
  Scissors,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Store,
  UploadCloud,
  Volume2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

function useSequence(
  ref: RefObject<HTMLDivElement | null>,
  length: number,
  interval: number,
) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => {
      setReduced(preference.matches);
      setPlaying(!preference.matches);
    };
    changed();
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((e) => e.isIntersecting)),
      { threshold: 0.15 },
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [ref]);
  useEffect(() => {
    const changed = () => setPageVisible(!document.hidden);
    changed();
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!playing || !visible || !pageVisible) return;
    const timer = window.setInterval(
      () => setIndex((i) => (i + 1) % length),
      interval,
    );
    return () => window.clearInterval(timer);
  }, [playing, visible, pageVisible, length, interval]);
  return {
    index,
    playing,
    reduced,
    toggle: () => setPlaying((p) => !p),
    select: (i: number) => {
      setIndex(i);
      setPlaying(false);
    },
    active: playing && visible && pageVisible,
  };
}

const scenes = [
  {
    name: 'Music & film',
    title: 'Find your frequency.',
    creator: 'Ziipa Sessions',
    tag: 'MUSIC COLLECTION',
    image: '/media/dj.jpg',
    icon: Music2,
  },
  {
    name: 'Gaming',
    title: 'Find your next crew.',
    creator: 'Ziipa Arcade',
    tag: 'CHANNEL PREVIEW',
    image: '/media/gaming.jpg',
    icon: Gamepad2,
  },
  {
    name: 'Videos',
    title: 'A different point of view.',
    creator: 'Ziipa Collective',
    tag: 'VISUAL COLLECTION',
    image: '/media/ocean.jpg',
    icon: Compass,
  },
  {
    name: 'Live feeds',
    title: 'Closer to the moment.',
    creator: 'Ziipa Studio',
    tag: 'LIVE CONCEPT · PLANNED',
    image: '/media/studio.jpg',
    icon: Radio,
  },
];

export function HeroAppPreview() {
  const previewRef = useRef<HTMLDivElement>(null);
  const sequence = useSequence(previewRef, scenes.length, 4600);
  const scene = scenes[sequence.index];
  const Icon = scene.icon;
  return (
    <div
      ref={previewRef}
      className={`zl-hero-preview ${sequence.active && !sequence.reduced ? 'is-playing' : ''}`}
    >
      <div className="zl-preview-backdrop" />
      <div className="zl-side-card zl-side-card-left" aria-hidden="true">
        <Image
          unoptimized
          width={900}
          height={600}
          src="/media/ocean.jpg"
          alt=""
        />
        <span>
          Every perspective
          <br />
          has a place.
        </span>
        <div>
          <Heart size={15} />
          <Bookmark size={15} />
        </div>
      </div>
      <div className="zl-side-card zl-side-card-right" aria-hidden="true">
        <Image
          unoptimized
          width={900}
          height={600}
          src="/media/gaming.jpg"
          alt=""
        />
        <span>
          <Gamepad2 size={15} /> Your next community
        </span>
        <div className="zl-small-bars">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="zl-phone">
        <div className="zl-phone-top">
          <Image
            unoptimized
            width={9446}
            height={3104}
            src="/brand/ziipa-logo.png"
            alt="Ziipa app preview"
          />
          <Menu size={17} />
        </div>
        <div className="zl-phone-search">
          <Search size={13} />
          <span>Find your thing</span>
          <SlidersHorizontal size={12} />
        </div>
        <div className="zl-phone-content" key={sequence.index}>
          <Image
            unoptimized
            width={scene.image.endsWith('dj.jpg') ? 1200 : 900}
            height={scene.image.endsWith('dj.jpg') ? 1800 : 600}
            loading="eager"
            fetchPriority="high"
            src={scene.image}
            alt={`${scene.name} collection preview`}
          />
          <div className="zl-phone-scrim" />
          <span className="zl-phone-label">{scene.tag}</span>
          <div className="zl-phone-reactions" aria-hidden="true">
            <Heart />
            <MessageCircle />
            <Bookmark />
          </div>
          <div className="zl-phone-copy">
            <span>@{scene.creator.toLowerCase().replaceAll(' ', '')}</span>
            <h3>{scene.title}</h3>
            <p>
              <Music2 size={12} /> A world of endless possibilities
            </p>
          </div>
        </div>
        <div className="zl-phone-bottom" aria-hidden="true">
          <Compass />
          <Scissors />
          <span>
            <Plus />
          </span>
          <Layers3 />
          <Store />
        </div>
      </div>
      <div className="zl-floating-chip zl-floating-chip-top">
        <span>
          <Icon size={19} />
        </span>
        <div>
          <small>YOUR WORLD, CONNECTED</small>
          <strong>{scene.name}</strong>
        </div>
      </div>
      <div className="zl-floating-chip zl-floating-chip-bottom">
        <span>
          <SlidersHorizontal size={19} />
        </span>
        <div>
          <strong>Your feed. Your rules.</strong>
          <small>Built around what moves you.</small>
        </div>
        <Check size={15} />
      </div>
      <div className="zl-hero-playback">
        <div className="zl-scene-dots" aria-label="App preview scenes">
          {scenes.map((s, i) => (
            <button
              key={s.name}
              aria-label={`Show ${s.name} preview`}
              aria-pressed={sequence.index === i}
              className={sequence.index === i ? 'active' : ''}
              onClick={() => sequence.select(i)}
            />
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            sequence.playing ? 'Pause hero animation' : 'Play hero animation'
          }
          onClick={sequence.toggle}
        >
          {sequence.playing ? <Pause size={12} /> : <Play size={12} />}
        </Button>
        <span>App concept preview</span>
      </div>
    </div>
  );
}

const steps = [
  {
    title: 'Discover your world',
    text: 'Move between video, music, gaming, and collections. Find something unexpected, then save it for later.',
    icon: Compass,
  },
  {
    title: 'Make it your own',
    text: 'Bring in your media, set a playback trim, add a caption, and take your creation from draft to Ziipa post.',
    icon: Scissors,
  },
  {
    title: 'Curate your corner',
    text: 'Choose a category, tag, or city. See your results, save the feed, and share the rules with Ziipa members.',
    icon: SlidersHorizontal,
  },
];

export function InteractiveWalkthrough() {
  const walkthroughRef = useRef<HTMLDivElement>(null);
  const sequence = useSequence(walkthroughRef, steps.length, 6500);
  const [liked, setLiked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [caption, setCaption] = useState(true);
  const [filter, setFilter] = useState('music');
  return (
    <div
      className={`zl-walkthrough ${sequence.active && !sequence.reduced ? 'is-playing' : ''}`}
      ref={walkthroughRef}
    >
      <div className="zl-demo-steps">
        {steps.map(({ title, text, icon: Icon }, i) => (
          <Button
            variant="ghost"
            key={title}
            className={sequence.index === i ? 'active' : ''}
            onClick={() => sequence.select(i)}
            aria-pressed={sequence.index === i}
          >
            <span className="zl-step-number">0{i + 1}</span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
            <Icon size={22} />
          </Button>
        ))}
        <div className="zl-demo-controls">
          <Button variant="outline" onClick={sequence.toggle}>
            {sequence.playing ? <Pause size={13} /> : <Play size={13} />}{' '}
            {sequence.playing ? 'Pause walkthrough' : 'Play walkthrough'}
          </Button>
          <span>You can try the controls, too.</span>
        </div>
      </div>
      <div className="zl-demo-window">
        <div className="zl-window-chrome">
          <span>
            <i />
            <i />
            <i />
          </span>
          <p>ziipa / creator workspace</p>
          <ShieldCheck size={13} />
        </div>
        <div className="zl-demo-app">
          <aside aria-hidden="true">
            <Image
              unoptimized
              width={9446}
              height={3104}
              src="/brand/ziipa-logo.png"
              alt=""
            />
            <span className={sequence.index === 0 ? 'active' : ''}>
              <Compass /> Discover
            </span>
            <span className={sequence.index === 1 ? 'active' : ''}>
              <Scissors /> My studio
            </span>
            <span className={sequence.index === 2 ? 'active' : ''}>
              <SlidersHorizontal /> Feed builder
            </span>
            <span>
              <ShieldCheck /> Safety
            </span>
          </aside>
          <div className="zl-demo-screen" key={sequence.index}>
            <div className="zl-demo-screen-title">
              <strong>
                {
                  [
                    'Made for your curiosity.',
                    'Create something yours.',
                    'Your feed. Your rules.',
                  ][sequence.index]
                }
              </strong>
              <span>INTERACTIVE DEMO</span>
            </div>
            {sequence.index === 0 ? (
              <>
                <div className="zl-demo-category-row" aria-hidden="true">
                  <span className="active">
                    <Music2 /> Music & film
                  </span>
                  <span>
                    <Gamepad2 /> Games
                  </span>
                  <span>
                    <Radio /> Live
                  </span>
                  <span>
                    <Hexagon /> NFTs
                  </span>
                </div>
                <div className="zl-demo-feature">
                  <Image
                    unoptimized
                    width={1200}
                    height={1800}
                    src="/media/dj.jpg"
                    alt="Music collection in the app demo"
                  />
                  <div>
                    <small>ZIIPA SESSIONS · DEMO</small>
                    <h3>
                      After hours.
                      <br />
                      All feeling.
                    </h3>
                    <span>Find your frequency.</span>
                  </div>
                  <button
                    aria-label={
                      liked ? 'Unlike demo collection' : 'Like demo collection'
                    }
                    aria-pressed={liked}
                    onClick={() => {
                      sequence.select(0);
                      setLiked(!liked);
                    }}
                  >
                    <Heart fill={liked ? 'currentColor' : 'none'} />
                  </button>
                </div>
                <div className="zl-demo-mini-row">
                  <Image
                    unoptimized
                    width={900}
                    height={600}
                    src="/media/ocean.jpg"
                    alt="Coastal visual collection"
                  />
                  <div>
                    <strong>A different rhythm.</strong>
                    <small>Ziipa Collective · Demo</small>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={
                      saved ? 'Unsave demo collection' : 'Save demo collection'
                    }
                    aria-pressed={saved}
                    onClick={() => {
                      sequence.select(0);
                      setSaved(!saved);
                    }}
                  >
                    <Bookmark fill={saved ? 'currentColor' : 'none'} />
                  </Button>
                </div>
              </>
            ) : sequence.index === 1 ? (
              <>
                <div className="zl-demo-editor">
                  <div className="zl-demo-edit-preview">
                    <Image
                      unoptimized
                      width={900}
                      height={600}
                      src="/media/ocean.jpg"
                      alt="Sample scene in the editor"
                    />
                    {caption && <span>A different point of view.</span>}
                    <small>PREVIEW</small>
                  </div>
                  <div className="zl-demo-edit-tools">
                    <span>
                      <UploadCloud /> Media ready
                    </span>
                    <span>
                      <Scissors /> Playback trim
                    </span>
                    <Button
                      variant="ghost"
                      aria-pressed={caption}
                      onClick={() => {
                        sequence.select(1);
                        setCaption(!caption);
                      }}
                    >
                      <Captions /> {caption ? 'Hide caption' : 'Show caption'}
                    </Button>
                    <span>
                      <Volume2 /> Original audio
                    </span>
                  </div>
                </div>
                <div className="zl-demo-timeline">
                  <div>
                    {Array.from({ length: 8 }, (_, i) => (
                      <Image
                        unoptimized
                        width={900}
                        height={600}
                        src="/media/ocean.jpg"
                        alt=""
                        key={i}
                      />
                    ))}
                  </div>
                  <i />
                </div>
                <div className="zl-demo-editor-bottom">
                  <span>
                    00:00 <b>/</b> 00:15
                  </span>
                  <span>
                    <Check size={12} /> Demo draft
                  </span>
                </div>
                <p className="zl-demo-inline-note">
                  Manual captions and playback trim. No file is changed in this
                  demo.
                </p>
              </>
            ) : (
              <>
                <div className="zl-demo-filter">
                  <div>
                    <span>MY CUSTOM FEED</span>
                    <strong>Good energy only.</strong>
                  </div>
                  <SlidersHorizontal size={20} />
                </div>
                <div className="zl-demo-filter-buttons">
                  <span>Show me</span>
                  {['music', 'gaming', 'nature'].map((tag) => (
                    <Button
                      variant="ghost"
                      key={tag}
                      aria-pressed={filter === tag}
                      className={filter === tag ? 'active' : ''}
                      onClick={() => {
                        sequence.select(2);
                        setFilter(tag);
                      }}
                    >
                      #{tag}
                    </Button>
                  ))}
                </div>
                <div className="zl-demo-feed-result">
                  <Image
                    unoptimized
                    width={filter === 'music' ? 1200 : 900}
                    height={filter === 'music' ? 1800 : 600}
                    src={
                      filter === 'music'
                        ? '/media/dj.jpg'
                        : filter === 'gaming'
                          ? '/media/gaming.jpg'
                          : '/media/ocean.jpg'
                    }
                    alt={`${filter} demo feed result`}
                  />
                  <div>
                    <strong>
                      {filter === 'music'
                        ? 'After hours. All feeling.'
                        : filter === 'gaming'
                          ? 'One more round.'
                          : 'A different rhythm.'}
                    </strong>
                    <span>
                      Matches your #{filter} rule <Check size={12} />
                    </span>
                  </div>
                </div>
                <div className="zl-demo-rule-summary">
                  <ShieldCheck size={19} />
                  <div>
                    <strong>Personal. By design.</strong>
                    <p>Your safety preferences still apply.</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="zl-window-footer">
          <span>
            <i /> Illustrative walkthrough · changes stay in this demo
          </span>
          <Link href="/portal">
            Try the web app <ChevronRight size={13} />
          </Link>
        </div>
      </div>
    </div>
  );
}
