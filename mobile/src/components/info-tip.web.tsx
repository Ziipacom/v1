import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactPortal,
} from "react";
import { color, font, useTheme } from "../theme";
import type { InfoTipProps } from "./info-tip";
// React DOM is an existing web dependency; keep this small surface typed without
// adding a native dependency or changing the release lockfile.
const { createPortal } = require("react-dom") as {
  createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
  ): ReactPortal;
};

export function InfoTip({ title, content }: InfoTipProps) {
  useTheme();
  const button = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280 });
  const id = useId();
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  };
  const close = () => {
    cancelClose();
    pinned.current = false;
    setOpen(false);
  };
  const leave = () => {
    cancelClose();
    if (!pinned.current && !focused)
      closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const rect = button.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(300, window.innerWidth - 32);
      const height = tooltip.current?.offsetHeight || 140;
      setPosition({
        width,
        left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
        top: Math.max(
          8,
          rect.bottom + height + 12 <= window.innerHeight
            ? rect.bottom + 6
            : rect.top - height - 6,
        ),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    const outside = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !tooltip.current?.contains(event.target as Node)
      )
        close();
    };
    document.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      document.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open, content]);
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={`About ${title}`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onPointerEnter={() => {
          cancelClose();
          setOpen(true);
        }}
        onPointerLeave={leave}
        onFocus={() => {
          setFocused(true);
          cancelClose();
          setOpen(true);
        }}
        onBlur={() => {
          setFocused(false);
          close();
        }}
        onClick={(event) => {
          event.stopPropagation();
          cancelClose();
          const next = !pinned.current;
          pinned.current = next;
          setOpen(next);
        }}
        style={{
          width: 24,
          height: 24,
          flexShrink: 0,
          border: 0,
          borderRadius: 5,
          padding: 6,
          background: "transparent",
          color: color.muted,
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          outline: focused ? `2px solid ${color.purple}` : "none",
          outlineOffset: 1,
        }}
      >
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" />
          <path d="M12 7h.01" />
        </svg>
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={tooltip}
              id={id}
              role="tooltip"
              onPointerEnter={cancelClose}
              onPointerLeave={leave}
              style={{
                position: "fixed",
                ...position,
                boxSizing: "border-box",
                zIndex: 2147483000,
                padding: 14,
                borderRadius: 12,
                border: `1px solid ${color.border}`,
                background: color.panel,
                color: color.text,
                boxShadow: "0 5px 24px #0003",
                fontFamily: font.regular,
                fontSize: 13,
                lineHeight: "19px",
                overflowWrap: "anywhere",
              }}
            >
              <div
                style={{
                  fontFamily: font.semibold,
                  fontSize: 14,
                  marginBottom: 6,
                }}
              >
                {title}
              </div>
              {content}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
