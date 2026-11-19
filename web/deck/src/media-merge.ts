import type { Media } from './types'

/** Keep the last cover when an agent update omits artwork for the same track. */
export function mediaWithPreviousArtwork(prev: Media | null, next: Media): Media {
  if (next.artwork || !prev?.artwork) return next
  if (prev.app !== next.app || prev.title !== next.title || prev.artist !== next.artist) return next
  return { ...next, artwork: prev.artwork }
}
