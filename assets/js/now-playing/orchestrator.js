const V = new URL(import.meta.url).searchParams.get("v") || "0";
const { bust } = await import(`./load.js?v=${encodeURIComponent(V)}`);
const state = await import(bust(import.meta.url, "./state.js"));

const liveCard = await import(bust(import.meta.url, "./live-card.js"));
const lastfm = await import(bust(import.meta.url, "./providers/lastfm.js"));
const spotify = await import(bust(import.meta.url, "./providers/spotify.js"));
const audiobooks = await import(bust(import.meta.url, "./providers/audiobooks.js"));
const plex = await import(bust(import.meta.url, "./providers/plex.js"));

const { applyLiveProgressDom } = liveCard;

const LIVE_POLL_VISIBLE_MS = 2000;
const LIVE_POLL_HIDDEN_MS = 20000;
const LIVE_CLIENT_STICKY_MS = 45000;

const providers = [plex, audiobooks, spotify];

function stopLastFmPolling() {
  // Invalidate in-flight Last.fm fetches so they cannot patch a live origin card
  state.bumpLastFmUpdateSeq();
  if (state.lastFmIntervalId) {
    clearInterval(state.lastFmIntervalId);
    state.setLastFmIntervalId(null);
  }
}

function startLastFmPolling() {
  if (state.lastFmIntervalId) return;
  lastfm.updateLastFmData();
  state.setLastFmIntervalId(setInterval(lastfm.updateLastFmData, lastfm.sleepTime));
}

function stopLiveProgressTimer() {
  if (state.liveProgressTimer) {
    clearInterval(state.liveProgressTimer);
    state.setLiveProgressTimer(null);
  }
}

function startLiveProgressTimer() {
  if (state.liveProgressTimer) return;
  state.setLiveProgressTimer(setInterval(applyLiveProgressDom, 250));
}

function stopLivePollTimerOnly() {
  if (state.livePollTimer) {
    clearTimeout(state.livePollTimer);
    state.setLivePollTimer(null);
  }
}

function rememberSourceSticky(source, payload) {
  if (!state.lastLiveBySource[source]) return;
  state.lastLiveBySource[source] = { payload, at: Date.now() };
}

function clearSourceSticky(source) {
  if (!state.lastLiveBySource[source]) return;
  state.lastLiveBySource[source] = { payload: null, at: 0 };
}

function clearAllLiveSticky() {
  clearSourceSticky("plex");
  clearSourceSticky("audiobookshelf");
  clearSourceSticky("spotify");
}

function isUsableLivePayload(payload) {
  return !!(
    payload &&
    !payload.error &&
    payload.playing &&
    payload.track &&
    payload.track.name
  );
}

function isActiveLivePayload(payload) {
  return isUsableLivePayload(payload) && !!payload.is_playing;
}

/**
 * Resolve a polled payload into an active candidate (or null).
 * Explicit idle clears sticky; miss/timeout may reuse last active briefly.
 */
function resolveActiveCandidate(source, raw) {
  const miss = !raw || !!raw.error;
  const idle = !!(raw && !raw.error && raw.playing === false);
  if (isActiveLivePayload(raw)) {
    rememberSourceSticky(source, raw);
    return raw;
  }
  if (idle) {
    clearSourceSticky(source);
    return null;
  }
  const held = state.lastLiveBySource[source];
  if (
    miss &&
    held &&
    held.payload &&
    isActiveLivePayload(held.payload) &&
    Date.now() - held.at <= LIVE_CLIENT_STICKY_MS
  ) {
    return held.payload;
  }
  if (miss) clearSourceSticky(source);
  return null;
}

function setLiveSnap(payload) {
  const track = payload.track || {};
  state.setLiveSnapValue({
    progress_ms: Number(payload.progress_ms) || 0,
    duration_ms: Number(payload.duration_ms) || Number(track.duration_ms) || 0,
    fetched_at: Number(payload.fetched_at) || Date.now(),
    is_playing: !!payload.is_playing
  });
}

function enterLastFmFallback() {
  stopLiveProgressTimer();
  state.setLiveTrackId("");
  state.setLiveSnapValue(null);
  state.setSpotifyAsideKey("");
  clearAllLiveSticky();
  if (state.activeSource === "lastfm") return;
  state.setActiveSource("lastfm");
  state.setLastTrackIdentity("");
  startLastFmPolling();
}

const ctx = {
  enterLastFmFallback,
  stopLastFmPolling,
  startLiveProgressTimer,
  setLiveSnap
};

async function applyLiveSourcePayload(source, payload) {
  if (source === "plex") return plex.apply(payload, ctx);
  if (source === "audiobookshelf") return audiobooks.apply(payload, ctx);
  if (source === "spotify") return spotify.apply(payload, ctx);
}

async function tickLiveSources() {
  const [plexPayload, absPayload, spotifyPayload] = await Promise.all([
    plex.fetchStatus(),
    audiobooks.fetchStatus(),
    spotify.fetchStatus()
  ]);

  const active = {
    plex: resolveActiveCandidate("plex", plexPayload),
    audiobookshelf: resolveActiveCandidate("audiobookshelf", absPayload),
    spotify: resolveActiveCandidate("spotify", spotifyPayload)
  };

  // Sticky: keep showing the current source while it remains active.
  if (active[state.activeSource]) {
    await applyLiveSourcePayload(state.activeSource, active[state.activeSource]);
    return;
  }

  // Else freshest among actives (no brand hierarchy).
  const activeEntries = Object.entries(active).filter(([, p]) => p);
  if (activeEntries.length) {
    activeEntries.sort((a, b) => {
      const providerA = providers.find((p) => p.id === a[0]);
      const providerB = providers.find((p) => p.id === b[0]);
      const scoreA = providerA ? providerA.activityAt(a[1]) : 0;
      const scoreB = providerB ? providerB.activityAt(b[1]) : 0;
      return scoreB - scoreA;
    });
    const [source, payload] = activeEntries[0];
    await applyLiveSourcePayload(source, payload);
    return;
  }

  // Spotify paused is the only paused live card we surface.
  if (spotify.isPausedPresent(spotifyPayload)) {
    await spotify.apply(spotifyPayload, ctx);
    return;
  }

  enterLastFmFallback();
}

function scheduleLivePoll() {
  stopLivePollTimerOnly();
  const delay = document.hidden ? LIVE_POLL_HIDDEN_MS : LIVE_POLL_VISIBLE_MS;
  state.setLivePollTimer(
    setTimeout(async () => {
      await tickLiveSources();
      scheduleLivePoll();
    }, delay)
  );
}

export function startOrchestrator() {
  tickLiveSources().finally(() => {
    scheduleLivePoll();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      tickLiveSources();
      scheduleLivePoll();
    }
  });
}
