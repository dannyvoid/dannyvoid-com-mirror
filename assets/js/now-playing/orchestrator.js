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
  const serverProgress = Math.max(0, Number(payload.progress_ms) || 0);
  const duration = Math.max(
    0,
    Number(payload.duration_ms) || Number(track.duration_ms) || 0
  );
  const isPlaying = !!payload.is_playing;
  let progress = serverProgress;

  // ABS (and slow polls) often re-send the same progress_ms with a fresh
  // fetched_at. If we always reset, the clock ticks +1s then snaps back.
  // Keep monotonic client progress unless the server jumped ahead (seek) or
  // the duration changed (new chapter / track).
  const prev = state.liveSnap;
  if (prev && isPlaying && prev.is_playing) {
    const sameDuration =
      Math.abs((Number(prev.duration_ms) || 0) - duration) < 750;
    if (sameDuration) {
      let clientProgress = Math.max(0, Number(prev.progress_ms) || 0);
      clientProgress += Math.max(0, Date.now() - (prev.fetched_at || Date.now()));
      if (duration > 0) clientProgress = Math.min(clientProgress, duration);
      const lead = clientProgress - serverProgress;
      if (lead > 15000) {
        // Client drifted too far from a stuck snapshot - resync.
        progress = serverProgress;
      } else if (serverProgress >= clientProgress) {
        progress = serverProgress;
      } else {
        progress = clientProgress;
      }
    }
  }

  if (duration > 0) progress = Math.min(progress, duration);

  state.setLiveSnapValue({
    progress_ms: progress,
    duration_ms: duration,
    // Anchor ticks from "now" using the (possibly extrapolated) progress.
    fetched_at: Date.now(),
    is_playing: isPlaying
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

  // Freshest active source wins. Do not hard-stick to the current card while
  // another origin is clearly newer (e.g. paused ABS still "active" + live Plex).
  const activeEntries = Object.entries(active).filter(([, p]) => p);
  if (activeEntries.length) {
    activeEntries.sort((a, b) => {
      const providerA = providers.find((p) => p.id === a[0]);
      const providerB = providers.find((p) => p.id === b[0]);
      const scoreA = providerA ? providerA.activityAt(a[1]) : 0;
      const scoreB = providerB ? providerB.activityAt(b[1]) : 0;
      return scoreB - scoreA;
    });

    const [freshestSource, freshestPayload] = activeEntries[0];
    const currentPayload = active[state.activeSource];
    if (currentPayload && state.activeSource) {
      const currentProvider = providers.find((p) => p.id === state.activeSource);
      const freshestProvider = providers.find((p) => p.id === freshestSource);
      const currentScore = currentProvider
        ? currentProvider.activityAt(currentPayload)
        : 0;
      const freshestScore = freshestProvider
        ? freshestProvider.activityAt(freshestPayload)
        : 0;
      // Soft stick: keep the current card unless another source leads by >2s.
      if (freshestScore <= currentScore + 2000) {
        await applyLiveSourcePayload(state.activeSource, currentPayload);
        return;
      }
    }

    await applyLiveSourcePayload(freshestSource, freshestPayload);
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
