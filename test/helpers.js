export function createJitterTracker() {
  return {
    jitter: 0,
    previous: null
  };
}

export function observeTransit(tracker, sendTime, arrivalTime) {
  const transit = arrivalTime - sendTime;
  if (tracker.previous === null) {
    tracker.previous = transit;
    return tracker.jitter;
  }
  const absolute = Math.abs(transit - tracker.previous);
  tracker.previous = transit;
  tracker.jitter = tracker.jitter + (absolute - tracker.jitter) / 16;
  return tracker.jitter;
}

export function clampDelay(jitter, minDelay, maxDelay) {
  if (jitter < minDelay) {
    return minDelay;
  }
  if (jitter > maxDelay) {
    return maxDelay;
  }
  return jitter;
}

export function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return mixed >>> 0;
  };
}

export function sequencesOf(released) {
  return released.packets.map((packet) => packet.sequence);
}
