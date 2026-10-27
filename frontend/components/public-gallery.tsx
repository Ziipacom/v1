"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Film,
  Link2,
  Music2,
  RefreshCw,
} from "lucide-react";
import {
  mergePublicGalleryItems,
  parsePublicGallery,
  parsePublicGalleryItem,
  publicCreationLink,
  publicGalleryItemId,
  publicGallerySlug,
  type PublicGallery,
  type PublicGalleryItem,
} from "@/lib/public-gallery";
import s from "./public-gallery.module.css";

async function readPublic(path: string, signal: AbortSignal) {
  const response = await fetch(path, {
    credentials: "omit",
    cache: "no-store",
    signal,
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        response.status === 404
          ? "This gallery or creation is not available. Its owner may have changed the address or made it private."
          : response.status === 429
            ? "Too many requests. Please try again shortly."
            : "This gallery could not load. Please try again.",
      ),
      { status: response.status },
    );
  return response.json() as Promise<unknown>;
}

export function PublicGalleryView({
  slug,
  initialItemId,
}: {
  slug: string;
  initialItemId?: string;
}) {
  const [gallery, setGallery] = useState<PublicGallery | null>(null);
  const [selected, setSelected] = useState<PublicGalleryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const [postId, setPostId] = useState(initialItemId);
  const generation = useRef(0);
  const pageRequest = useRef<AbortController | null>(null);
  const paging = useRef(false);
  useEffect(() => {
    const pop = () =>
      setPostId(
        new URLSearchParams(window.location.search).get("post") || undefined,
      );
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    const run = ++generation.current;
    const controller = new AbortController();
    pageRequest.current?.abort();
    paging.current = false;
    const deadline = setTimeout(() => controller.abort(), 20000);
    setGallery(null);
    setSelected(null);
    setLoading(true);
    setError("");
    setNotice("");
    setLoadingMore(false);
    if (
      !publicGallerySlug(slug) ||
      (postId !== undefined && !publicGalleryItemId(postId))
    ) {
      setError("This gallery address is not valid.");
      setLoading(false);
      clearTimeout(deadline);
      return;
    }
    void (async () => {
      try {
        const base = `/api/public/galleries/${slug}`;
        const next = parsePublicGallery(
          await readPublic(base, controller.signal),
          slug,
        );
        const item = postId
          ? next.items.find((item) => item.id === postId) ||
            parsePublicGalleryItem(
              await readPublic(`${base}/items/${postId}`, controller.signal),
              slug,
            )
          : null;
        if (generation.current === run && !controller.signal.aborted) {
          setGallery(next);
          setSelected(item);
        }
      } catch (cause) {
        if (generation.current === run)
          setError(
            controller.signal.aborted
              ? "The gallery took too long to load. Please retry."
              : (cause as Error).message,
          );
      } finally {
        clearTimeout(deadline);
        if (generation.current === run) setLoading(false);
      }
    })();
    return () => {
      generation.current++;
      controller.abort();
      pageRequest.current?.abort();
    };
  }, [slug, postId, revision]);
  async function loadMore() {
    if (!gallery?.next_cursor || paging.current || loading) return;
    paging.current = true;
    setLoadingMore(true);
    setError("");
    const run = generation.current,
      cursor = gallery.next_cursor;
    const controller = new AbortController();
    pageRequest.current = controller;
    const deadline = setTimeout(() => controller.abort(), 20000);
    try {
      const next = parsePublicGallery(
        await readPublic(
          `/api/public/galleries/${slug}?cursor=${encodeURIComponent(cursor)}`,
          controller.signal,
        ),
        slug,
      );
      if (run === generation.current && !controller.signal.aborted)
        setGallery((old) =>
          old
            ? { ...next, items: mergePublicGalleryItems(old.items, next.items) }
            : next,
        );
    } catch (cause) {
      if (run === generation.current) {
        if ((cause as { status?: number }).status === 404) {
          setGallery(null);
          setSelected(null);
        }
        setError(
          controller.signal.aborted
            ? "Loading more creations took too long. Please retry."
            : (cause as Error).message,
        );
      }
    } finally {
      clearTimeout(deadline);
      if (run === generation.current) {
        paging.current = false;
        setLoadingMore(false);
      }
    }
  }
  function open(item?: PublicGalleryItem) {
    const path = publicCreationLink(slug, item?.id);
    window.history.pushState(null, "", path);
    setPostId(item?.id);
    setNotice("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function share() {
    const url = new URL(
      publicCreationLink(slug, selected?.id),
      window.location.origin,
    ).href;
    try {
      if (navigator.share)
        await navigator.share({
          title: selected?.title || `${gallery?.name}'s Ziipa gallery`,
          url,
        });
      else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setNotice("Public link copied.");
      } else setNotice(url);
    } catch (cause) {
      if ((cause as Error).name !== "AbortError")
        setNotice("Use your browser’s address bar to copy this public link.");
    }
  }
  return (
    <main className={s.page}>
      <header className={s.nav}>
        <a href="/" aria-label="Ziipa home">
          <img
            src="/brand/ziipa-logo.png"
            alt="Ziipa"
            width={140}
            height={46}
          />
        </a>
        <a href="/portal">
          Open Ziipa <ArrowUpRight size={16} />
        </a>
      </header>
      {loading ? (
        <section className={s.message} role="status">
          Opening this creator’s gallery…
        </section>
      ) : gallery ? (
        <>
          {!selected && (
            <section className={s.profile}>
              {gallery.cover_url && (
                <img
                  className={s.cover}
                  src={gallery.cover_url}
                  alt="Creator cover artwork"
                />
              )}
              <div className={s.profileContent}>
                {gallery.avatar_url ? (
                  <img
                    className={s.avatar}
                    src={gallery.avatar_url}
                    alt={`${gallery.name}'s avatar`}
                  />
                ) : (
                  <img
                    className={s.avatar}
                    src="/brand/ziipa-favicon.png"
                    alt=""
                  />
                )}
                <div>
                  <p className={s.eyebrow}>PUBLIC CREATOR GALLERY</p>
                  <h1>{gallery.name}</h1>
                  <p>@{slug}</p>
                </div>
                <button className={s.button} onClick={() => void share()}>
                  <Link2 size={16} /> Share gallery
                </button>
              </div>
            </section>
          )}
          {selected ? (
            <section className={s.post}>
              <button className={s.button} onClick={() => open()}>
                <ArrowLeft size={17} /> Back to gallery
              </button>
              <article>
                <PublicMedia key={selected.id} item={selected} full />
                <div className={s.postText}>
                  <p className={s.eyebrow}>
                    {categoryName(selected.category)} · @{slug}
                  </p>
                  <h1>{selected.title}</h1>
                  <p>{selected.description}</p>
                  {!!selected.tags.length && (
                    <p className={s.tags}>
                      {selected.tags.map((tag) => `#${tag}`).join(" ")}
                    </p>
                  )}
                  <button className={s.button} onClick={() => void share()}>
                    <Link2 size={16} /> Share creation
                  </button>
                </div>
              </article>
            </section>
          ) : (
            <section aria-label="Published creations">
              <div className={s.sectionTitle}>
                <h2>Creations</h2>
                <button
                  className={s.iconButton}
                  aria-label="Refresh public gallery"
                  onClick={() => setRevision((n) => n + 1)}
                >
                  <RefreshCw size={18} />
                </button>
              </div>
              {gallery.unavailable_count > 0 && (
                <p className={s.notice}>
                  Some published edits are not displayed in this version. The
                  creator can publish the finished media as a separate creation
                  to include it here. Uncut originals are not shown in their
                  place.
                </p>
              )}
              {!gallery.items.length ? (
                <p className={s.message}>
                  No published creations are displayed yet.
                </p>
              ) : (
                <div className={s.grid}>
                  {gallery.items.map((item) => (
                    <button
                      key={item.id}
                      className={s.card}
                      onClick={() => open(item)}
                      aria-label={`Open ${item.title}`}
                    >
                      <PublicMedia item={item} />
                      <span className={s.cardText}>
                        <span className={s.eyebrow}>
                          {categoryName(item.category)}
                        </span>
                        <strong>{item.title}</strong>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {gallery.next_cursor && (
                <button
                  className={`${s.button} ${s.more}`}
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                >
                  {loadingMore ? "Loading…" : "Load more creations"}
                </button>
              )}
            </section>
          )}
          {!!notice && (
            <p className={s.notice} role="status">
              {notice}
            </p>
          )}
        </>
      ) : null}
      {!!error && (
        <section className={s.message} role="alert">
          <p>{error}</p>
          <button
            className={s.button}
            onClick={() => setRevision((n) => n + 1)}
          >
            Try again
          </button>
          {postId && (
            <button className={s.button} onClick={() => open()}>
              Back to gallery
            </button>
          )}
        </section>
      )}
      <footer className={s.footer}>
        Published media shared by its creator. No account is needed to view this
        gallery.
      </footer>
    </main>
  );
}

function categoryName(category: string) {
  return (
    (
      {
        video: "Video",
        music: "Music & Film",
        games: "Games",
        live: "Live",
        nft: "Collectibles",
        store: "Store",
      } as Record<string, string>
    )[category] || "Creation"
  );
}

function PublicMedia({
  item,
  full = false,
}: {
  item: PublicGalleryItem;
  full?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const video = item.content_type.startsWith("video/"),
    audio = item.content_type.startsWith("audio/");
  if (failed)
    return (
      <div className={s.mediaFallback}>
        <Film size={30} />
        <span>Media preview unavailable</span>
        {full && (
          <a href={item.media_url} target="_blank" rel="noopener noreferrer">
            Open original media
          </a>
        )}
      </div>
    );
  if (video)
    return (
      <video
        className={full ? s.fullMedia : s.media}
        src={item.media_url}
        muted={!full}
        controls={full}
        playsInline
        preload="metadata"
        onError={() => setFailed(true)}
        onLoadedMetadata={(event) => {
          if (!full && Number.isFinite(event.currentTarget.duration))
            event.currentTarget.currentTime = Math.min(
              0.1,
              event.currentTarget.duration / 2,
            );
        }}
      />
    );
  if (audio)
    return (
      <div className={s.audio}>
        <Music2 size={full ? 48 : 30} />
        <span>Audio creation</span>
        {full && (
          <audio
            src={item.media_url}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
          />
        )}
      </div>
    );
  return (
    <img
      className={full ? s.fullMedia : s.media}
      src={item.media_url}
      alt={item.title}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
