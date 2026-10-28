import type { ProfileImages } from "./types";

/** In-memory only: an old read must never replace a newer account image receipt. */
export function createProfileImageSync(options: {
  currentToken: () => string | null;
  read: (token: string) => Promise<ProfileImages>;
  apply: (profile: ProfileImages) => void;
}) {
  let sequence = 0;
  let accepted = 0;
  let inFlight: {
    token: string;
    read: number;
    promise: Promise<boolean>;
  } | null = null;
  const owns = (token: string) => !!token && options.currentToken() === token;
  return {
    invalidate() {
      accepted = ++sequence;
    },
    beginBootstrap() {
      return ++sequence;
    },
    hasNewerThan(stamp: number) {
      return accepted > stamp;
    },
    acceptBootstrap(stamp: number, token: string) {
      if (!owns(token) || stamp < accepted) return false;
      accepted = stamp;
      return true;
    },
    record(profile: ProfileImages, token: string) {
      if (!owns(token)) return false;
      accepted = ++sequence;
      options.apply(profile);
      return true;
    },
    refresh(token: string, { force = false }: { force?: boolean } = {}) {
      if (!owns(token)) return Promise.resolve(false);
      // Focus and foreground callbacks may ask for the same metadata together.
      // Share only this pending read; a write, invalidation, bootstrap start or
      // explicit forced read changes the sequence and requires a fresh request.
      if (!force && inFlight?.token === token && inFlight.read === sequence)
        return inFlight.promise;
      const read = ++sequence;
      const pending = (async () => {
        const profile = await options.read(token);
        if (read < accepted || !owns(token)) return false;
        accepted = read;
        options.apply(profile);
        return true;
      })();
      const flight = {
        token,
        read,
        promise: pending.finally(() => {
          if (inFlight === flight) inFlight = null;
        }),
      };
      inFlight = flight;
      return flight.promise;
    },
  };
}
