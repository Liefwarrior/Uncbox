// How much of the encoded game video the replay buffer keeps, kept apart from the worker so it can
// be tested. Timestamps are in seconds, like mediabunny's EncodedPacket.

export interface Kept {
  timestamp: number;
  type: 'key' | 'delta';
}

/** Slack past the clip length, so a clip can start on the keyframe just before it. */
const SLACK = 1;

/**
 * Where the buffer should start: the newest keyframe at least `seconds` old, so a clip is a full
 * `seconds` long. When that keyframe is from before a pause in the capture (a minimized game sends
 * no frames), it would make a clip as long as the pause, so then it's the first keyframe of the
 * last `seconds` instead.
 */
export function keepFrom(packets: readonly Kept[], seconds: number): number {
  if (!packets.length) return 0;
  const newest = packets[packets.length - 1].timestamp;
  let cut = 0;
  for (let i = 0; i < packets.length; i++) {
    if (newest - packets[i].timestamp < seconds) break;
    if (packets[i].type === 'key') cut = i;
  }
  if (newest - packets[cut].timestamp <= seconds + SLACK) return cut;
  const recent = packets.findIndex((p) => p.type === 'key' && newest - p.timestamp <= seconds + SLACK);
  return recent < 0 ? cut : recent;
}

/**
 * The capture's clock went backwards (it restarted). What's kept is then started again: a clip's
 * times have to rise, and the "is a frame due" check would otherwise skip every frame from then on.
 */
export const goesBack = (last: number, next: number) => next < last;
