import { checkedLivepeerEdge, checkedWhipUrl } from "./live-types.ts";

type DiscoveryFetch = (
  url: string,
  init: {
    method: "HEAD";
    credentials: "omit";
    redirect: "manual";
    signal: AbortSignal;
  },
) => Promise<Pick<Response, "status" | "headers">>;

/** Validate every redirect before disclosing an owner ingest URL to the next host. */
export async function discoverNativeWhipEdge(
  endpoint: string,
  signal: AbortSignal,
  fetcher: DiscoveryFetch,
) {
  let current = checkedWhipUrl(endpoint);
  for (let redirects = 0; redirects < 4; redirects++) {
    if (signal.aborted) throw new Error("Connection cancelled.");
    const response = await fetcher(current, {
      method: "HEAD",
      credentials: "omit",
      redirect: "manual",
      signal,
    });
    if (signal.aborted) throw new Error("Connection cancelled.");
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (response.status < 200 || response.status >= 300)
        throw new Error("Broadcast edge discovery failed.");
      return checkedLivepeerEdge(current);
    }
    const next = response.headers.get("location");
    if (!next || next.length > 2048)
      throw new Error("Invalid broadcast edge redirect.");
    current = checkedLivepeerEdge(new URL(next, current).toString()).toString();
  }
  throw new Error("Too many broadcast edge redirects.");
}
