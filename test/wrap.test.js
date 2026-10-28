import assert from "node:assert/strict";
import test from "node:test";
import { DUPLICATE, JitterBuffer, LATE, STALE, STORED, TOO_FAR } from "../src/index.js";
import { clampDelay, createJitterTracker, mulberry32, observeTransit } from "./helpers.js";

const STATUSES = new Set([STORED, DUPLICATE, LATE, STALE, TOO_FAR]);

function packet(sequence, sendTime, arrivalTime, payload) {
  return { sequence, sendTime, arrivalTime, payload };
}

function isBefore(left, right) {
  return left !== right && ((right - left) & 65535) < 32768;
}

test("negative zero is sequence 0", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  const accepted = buffer.push({ sequence: -0, sendTime: -0, arrivalTime: -0, payload: "z" });
  assert.equal(accepted.status, STORED);
  assert.equal(buffer.nextSequence, 0);
  assert.equal(Object.is(buffer.nextSequence, 0), true);
  assert.equal(buffer.push(packet(0, 0, 1)).status, DUPLICATE);
  const released = buffer.pop(-0);
  assert.equal(released.packets.length, 1);
  assert.equal(released.packets[0].sequence, 0);
  assert.equal(Object.is(released.packets[0].sequence, -0), false);
  assert.equal(released.packets[0].playoutTime, 0);
});

test("half the sequence space is stale and the far edge of a full window is too far", () => {
  const buffer = new JitterBuffer({ capacity: 32767, minDelay: 0, maxDelay: 0 });
  assert.equal(buffer.push(packet(0, 0, 0)).status, STORED);
  assert.equal(buffer.push(packet(32768, 1, 1)).status, STALE);
  assert.equal(buffer.push(packet(32767, 1, 1)).status, TOO_FAR);
  assert.equal(buffer.push(packet(32766, 1, 1)).status, STORED);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.nextSequence, 0);
  assert.equal(buffer.jitter, 0);
});

test("the stale half stays stale when the cursor sits on the wrap", () => {
  const buffer = new JitterBuffer({ capacity: 8, minDelay: 0, maxDelay: 0 });
  buffer.push(packet(0, 0, 0));
  buffer.pop(0);
  assert.equal(buffer.nextSequence, 1);
  assert.equal(buffer.push(packet(0, 0, 1)).status, STALE);
  assert.equal(buffer.push(packet(32769, 1, 1)).status, STALE);
  assert.equal(buffer.push(packet(8, 8, 8)).status, STORED);
  assert.equal(buffer.push(packet(9, 9, 9)).status, TOO_FAR);
});

test("randomized arrivals keep order, delay, and the jitter recurrence", () => {
  for (const seed of [1, 7, 99, 65535, 0x4a17]) {
    const random = mulberry32(seed);
    const minDelay = 15;
    const maxDelay = 40;
    const capacity = 8;
    const buffer = new JitterBuffer({ minDelay, maxDelay, capacity });
    const tracker = createJitterTracker();
    const history = [];
    const pending = [];
    let sequence = 65500;

    for (let step = 0; step < 180; step += 1) {
      const roll = random() % 6;
      let item;
      if (roll === 0 && pending.length > 0) {
        item = pending.shift();
      } else if (roll === 1 && history.length > 0) {
        const prior = history[random() % history.length];
        item = {
          sequence: prior.sequence,
          sendTime: prior.sendTime,
          arrivalTime: prior.arrivalTime + (random() % 5),
          payload: prior.payload
        };
      } else {
        const skip = random() % 4 === 0 ? 2 : 1;
        sequence = (sequence + skip) & 65535;
        const sendTime = step * 20;
        const arrivalTime = sendTime + 30 + (random() % 40);
        item = { sequence, sendTime, arrivalTime, payload: step };
        if (pending.length < 2 && random() % 3 === 0) {
          pending.push(item);
          item = null;
        }
      }

      if (item !== null) {
        const beforeJitter = buffer.jitter;
        const beforeDelay = buffer.delay;
        const beforeSize = buffer.size;
        const result = buffer.push(item);
        assert.equal(STATUSES.has(result.status), true, result.status);
        assert.equal(result.jitter, buffer.jitter);
        assert.equal(result.delay, buffer.delay);
        if (result.status === STORED || result.status === LATE) {
          observeTransit(tracker, item.sendTime, item.arrivalTime);
          assert.equal(buffer.jitter, tracker.jitter);
          if (result.status === LATE) {
            assert.equal(item.arrivalTime > result.playoutTime, true);
            assert.equal(buffer.size, beforeSize);
          } else {
            assert.equal(item.arrivalTime <= result.playoutTime, true);
            assert.equal(buffer.size, beforeSize + 1);
          }
          history.push(item);
        } else {
          assert.equal(result.playoutTime, null);
          assert.equal(buffer.jitter, beforeJitter);
          assert.equal(buffer.delay, beforeDelay);
          assert.equal(buffer.size, beforeSize);
        }
        assert.equal(buffer.delay, clampDelay(buffer.jitter, minDelay, maxDelay));
        assert.equal(buffer.size <= capacity, true);
        assert.equal(buffer.size >= 0, true);
      }

      if (step % 5 === 4) {
        const now = step * 20 + 80;
        const before = buffer.nextSequence;
        const beforeJitter = buffer.jitter;
        const released = buffer.pop(now);
        assert.equal(buffer.jitter, beforeJitter);
        assert.equal(buffer.delay, clampDelay(buffer.jitter, minDelay, maxDelay));
        const ordered = mergeRelease(released);
        if (before === null) {
          assert.deepEqual(ordered, []);
          assert.equal(buffer.nextSequence, null);
        } else if (ordered.length === 0) {
          assert.equal(buffer.nextSequence, before);
        } else {
          assert.equal(ordered.length <= capacity, true);
          assert.equal(ordered[0], before);
          for (let index = 1; index < ordered.length; index += 1) {
            assert.equal(ordered[index], (ordered[index - 1] + 1) & 65535);
          }
          assert.equal(buffer.nextSequence, (ordered[ordered.length - 1] + 1) & 65535);
        }
        for (const played of released.packets) {
          assert.equal(played.playoutTime <= now, true);
          assert.equal(played.arrivalTime <= played.playoutTime, true);
          assert.equal(Object.isFrozen(played), true);
        }
        const again = buffer.pop(now);
        assert.deepEqual(again.packets, []);
        assert.deepEqual(again.losses, []);
      }
    }

    buffer.reset();
    assert.equal(buffer.jitter, 0);
    assert.equal(buffer.delay, minDelay);
    assert.equal(buffer.nextSequence, null);
    assert.equal(buffer.push(packet(3, 0, 5)).status, STORED);
  }
});

function mergeRelease(released) {
  const seen = new Set();
  for (const sequence of released.losses) {
    assert.equal(seen.has(sequence), false);
    seen.add(sequence);
  }
  for (const played of released.packets) {
    assert.equal(seen.has(played.sequence), false);
    seen.add(played.sequence);
  }

  const ordered = [];
  let lossIndex = 0;
  let packetIndex = 0;
  while (lossIndex < released.losses.length || packetIndex < released.packets.length) {
    const lossSequence = lossIndex < released.losses.length ? released.losses[lossIndex] : null;
    const packetSequence =
      packetIndex < released.packets.length ? released.packets[packetIndex].sequence : null;
    if (
      lossSequence !== null &&
      (packetSequence === null || isBefore(lossSequence, packetSequence))
    ) {
      ordered.push(lossSequence);
      lossIndex += 1;
    } else {
      ordered.push(packetSequence);
      packetIndex += 1;
    }
  }
  return ordered;
}
