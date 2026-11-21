import type { LunaUnload } from '@luna/core';
import { PlayState, redux } from '@luna/lib';
import { ShuffleEngine, Track } from './shuffleEngine';
import { Settings, pluginSettings } from './Settings';

// Luna calls everything in this set when the plugin is disabled/reloaded.
export const unloads = new Set<LunaUnload>();

export { Settings };

const PLAY_COUNTS_KEY = 'smart_shuffle_play_counts';

// Tidal's track data has no personal play count, so we count plays ourselves (only plays since install).
function getPlayCounts(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PLAY_COUNTS_KEY) || '{}');
  } catch {
    return {};
  }
}

function toTrack(mediaItemId: string, counts: Record<string, number>): Track {
  const item = (redux.store.getState().content.mediaItems as Record<string, any>)[mediaItemId]?.item;
  return {
    id: String(mediaItemId),
    title: item?.title ?? '',
    artist: item?.artist?.name ?? item?.artists?.[0]?.name ?? '',
    playCount: counts[String(mediaItemId)] ?? 0,
  };
}

/** Ask Tidal for "suggested tracks" for the playlist the queue came from. Returns [] on any failure. */
async function fetchPlaylistSuggestions(playlistUUID: string, exclude: Set<string>): Promise<Track[]> {
  try {
    const res: any = await redux.interceptActionResp(
      () => redux.actions['content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS']({ playlistUUID, reset: true }),
      unloads,
      ['content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_SUCCESS'],
      ['content/LOAD_PLAYLIST_SUGGESTED_MEDIA_ITEMS_FAIL'],
      { timeoutMs: 8000 },
    );
    const recs: Track[] = [];
    for (const m of res?.mediaItems ?? []) {
      const item = m?.item;
      if (m?.type !== 'track' || !item?.id || exclude.has(String(item.id))) continue;
      recs.push({
        id: String(item.id),
        title: item.title ?? '',
        artist: item.artist?.name ?? item.artists?.[0]?.name ?? '',
        isRecommendation: true,
      });
    }
    console.log(`[TrueShuffle] Tidal returned ${recs.length} usable suggestions for the playlist.`);
    return recs;
  } catch (err) {
    console.warn('[TrueShuffle] Could not load playlist suggestions, falling back to plain shuffle.', err);
    return [];
  }
}

async function reorder(tracks: Track[], pq: any, excludeIds: Set<string>): Promise<Track[]> {
  switch (pluginSettings.mode) {
    case 'least_played':
      return ShuffleEngine.weightedShuffle(tracks, 'least_played', pluginSettings.playCountExponent);
    case 'most_played':
      return ShuffleEngine.weightedShuffle(tracks, 'most_played', pluginSettings.playCountExponent);
    case 'fun':
      return ShuffleEngine.funShuffle(tracks, pluginSettings.artistSpacing);
    case 'smart_shuffle': {
      const isPlaylist = String(pq.sourceEntityType ?? '').toLowerCase() === 'playlist' && pq.sourceEntityId;
      if (!isPlaylist) {
        console.log('[TrueShuffle] Smart Shuffle only works when shuffling a playlist; using plain shuffle.');
        return ShuffleEngine.trueRandom(tracks);
      }
      // The suggestions request doesn't take seed tracks, so the "seed sample size" isn't used.
      return ShuffleEngine.smartShuffle(
        tracks,
        () => fetchPlaylistSuggestions(String(pq.sourceEntityId), excludeIds),
        pluginSettings.smartShuffleRatio,
        pluginSettings.smartSampleSize,
      );
    }
    case 'true_random':
    default:
      return ShuffleEngine.trueRandom(tracks);
  }
}

/**
 * Tidal shuffles the queue itself (seeded). When that happens we take the queue
 * after the current track and re-order it with the selected algorithm.
 */
async function applyCustomShuffle(seed: number) {
  if (!pluginSettings.enabled) return;
  const pq = PlayState.playQueue;
  if (!pq.shuffleModeEnabled) return;

  const head = pq.elements.slice(0, pq.currentIndex + 1); // keep history + current track untouched
  const tail = pq.elements.slice(pq.currentIndex + 1);
  if (tail.length < 2) return;

  const counts = getPlayCounts();
  const byId = new Map<string, (typeof tail)[number][]>();
  for (const el of tail) {
    const key = String(el.mediaItemId);
    byId.set(key, [...(byId.get(key) ?? []), el]);
  }
  const queuedIds = new Set<string>(pq.elements.map((el: any) => String(el.mediaItemId)));

  const reordered = await reorder(
    tail.map((el: any) => toTrack(String(el.mediaItemId), counts)),
    pq,
    queuedIds,
  );

  // The suggestions request is async: if the user shuffled again meanwhile, drop this result.
  if (PlayState.playQueue.lastShuffleSeed !== seed) {
    console.log('[TrueShuffle] Queue changed while working, skipping this re-order.');
    return;
  }

  // Split into queue tracks (re-ordered) and suggested tracks (inserted afterwards).
  const newTail: any[] = [];
  const inserts: { index: number; id: string }[] = [];
  reordered.forEach((t, i) => {
    if (t.isRecommendation) inserts.push({ index: head.length + i, id: t.id });
    else newTail.push(byId.get(t.id)!.shift()!);
  });

  const wasPlaying = PlayState.playing;
  const current = PlayState.playQueue;
  console.log(
    `[TrueShuffle] Re-ordering ${newTail.length} queued tracks (+${inserts.length} suggestions) using mode "${pluginSettings.mode}" ` +
      `(state=${PlayState.state}, desired=${PlayState.desiredState}, index=${current.currentIndex}).`,
  );
  redux.actions['playQueue/RESET']({
    ...current,
    elements: [...head, ...newTail],
    currentIndex: current.currentIndex,
  });

  // Insert suggestions at their final positions, in ascending order so earlier inserts shift later ones correctly.
  for (const { index, id } of inserts) {
    redux.actions['playQueue/ADD_AT_INDEX']({ context: { type: 'UNKNOWN' }, mediaItemIds: [id], index });
  }

  // The reset can stop playback. If the user was playing, check shortly after and resume.
  setTimeout(() => {
    console.log(`[TrueShuffle] After reset: state=${PlayState.state}, desired=${PlayState.desiredState}.`);
    if (wasPlaying && PlayState.state !== 'PLAYING') {
      console.log('[TrueShuffle] Playback was stopped by the reset, resuming.');
      PlayState.play();
    }
  }, 800);
}

// Detect every time Tidal applies a new shuffle (it stores the seed it used).
let lastSeed = PlayState.playQueue.lastShuffleSeed;
const unsubscribe = redux.store.subscribe(() => {
  const seed = redux.store.getState().playQueue.lastShuffleSeed;
  if (seed === lastSeed) return;
  lastSeed = seed;
  // Defer so we never dispatch from inside the store's own update cycle.
  setTimeout(() => {
    applyCustomShuffle(seed).catch((err) => console.error('[TrueShuffle] Failed to apply custom shuffle.', err));
  }, 0);
});
unloads.add(unsubscribe);

// Count plays so Least/Most Played has something to work with.
PlayState.onScrobble(unloads, (mediaItem) => {
  const counts = getPlayCounts();
  counts[String(mediaItem.id)] = (counts[String(mediaItem.id)] ?? 0) + 1;
  try {
    localStorage.setItem(PLAY_COUNTS_KEY, JSON.stringify(counts));
  } catch {
    /* storage full/unavailable: ignore */
  }
});

console.log('[TrueShuffle] Plugin initialized; watching the play queue for shuffles.');
