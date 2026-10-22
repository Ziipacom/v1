/** A transport abort is best effort; the caller must still settle by its deadline. */
export class OperationTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationTimeoutError";
  }
}

/** A lost write acknowledgement is not evidence that nothing was saved. */
export class ApiRequestError extends Error {
  constructor(
    public readonly outcome: "unconfirmed" | "unavailable",
    public readonly timedOut: boolean,
  ) {
    super(
      outcome === "unconfirmed"
        ? "Ziipa did not confirm this change. Refresh before trying again; it may have completed."
        : timedOut
          ? "Ziipa is taking too long to respond. Check your connection and try again."
          : "Cannot reach Ziipa. Check your connection and try again.",
    );
    this.name = "ApiRequestError";
  }
}

/** Ignore late results and consume cancellation failures without waiting for them. */
export function withDeadline<T>(
  run: (isActive: () => boolean) => Promise<T>,
  timeoutMs: number,
  timeoutError: OperationTimeoutError,
  cancel?: () => unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let active = true;
    const timer = setTimeout(() => {
      if (!active) return;
      active = false;
      // Reject independently: native cancellation may throw, reject or never settle.
      reject(timeoutError);
      try {
        void Promise.resolve(cancel?.()).catch(() => {});
      } catch {
        // A failed abort must not leave the UI waiting or expose native details.
      }
    }, timeoutMs);
    void Promise.resolve()
      .then(() => {
        if (!active) throw timeoutError;
        return run(() => active);
      })
      .then(
        (value) => {
          if (!active) return;
          active = false;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (!active) return;
          active = false;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}
