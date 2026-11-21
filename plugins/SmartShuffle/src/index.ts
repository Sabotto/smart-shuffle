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

function reorder(tracks: Track[]): Track[] {
  switch (pluginSettings.mode) {
    case 'least_played':
      return ShuffleEngine.weightedShuffle(tracks, 'least_played', pluginSettings.playCountExponent);
    case 'most_played':
      return ShuffleEngine.weightedShuffle(tracks, 'most_played', pluginSettings.playCountExponent);
    case 'fun':
      return ShuffleEngine.funShuffle(tracks, pluginSettings.artistSpacing);
    case 'smart_shuffle':
      // No recommendation API found in Luna, so this mode currently falls back to true random.
      return ShuffleEngine.trueRandom(tracks);
    case 'true_random':
    default:
      return ShuffleEngine.trueRandom(tracks);
  }
}

/**
 * Tidal shuffles the queue itself (seeded). When that happens we take the queue
 * after the current track and re-order it with the selected algorithm.
 */
function applyCustomShuffle() {
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

  const reordered = reorder(tail.map((el: any) => toTrack(String(el.mediaItemId), counts)));
  const newTail = reordered.map((t) => byId.get(t.id)!.shift()!);

  console.log(`[TrueShuffle] Re-ordered ${newTail.length} queued tracks using mode "${pluginSettings.mode}".`);
  redux.actions['playQueue/RESET']({
    ...pq,
    elements: [...head, ...newTail],
    currentIndex: pq.currentIndex,
  });
}

// Detect every time Tidal applies a new shuffle (it stores the seed it used).
let lastSeed = PlayState.playQueue.lastShuffleSeed;
const unsubscribe = redux.store.subscribe(() => {
  const seed = redux.store.getState().playQueue.lastShuffleSeed;
  if (seed === lastSeed) return;
  lastSeed = seed;
  // Defer so we never dispatch from inside the store's own update cycle.
  setTimeout(() => {
    try {
      applyCustomShuffle();
    } catch (err) {
      console.error('[TrueShuffle] Failed to apply custom shuffle.', err);
    }
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
