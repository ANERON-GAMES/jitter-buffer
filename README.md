# @aneron/jitter-buffer

Packet jitter buffer that orders by sequence and adapts playout delay from measured arrival jitter.

## Purpose

`@aneron/jitter-buffer` stores packets for playout. Each packet has a 16-bit sequence number, a send timestamp, and a local arrival time. The buffer orders packets by sequence, drops duplicates, and drops a packet that arrives after its playout time. It estimates interarrival jitter with the smoothing formula from RFC 3550 and keeps the playout delay inside caller-supplied minimum and maximum bounds.

`pop(now)` returns the packets whose playout time has arrived and reports missing sequence numbers as losses. The caller passes every timestamp and every `now`. The package does not read a clock, start a timer, draw random numbers, open a socket, or touch the filesystem. It has no runtime dependencies.

## Install

The package is an ES module. It needs Node.js 20 or newer.

```bash
npm install @aneron/jitter-buffer
```

Clone this repository and run the tests:

```bash
git clone https://github.com/ANERON-GAMES/jitter-buffer.git
cd jitter-buffer
npm install
npm test
```

`npm test` runs `node --test`. `npm run lint` runs ESLint. `npm run format:check` runs Prettier.

```js
import { JitterBuffer } from "@aneron/jitter-buffer";
```

Code in this repository imports the same entry point with `./src/index.js`.

## Usage

Time values below are in one unit chosen by the caller. The buffer does not treat them as milliseconds.

```js
import { DUPLICATE, JitterBuffer } from "@aneron/jitter-buffer";

const buffer = new JitterBuffer({ minDelay: 30, maxDelay: 30, capacity: 8 });

buffer.push({ sequence: 65535, sendTime: 0, arrivalTime: 100, payload: "a" });
const replay = buffer.push({
  sequence: 65535,
  sendTime: 0,
  arrivalTime: 101,
  payload: "a"
});
buffer.push({ sequence: 1, sendTime: 40, arrivalTime: 110, payload: "c" });
buffer.push({ sequence: 0, sendTime: 20, arrivalTime: 130, payload: "b" });

const early = buffer.pop(120);
const played = buffer.pop(170);
```

`replay.status` is `"duplicate"`. The second copy is ignored. `early` is `{ packets: [], losses: [] }` because the first playout time is 130. `played.packets` is in sequence order across the wrap. The playout times are `[130, 150, 170]`. The payloads are `"a"`, `"b"`, `"c"`. The sequences are `[65535, 0, 1]`. `played.losses` is empty. `buffer.nextSequence` is `2`.

A missing sequence between two due packets is a loss:

```js
const gap = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
gap.push({ sequence: 4, sendTime: 0, arrivalTime: 0, payload: "a" });
gap.push({ sequence: 6, sendTime: 40, arrivalTime: 40, payload: "c" });
const released = gap.pop(50);
```

`released.losses` is `[5]`. The played sequences are `4` and `6`, at playout times `10` and `50`.

The same rule crosses the wrap. With `minDelay` and `maxDelay` of `0` and a `capacity` of `4`, sequence `65534` at send `0` and arrival `0`, then sequence `1` at send `60` and arrival `60`, are both due at `60`. The losses are `[65535, 0]`.

Jitter uses the absolute transit difference, then smooths it:

```js
const timing = new JitterBuffer({ minDelay: 0, maxDelay: 50 });
timing.push({ sequence: 0, sendTime: 0, arrivalTime: 10 });
const spike = timing.push({ sequence: 1, sendTime: 20, arrivalTime: 62 });
```

The first transit is `10`. The second is `42`. The absolute difference is `32`, so the jitter is `2` and the delay is `2`. `spike.status` is `"late"` and `spike.playoutTime` is `32`.

When the smoothed jitter passes the maximum, the delay stays on that bound:

```js
const capped = new JitterBuffer({ minDelay: 5, maxDelay: 5 });
capped.push({ sequence: 0, sendTime: 0, arrivalTime: 0 });
capped.push({ sequence: 1, sendTime: 10, arrivalTime: 170 });
```

`capped.jitter` is `10`. The delay is `5`.

## API

### Constants

| Export              | Value         |
| ------------------- | ------------- |
| `SEQUENCE_MODULUS`  | `65536`       |
| `SEQUENCE_MAX`      | `65535`       |
| `SEQUENCE_HALF`     | `32768`       |
| `JITTER_DIVISOR`    | `16`          |
| `MAX_CAPACITY`      | `32767`       |
| `DEFAULT_MIN_DELAY` | `0`           |
| `DEFAULT_MAX_DELAY` | `Infinity`    |
| `DEFAULT_CAPACITY`  | `64`          |
| `STORED`            | `"stored"`    |
| `DUPLICATE`         | `"duplicate"` |
| `LATE`              | `"late"`      |
| `STALE`             | `"stale"`     |
| `TOO_FAR`           | `"too-far"`   |

`STATUSES` is a frozen array of the five status strings, in the order `stored`, `duplicate`, `late`, `stale`, `too-far`.

`DEFAULT_MAX_DELAY` is `Number.POSITIVE_INFINITY`.

### `new JitterBuffer(options)`

Create a buffer. `options` may be omitted. It must be an object and must not be an array. Any other value throws `TypeError` with the message `options must be an object`.

Own fields are read. An omitted field, or a field whose value is `undefined`, uses the default. Unknown fields are ignored. A frozen object and an object with a null prototype are accepted.

| Field      | Default    | Accepted values                                                                            |
| ---------- | ---------- | ------------------------------------------------------------------------------------------ |
| `minDelay` | `0`        | A finite number greater than or equal to `0`. `-0` is stored as `0`.                       |
| `maxDelay` | `Infinity` | `Infinity`, or a finite number greater than or equal to `minDelay`. `-0` is stored as `0`. |
| `capacity` | `64`       | An integer from `1` through `32767`.                                                       |

A bad `minDelay`, `maxDelay`, or `capacity` throws `RangeError`. The messages are:

- `minDelay must be a finite number greater than or equal to 0`
- `maxDelay must be Infinity or a finite number greater than or equal to minDelay`
- `capacity must be an integer from 1 to 32767`

`minDelay` and `maxDelay` may be equal. The delay is then fixed at that number. Before any packet is accepted, `jitter` is `0` and `delay` is `minDelay`.

### `buffer.push(packet)`

Accept one packet.

`packet` must be an object and must not be an array. Otherwise the method throws `TypeError` with the message `packet must be an object`.

| Field         | Required | Meaning                                                                                                      |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `sequence`    | yes      | An integer from `0` through `65535`. `-0` is stored as `0`.                                                  |
| `sendTime`    | yes      | A finite send timestamp, in the same unit as `arrivalTime`.                                                  |
| `arrivalTime` | yes      | A finite local arrival time.                                                                                 |
| `payload`     | no       | Stored by reference. A missing field is stored as `undefined`. `0`, `false`, `null`, and `""` stay as given. |

Checks run in this order. The first failure wins. A throw leaves the buffer unchanged.

1. `packet` is an object.
2. `sequence` is an integer from `0` through `65535`. Otherwise `RangeError`: `sequence must be an integer from 0 to 65535`.
3. `sendTime` is a finite number. Otherwise `RangeError`: `sendTime must be a finite number`.
4. `arrivalTime` is a finite number. Otherwise `RangeError`: `arrivalTime must be a finite number`.
5. The sequence is classified against the open window.
6. For a new sequence, the jitter update and the playout time are computed. If the transit difference is not finite, `RangeError`: `sendTime and arrivalTime difference must be finite`. If the playout time is not finite, `RangeError`: `playout time must be finite`. Either error leaves the buffer unchanged.

The return value is a plain object:

| Field         | Meaning                                                                            |
| ------------- | ---------------------------------------------------------------------------------- |
| `status`      | One of the `STATUSES` strings.                                                     |
| `playoutTime` | The scheduled playout time for `stored` and `late`. `null` for every other status. |
| `jitter`      | The jitter estimate after the call.                                                |
| `delay`       | The playout delay after the call.                                                  |

`duplicate`, `stale`, and `too-far` do not change `jitter`, `delay`, the anchor, the stored packets, or the recorded losses. `stored` and `late` both update the estimate. `late` does not store the payload. The input object is not mutated. Extra fields are not copied.

Status values:

| Status        | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `"stored"`    | The packet is new, inside the window, and `arrivalTime` is less than or equal to its playout time.             |
| `"duplicate"` | That sequence is already stored, or already recorded as a late loss that `pop` has not reported yet.           |
| `"late"`      | The packet is new and inside the window, and `arrivalTime` is strictly greater than its playout time.          |
| `"stale"`     | The forward distance from `nextSequence` is greater than or equal to `32768`. The packet is behind the cursor. |
| `"too-far"`   | The forward distance is greater than or equal to `capacity` and less than `32768`.                             |

Before the first `stored` or `late` packet, every in-range sequence is new. That first packet is stored: with a non-negative delay its playout time is `arrivalTime + delay`, which is not earlier than `arrivalTime`. `nextSequence` becomes that sequence.

After that, the open window is `capacity` sequence numbers starting at `nextSequence`, inclusive, in 16-bit order. Forward distance is `(sequence - nextSequence) mod 65536`.

### `buffer.pop(now)`

Release packets and losses that are due at `now`.

`now` must be a finite number. Otherwise the method throws `RangeError` with the message `now must be a finite number` and changes nothing. `-0` is the same instant as `0`.

The return value is `{ packets, losses }`.

`packets` is an array of frozen records, oldest sequence first:

| Field         | Meaning                                            |
| ------------- | -------------------------------------------------- |
| `sequence`    | The 16-bit sequence number.                        |
| `sendTime`    | The send timestamp passed to `push`.               |
| `arrivalTime` | The arrival time passed to `push`.                 |
| `playoutTime` | The playout time fixed when the packet was stored. |
| `payload`     | The payload reference, or `undefined`.             |

`losses` is an array of sequence numbers that were skipped, in the same 16-bit playout order. A loss has no payload and no playout time on the result. The two arrays are separate. Merge them by 16-bit order from the previous `nextSequence`, not by numeric sort: `65535` is before `0`.

The walk starts at `nextSequence`. For each sequence, in order:

1. A stored packet with `playoutTime <= now` is released and removed.
2. A stored packet with `playoutTime > now` stops the walk. Nothing after it is released.
3. A late sequence whose recorded playout time is `<= now` is appended to `losses`.
4. A late sequence whose recorded playout time is `> now` stops the walk.
5. A sequence that was never accepted is a loss when the nearest later stored packet or recorded late sequence has a playout time `<= now`. Otherwise the walk stops, and that hole stays open.

Each call advances through at most `capacity` sequences. `nextSequence` moves forward only when at least one packet or loss is released. It does not move backward. A later `pop` with a smaller `now` does not return packets that were already released.

`pop` does not change `jitter` or `delay`.

A second `pop` at the same `now`, with no `push` in between, returns empty arrays.

When no stored packets and no unreported late sequences remain, the anchor is cleared. The next stored packet starts a new anchor. `nextSequence` stays where it is, so the stream does not jump backward.

Before the first accepted packet, `pop` returns empty arrays and `nextSequence` stays `null`.

### Getters

| Getter         | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `minDelay`     | The configured minimum.                                                                              |
| `maxDelay`     | The configured maximum.                                                                              |
| `capacity`     | The configured window length.                                                                        |
| `jitter`       | The RFC 3550 jitter estimate. This is not clamped.                                                   |
| `delay`        | The playout delay: `jitter` clamped to `[minDelay, maxDelay]`.                                       |
| `size`         | The number of stored packets. Late sequences are not included. `size` is at most `capacity`.         |
| `nextSequence` | The next sequence `pop` will consider, or `null` before the first accepted packet and after `reset`. |

### `buffer.reset()`

Drop stored packets and unreported late sequences. Set `jitter` to `0`, `delay` to `minDelay`, and `nextSequence` to `null`. Clear the anchor. `minDelay`, `maxDelay`, and `capacity` stay as constructed. Nothing is returned and nothing is played.

### Errors

`TypeError` means `options` or `packet` was not an object.

`RangeError` means a number was missing, not finite, or outside its range, or that a playout time or a transit difference overflowed. The `message` strings are stable and are listed above. A `RangeError` from `push` does not change the buffer. A `RangeError` from `pop` does not release packets.

## Design

The sequence number is a 16-bit serial number. It wraps from `65535` to `0`. Comparison uses the forward distance `(to - from) mod 65536`. A distance of `0` is the cursor. A distance from `1` through `32767` is ahead. A distance of `32768` or more is behind, so it is `stale`, including the exact halfway value `32768`. The open window is only the first `capacity` numbers from the cursor, so a distance from `capacity` through `32767` is `too-far` rather than stored. `capacity` stops at `32767` so the window always fits strictly below that halfway point.

`pop` is what slides the window. Until it releases a packet or a loss, `nextSequence` stays on the first accepted sequence, and a packet `capacity` or more ahead is `too-far`. After that sequence is released, the following numbers enter the window. A sequence behind the cursor is `stale` even if it arrives later. `reset` is how a caller abandons the cursor and starts at a new sequence.

Jitter follows RFC 3550 section 6.4.1, in real numbers rather than the integer sample in the RFC appendix. For each accepted arrival after the first, in `push` order:

```
transit = arrivalTime - sendTime
D = transit - previousTransit
jitter = jitter + (abs(D) - jitter) / 16
```

The first accepted packet records `transit` and leaves `jitter` at `0`. `stored` and `late` are accepted arrivals. `duplicate`, `stale`, and `too-far` are not, so a repeat of the same send timestamp cannot inflate the estimate. Push order is the arrival order. Sequence order is not. A packet that is accepted out of sequence still updates jitter from the previous accepted push.

`delay` is `jitter` clamped to the configured bounds. When `jitter` is below `minDelay`, the delay stays on `minDelay`. When `jitter` is above `maxDelay`, the delay stays on `maxDelay` and `jitter` itself remains the unclamped estimate. Equal bounds fix the delay. The bounds are fixed at construction, so `jitter` is the way to read the estimate when the delay is sitting on a bound.

The playout time is fixed when the packet is classified. Later changes to `delay` do not move it.

While an anchor is set:

```
playoutTime = anchorArrival + delay + (sendTime - anchorSend)
```

The anchor is the stored packet that arrived while nothing was waiting: the first stored packet, and again the next stored packet after `pop` has cleared both the stored packets and the unreported late sequences. A packet stored while the anchor is empty uses `playoutTime = arrivalTime + delay` and then becomes the anchor. A constant offset between the send clock and the arrival clock cancels in `D` and in the difference of send timestamps, so the clocks do not need to be synchronized. Send timestamps are not required to increase. A decrease pulls that packet's playout time earlier, which often makes it `late`. The walk still releases in sequence order, so an earlier sequence that is not yet due holds every later packet.

A packet is `late` only when `arrivalTime` is strictly greater than that playout time. Equality is `stored` and is due at `pop` when `now` is equal to the playout time. `pop` uses `>` and `<=` with no epsilon.

Losses have two sources. A `late` packet stores its sequence and playout time without the payload. `pop` reports that sequence once `now` reaches the playout time, even when no later packet exists. A sequence that never arrived is a loss only when a later accepted sequence is already due. Until then the hole stays open, so a reordered packet can still be stored. The nearest later accepted playout time is the one that decides the hole. An earlier sequence that is not yet lost or due holds the walk, including a later packet whose own playout time has already passed.

After a late sequence is reported, a retransmission of that sequence is `stale`, not `duplicate`. `duplicate` is only for a sequence that is still stored or still waiting to be reported.

Each `JitterBuffer` keeps its own state. The module has no mutable shared state. Payload values are not cloned and are not frozen. The stored record is frozen, so its fields cannot be reassigned. Mutating an object passed as `payload` changes the value later returned by `pop`.

The same inputs produce the same results. `push` and `pop` do not read `Date`, a monotonic clock, a timer, or a random source.

## License

MIT. Copyright (c) 2026 Vadim Gubin. See [LICENSE](LICENSE).
