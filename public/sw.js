// Service worker: offline cache, update handover, push reminders, and the Done / Snooze buttons.
// Registered as a module (see main.js), so it can share code with the page.
// Bump CACHE whenever you change any file so phones pick up the new version.

import { loadState, update, st } from "./js/state.js";
import { syncReminders, snoozeTag, itemFromTag } from "./js/sync.js";
import { dateKey, hhmm } from "./js/util.js";

const CACHE = "routine-v5";
const FILES = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "badge-96.png",
  "js/main.js",
  "js/config.js",
  "js/util.js",
  "js/db.js",
  "js/defaults.js",
  "js/state.js",
  "js/schedule.js",
  "js/sync.js",
  "js/push.js",
  "js/views/today.js",
  "js/views/routine.js",
  "js/views/progress.js",
];

const SNOOZE_MINUTES = 15;
const STATE_WAIT_MS = 3000; // longest a push waits for storage before showing the reminder anyway

// ---------- install, update, offline ----------

// Install quietly and wait: the app shows an "update ready" banner and tells us when to take over.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Serve from cache straight away, refreshing the cached copy in the background.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fresh = fetch(event.request, { cache: "no-cache" })
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});

// ---------- reminders ----------

/** Tell any open copy of the app to reload its data. */
async function refreshPages() {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of windows) w.postMessage({ type: "state-changed" });
}

/** Reject if a promise takes longer than `ms`, so a stalled step can't block what comes after it. */
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data && event.data.text() };
  }
  event.waitUntil(onPush(data));
});

async function onPush(data) {
  const tag = data.tag || "routine";
  let item = null;
  let stateReady = false;
  try {
    // Storage can stall (not just fail) when the app is open or frozen in the background.
    // Never let that stop the reminder: after STATE_WAIT_MS, show it without the buttons.
    await withTimeout(loadState({ create: false }), STATE_WAIT_MS);
    stateReady = true;
    item = st ? itemFromTag(st.routine, tag) : null;
  } catch {
    /* storage unavailable or too slow: still show the reminder */
  }

  await self.registration.showNotification(data.title || "Daily Routine", {
    body: data.body || "",
    tag,
    renotify: true,
    requireInteraction: !!item?.important,
    icon: "icon-192.png",
    badge: "badge-96.png",
    vibrate: item?.important ? [400, 150, 400, 150, 400] : [250, 100, 250],
    actions: item
      ? [
          { action: "done", title: "Done" },
          { action: "snooze", title: `Snooze ${SNOOZE_MINUTES} min` },
        ]
      : [],
    data: { url: "./" },
  });

  // Housekeeping after every push: drop a snooze that just went off, then re-sync, which
  // removes one-offs from past days and applies today's day off. Only writes if something changed.
  // Skipped when storage didn't answer in time; the next push or app open catches up.
  if (!stateReady || !st) return;
  try {
    if (tag.includes("~z")) {
      await update((s) => {
        s.snoozes = s.snoozes.filter((z) => snoozeTag(z) !== tag);
      });
    }
    await syncReminders();
  } catch {
    /* offline: try again on the next push */
  }
}

self.addEventListener("notificationclick", (event) => {
  const { action, notification } = event;
  notification.close();
  if (action === "done" || action === "snooze") {
    event.waitUntil(
      loadState({ create: false }).then(() => {
        const item = st && itemFromTag(st.routine, notification.tag);
        if (!item) return;
        return action === "done" ? markDone(item.id) : snooze(item.id, notification);
      }),
    );
  } else event.waitUntil(openApp(notification.data?.url));
});

async function markDone(id) {
  const today = dateKey();
  await loadState({ create: false });
  if (!st) return;
  await update((s) => {
    (s.done[today] ||= {})[id] = 1;
    s.snoozes = s.snoozes.filter((z) => !(z.id === id && z.date === today));
  });
  await refreshPages();
  try {
    await syncReminders();
  } catch {
    /* the tick is saved; the server catches up on the next sync */
  }
}

async function snooze(id, notification) {
  await loadState({ create: false });
  if (!st) return;
  const now = new Date();
  const at = now.getHours() * 60 + now.getMinutes() + SNOOZE_MINUTES;
  const fail = (body) =>
    self.registration.showNotification(notification.title, { body, tag: notification.tag, icon: "icon-192.png", badge: "badge-96.png" });

  if (at > 23 * 60 + 59) return fail("Too late in the day to snooze. Do it now or tick it off in the app.");
  const z = { id, date: dateKey(now), time: hhmm(at) };
  await update((s) => {
    s.snoozes = s.snoozes.filter((x) => !(x.id === id && x.date === z.date)).concat(z);
  });
  await refreshPages();
  if (!(await syncReminders())) {
    await update((s) => {
      s.snoozes = s.snoozes.filter((x) => snoozeTag(x) !== snoozeTag(z));
    });
    return fail("Couldn't snooze: no connection to the reminder server. Do it now instead.");
  }
}

async function openApp(url = "./") {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of windows) if ("focus" in w) return w.focus();
  return self.clients.openWindow(url);
}