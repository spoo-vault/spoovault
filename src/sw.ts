import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";
import {
  createSyncEventHandler,
  handleClientMessage,
} from "./services/offline/swSyncBridge";

interface ExtendableEventLike {
  waitUntil: (promise: Promise<unknown>) => void;
}

interface SyncEventLike extends ExtendableEventLike {
  tag: string;
}

interface MessageEventLike extends ExtendableEventLike {
  data?: unknown;
  source: ClientMessageSource | null;
}

interface ClientMessageSource {
  postMessage: (message: unknown) => void;
}

interface ClientListLike {
  claim: () => Promise<void>;
  matchAll: (options?: { type?: string; includeUncontrolled?: boolean }) => Promise<
    ClientMessageSource[]
  >;
}

interface ServiceWorkerScopeLike {
  location: { origin: string };
  registration: Parameters<typeof handleClientMessage>[1];
  clients: ClientListLike;
  skipWaiting: () => Promise<void>;
  addEventListener(type: "install", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "activate", listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: "sync", listener: (event: SyncEventLike) => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
}

const swSelf = self as unknown as ServiceWorkerScopeLike;

const SHELL_CACHE = "spoovault-shell-v1";
const ASSET_CACHE = "spoovault-assets-v1";
const IPFS_CACHE = "spoovault-ipfs-v1";

const KNOWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE, IPFS_CACHE]);

swSelf.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(["/", "/index.html"]))
      .then(() => swSelf.skipWaiting())
  );
});

swSelf.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => !KNOWN_CACHES.has(key))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => swSelf.clients.claim())
  );
});

// SPA navigations: try the network first so users get fresh builds, fall back
// to the cached shell when offline.
registerRoute(
  ({ request }) => request.mode === "navigate",
  new NetworkFirst({
    cacheName: SHELL_CACHE,
    plugins: [
      new ExpirationPlugin({ maxEntries: 8, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    ],
  })
);

// Hashed static assets: serve from cache instantly, refresh in background.
registerRoute(
  ({ url, request }) =>
    url.origin === swSelf.location.origin &&
    ["script", "style", "image", "font", "worker"].includes(request.destination),
  new StaleWhileRevalidate({
    cacheName: ASSET_CACHE,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 120,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// IPFS gateway content is immutable — cache aggressively for offline document
// metadata inspection.
registerRoute(
  ({ url }) =>
    /pinata\.cloud$/.test(url.hostname) && url.pathname.includes("/ipfs/"),
  new CacheFirst({
    cacheName: IPFS_CACHE,
    plugins: [
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 30 * 24 * 60 * 60,
        purgeOnQuotaError: true,
      }),
    ],
  })
);

// Background sync: the browser fires this when connectivity returns after
// actions were queued with our tag. Wake every open window so the Dexie-backed
// queue can be replayed through contractService (wallet-signed transactions
// must be executed in the page context).
swSelf.addEventListener(
  "sync",
  createSyncEventHandler(swSelf.clients, {
    onReplayBroadcast: (clientCount) => {
      if (clientCount === 0) {
        // No window was open; nothing to wake. The next app launch drains the
        // queue on startup via initOfflineLayer().
      }
    },
  })
);

// Clients ask the worker to register the sync tag right after queueing an
// action while offline, keeping the registration alive even if the page closes.
swSelf.addEventListener("message", (event) => {
  const source = event.source;
  event.waitUntil(
    handleClientMessage(event.data, swSelf.registration, (reply) => {
      source?.postMessage(reply);
    })
  );
});

clientsClaim();
