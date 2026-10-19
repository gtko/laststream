export { loadAc3Decoder, isAc3Codec, sampleToAudioData, type Ac3Loader } from './ac3';
export { GuestPlayer, type GuestPlayerOptions } from './player';
export {
  AUDIO_DECODED_AHEAD_SEC,
  GUEST_BUFFER_MAX_BYTES,
  GUEST_BUFFER_TARGET_SEC,
  placeSegment,
  ReadAheadReader,
  type AudioAnchor,
  type ReadAheadOptions,
  type SegmentPlacement,
} from './buffer';
export { openMedia, type OpenedMedia } from './demux';
export { checkSupport, codecLabel, defaultCodecEnv, type CodecEnv, type TrackSet } from './detect';
export {
  registerFallback,
  resolvePlayback,
  unsupportedMessage,
  type FallbackContext,
  type FallbackHandler,
} from './fallback';
export {
  DRIFT_SEEK_THRESHOLD_S,
  FRAME_EPSILON_S,
  audioSchedule,
  canFeed,
  expectedPosition,
  mediaClock,
  needsResync,
  pickFrame,
  type FeedLimits,
  type FeedState,
} from './sync';
export type {
  AudioTrackInfo,
  ByteSourceStats,
  GuestStats,
  MediaInfo,
  PlaybackPlan,
  PlayerCallbacks,
  PlayerState,
  PlayerStats,
  RangeReader,
  RoomState,
  SupportResult,
  VideoTrackInfo,
} from './types';
