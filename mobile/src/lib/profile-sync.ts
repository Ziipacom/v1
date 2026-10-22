import type { ProfileImages } from "./types";

/** In-memory only: an old read must never replace a newer account image receipt. */
export function createProfileImageSync(options: {
  currentToken: () => string | null;
  read: (token: string) => Promise<ProfileImages>;
  apply: (profile: ProfileImages) => void;
}) {
  let sequence = 0;
  let accepted = 0;
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
    async refresh(token: string) {
      if (!owns(token)) return false;
      const read = ++sequence;
      const profile = await options.read(token);
      if (read < accepted || !owns(token)) return false;
      accepted = read;
      options.apply(profile);
      return true;
    },
  };
}
