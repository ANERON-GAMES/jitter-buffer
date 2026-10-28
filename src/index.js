export const SEQUENCE_MODULUS = 65536;
export const SEQUENCE_MAX = 65535;
export const SEQUENCE_HALF = 32768;
export const JITTER_DIVISOR = 16;
export const MAX_CAPACITY = SEQUENCE_HALF - 1;
export const DEFAULT_MIN_DELAY = 0;
export const DEFAULT_MAX_DELAY = Number.POSITIVE_INFINITY;
export const DEFAULT_CAPACITY = 64;

export const STORED = "stored";
export const DUPLICATE = "duplicate";
export const LATE = "late";
export const STALE = "stale";
export const TOO_FAR = "too-far";

export const STATUSES = Object.freeze([STORED, DUPLICATE, LATE, STALE, TOO_FAR]);

const SEQUENCE_MASK = SEQUENCE_MAX;

const OPTIONS_MESSAGE = "options must be an object";
const PACKET_MESSAGE = "packet must be an object";
const SEQUENCE_MESSAGE = "sequence must be an integer from 0 to 65535";
const MIN_DELAY_MESSAGE = "minDelay must be a finite number greater than or equal to 0";
const MAX_DELAY_MESSAGE =
  "maxDelay must be Infinity or a finite number greater than or equal to minDelay";
const CAPACITY_MESSAGE = "capacity must be an integer from 1 to 32767";
const SEND_MESSAGE = "sendTime must be a finite number";
const ARRIVAL_MESSAGE = "arrivalTime must be a finite number";
const NOW_MESSAGE = "now must be a finite number";
const DIFFERENCE_MESSAGE = "sendTime and arrivalTime difference must be finite";
const PLAYOUT_MESSAGE = "playout time must be finite";

function assertObject(value, message) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(message);
  }
}

function readOptional(object, key) {
  if (!Object.hasOwn(object, key)) {
    return undefined;
  }
  return object[key];
}

function readMinDelay(options) {
  const value = readOptional(options, "minDelay");
  if (value === undefined) {
    return DEFAULT_MIN_DELAY;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(MIN_DELAY_MESSAGE);
  }
  return value === 0 ? 0 : value;
}

function readMaxDelay(options, minDelay) {
  const value = readOptional(options, "maxDelay");
  if (value === undefined) {
    return DEFAULT_MAX_DELAY;
  }
  if (
    value !== Number.POSITIVE_INFINITY &&
    (typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new RangeError(MAX_DELAY_MESSAGE);
  }
  if (value < minDelay) {
    throw new RangeError(MAX_DELAY_MESSAGE);
  }
  return value === 0 ? 0 : value;
}

function readCapacity(options) {
  const value = readOptional(options, "capacity");
  if (value === undefined) {
    return DEFAULT_CAPACITY;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_CAPACITY) {
    throw new RangeError(CAPACITY_MESSAGE);
  }
  return value;
}

function readSequence(packet) {
  if (!Object.hasOwn(packet, "sequence")) {
    throw new RangeError(SEQUENCE_MESSAGE);
  }
  const value = packet.sequence;
  if (!Number.isInteger(value) || value < 0 || value > SEQUENCE_MAX) {
    throw new RangeError(SEQUENCE_MESSAGE);
  }
  return value | 0;
}

function readTimestamp(packet, key, message) {
  if (!Object.hasOwn(packet, key)) {
    throw new RangeError(message);
  }
  const value = packet[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(message);
  }
  return value;
}

function assertNow(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(NOW_MESSAGE);
  }
}

function forwardDelta(from, to) {
  return (to - from) & SEQUENCE_MASK;
}

function advanceSequence(sequence) {
  return (sequence + 1) & SEQUENCE_MASK;
}

function clamp(value, min, max) {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function emptyRelease() {
  return {
    packets: [],
    losses: []
  };
}

function previewTiming(state, sendTime, arrivalTime) {
  const transit = arrivalTime - sendTime;
  if (!Number.isFinite(transit)) {
    throw new RangeError(DIFFERENCE_MESSAGE);
  }

  let jitter = state.jitter;
  if (state.lastTransit !== null) {
    const difference = transit - state.lastTransit;
    if (!Number.isFinite(difference)) {
      throw new RangeError(DIFFERENCE_MESSAGE);
    }
    const absolute = Math.abs(difference);
    jitter = jitter + (absolute - jitter) / JITTER_DIVISOR;
    if (!Number.isFinite(jitter)) {
      throw new RangeError(DIFFERENCE_MESSAGE);
    }
  }

  const delay = clamp(jitter, state.minDelay, state.maxDelay);
  const playoutTime =
    state.anchor === null
      ? arrivalTime + delay
      : state.anchor.arrivalTime + delay + (sendTime - state.anchor.sendTime);
  if (!Number.isFinite(playoutTime)) {
    throw new RangeError(PLAYOUT_MESSAGE);
  }

  return {
    transit,
    jitter,
    delay,
    playoutTime
  };
}

export class JitterBuffer {
  #minDelay;
  #maxDelay;
  #capacity;
  #packets = [];
  #misses = new Map();
  #nextSequence = null;
  #anchor = null;
  #lastTransit = null;
  #jitter = 0;
  #delay = 0;

  constructor(options = {}) {
    assertObject(options, OPTIONS_MESSAGE);
    this.#minDelay = readMinDelay(options);
    this.#maxDelay = readMaxDelay(options, this.#minDelay);
    this.#capacity = readCapacity(options);
    this.#delay = this.#minDelay;
  }

  get minDelay() {
    return this.#minDelay;
  }

  get maxDelay() {
    return this.#maxDelay;
  }

  get capacity() {
    return this.#capacity;
  }

  get jitter() {
    return this.#jitter;
  }

  get delay() {
    return this.#delay;
  }

  get size() {
    return this.#packets.length;
  }

  get nextSequence() {
    return this.#nextSequence;
  }

  reset() {
    this.#packets = [];
    this.#misses = new Map();
    this.#nextSequence = null;
    this.#anchor = null;
    this.#lastTransit = null;
    this.#jitter = 0;
    this.#delay = this.#minDelay;
  }

  push(packet) {
    assertObject(packet, PACKET_MESSAGE);
    const sequence = readSequence(packet);
    const sendTime = readTimestamp(packet, "sendTime", SEND_MESSAGE);
    const arrivalTime = readTimestamp(packet, "arrivalTime", ARRIVAL_MESSAGE);
    const payload = Object.hasOwn(packet, "payload") ? packet.payload : undefined;
    const kind = this.#classify(sequence);
    if (kind !== "new") {
      return this.#result(kind, null);
    }

    const timing = previewTiming(this.#timingState(), sendTime, arrivalTime);
    this.#lastTransit = timing.transit;
    this.#jitter = timing.jitter;
    this.#delay = timing.delay;
    this.#begin(sequence);

    if (arrivalTime > timing.playoutTime) {
      this.#misses.set(sequence, timing.playoutTime);
      return this.#result(LATE, timing.playoutTime);
    }

    this.#packets.push(
      Object.freeze({
        sequence,
        sendTime,
        arrivalTime,
        playoutTime: timing.playoutTime,
        payload
      })
    );
    if (this.#anchor === null) {
      this.#anchor = {
        sendTime,
        arrivalTime
      };
    }
    return this.#result(STORED, timing.playoutTime);
  }

  pop(now) {
    assertNow(now);
    if (this.#nextSequence === null) {
      return emptyRelease();
    }

    const packets = [];
    const losses = [];
    let cursor = this.#nextSequence;

    for (let steps = 0; steps < this.#capacity; steps += 1) {
      const index = this.#findIndex(cursor);
      if (index !== -1) {
        const stored = this.#packets[index];
        if (stored.playoutTime > now) {
          break;
        }
        this.#packets.splice(index, 1);
        packets.push(stored);
        cursor = advanceSequence(cursor);
        continue;
      }

      const missedAt = this.#misses.get(cursor);
      if (missedAt !== undefined) {
        if (missedAt > now) {
          break;
        }
        this.#misses.delete(cursor);
        losses.push(cursor);
        cursor = advanceSequence(cursor);
        continue;
      }

      const laterAt = this.#nextKnownPlayout(cursor);
      if (laterAt !== null && laterAt <= now) {
        losses.push(cursor);
        cursor = advanceSequence(cursor);
        continue;
      }

      break;
    }

    if (packets.length > 0 || losses.length > 0) {
      this.#nextSequence = cursor;
    }
    if (this.#packets.length === 0 && this.#misses.size === 0) {
      this.#anchor = null;
    }
    return {
      packets,
      losses
    };
  }

  #timingState() {
    return {
      jitter: this.#jitter,
      lastTransit: this.#lastTransit,
      minDelay: this.#minDelay,
      maxDelay: this.#maxDelay,
      anchor: this.#anchor
    };
  }

  #result(status, playoutTime) {
    return {
      status,
      playoutTime,
      jitter: this.#jitter,
      delay: this.#delay
    };
  }

  #begin(sequence) {
    if (this.#nextSequence === null) {
      this.#nextSequence = sequence;
    }
  }

  #classify(sequence) {
    if (this.#nextSequence === null) {
      return "new";
    }
    const ahead = forwardDelta(this.#nextSequence, sequence);
    if (ahead >= SEQUENCE_HALF) {
      return STALE;
    }
    if (ahead >= this.#capacity) {
      return TOO_FAR;
    }
    if (this.#misses.has(sequence) || this.#findIndex(sequence) !== -1) {
      return DUPLICATE;
    }
    return "new";
  }

  #findIndex(sequence) {
    for (let index = 0; index < this.#packets.length; index += 1) {
      if (this.#packets[index].sequence === sequence) {
        return index;
      }
    }
    return -1;
  }

  #nextKnownPlayout(from) {
    let bestDelta = this.#capacity;
    let bestTime = null;
    for (let index = 0; index < this.#packets.length; index += 1) {
      const packet = this.#packets[index];
      const delta = forwardDelta(from, packet.sequence);
      if (delta > 0 && delta < bestDelta) {
        bestDelta = delta;
        bestTime = packet.playoutTime;
      }
    }
    for (const [sequence, playoutTime] of this.#misses) {
      const delta = forwardDelta(from, sequence);
      if (delta > 0 && delta < bestDelta) {
        bestDelta = delta;
        bestTime = playoutTime;
      }
    }
    return bestTime;
  }
}
