import assert from "node:assert/strict";
import test from "node:test";
import { DUPLICATE, JitterBuffer, LATE, STALE, STORED, TOO_FAR } from "../src/index.js";
import { clampDelay, createJitterTracker, observeTransit } from "./helpers.js";

function packet(sequence, sendTime, arrivalTime, payload) {
  return { sequence, sendTime, arrivalTime, payload };
}

test("the first packet keeps jitter at zero and plays at arrival plus the minimum delay", () => {
  const buffer = new JitterBuffer({ minDelay: 20, maxDelay: 80 });
  const accepted = buffer.push(packet(4, 700, 1000, "a"));
  assert.equal(accepted.status, STORED);
  assert.equal(accepted.playoutTime, 1020);
  assert.equal(accepted.jitter, 0);
  assert.equal(accepted.delay, 20);
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 20);
  assert.equal(buffer.nextSequence, 4);
  assert.equal(buffer.size, 1);
});

test("a transit gap of 32 produces a jitter of 2", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 50 });
  buffer.push(packet(0, 0, 10));
  const spike = buffer.push(packet(1, 20, 62));
  assert.equal(spike.status, LATE);
  assert.equal(spike.jitter, 2);
  assert.equal(spike.delay, 2);
  assert.equal(spike.playoutTime, 32);
  assert.equal(buffer.jitter, 2);
  assert.equal(buffer.delay, 2);
  assert.equal(buffer.size, 1);
});

test("an early transit uses the same absolute difference", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 50 });
  buffer.push(packet(0, 0, 42));
  const early = buffer.push(packet(1, 20, 30));
  assert.equal(early.jitter, 2);
  assert.equal(early.delay, 2);
});

test("a later sample moves the jitter one sixteenth of the way to the new absolute difference", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 50 });
  buffer.push(packet(0, 0, 10));
  buffer.push(packet(1, 20, 62));
  const follow = buffer.push(packet(2, 40, 82));
  assert.equal(follow.jitter, 1.875);
  assert.equal(follow.delay, 1.875);
  assert.equal(follow.status, LATE);
  assert.equal(follow.playoutTime, 51.875);
});

test("jitter follows push order rather than sequence order", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 1000, capacity: 8 });
  const tracker = createJitterTracker();
  const packets = [packet(0, 0, 0), packet(2, 20, 52), packet(1, 10, 10)];
  for (const item of packets) {
    const accepted = buffer.push(item);
    assert.equal(accepted.status === STORED || accepted.status === LATE, true);
    observeTransit(tracker, item.sendTime, item.arrivalTime);
    assert.equal(buffer.jitter, tracker.jitter);
    assert.equal(buffer.delay, clampDelay(tracker.jitter, 0, 1000));
  }
  assert.equal(buffer.jitter, 3.875);
  assert.equal(buffer.push(packet(2, 20, 52)).status, DUPLICATE);
  assert.equal(buffer.jitter, 3.875);
});

test("delay stays on the minimum until jitter exceeds it", () => {
  const buffer = new JitterBuffer({ minDelay: 40, maxDelay: 100 });
  buffer.push(packet(0, 0, 0));
  const accepted = buffer.push(packet(1, 20, 20));
  assert.equal(accepted.status, STORED);
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 40);
  assert.equal(accepted.playoutTime, 60);
});

test("delay stops at the maximum while jitter keeps growing", () => {
  const buffer = new JitterBuffer({ minDelay: 5, maxDelay: 5 });
  buffer.push(packet(0, 0, 0));
  const hit = buffer.push(packet(1, 10, 170));
  assert.equal(hit.status, LATE);
  assert.equal(hit.jitter, 10);
  assert.equal(hit.delay, 5);
  assert.equal(buffer.jitter, 10);
  assert.equal(buffer.delay, 5);
  assert.equal(hit.playoutTime, 15);
});

test("equal bounds ignore jitter when choosing the delay", () => {
  const buffer = new JitterBuffer({ minDelay: 30, maxDelay: 30 });
  buffer.push(packet(0, 0, 0));
  const accepted = buffer.push(packet(1, 20, 52));
  assert.equal(buffer.jitter, 2);
  assert.equal(buffer.delay, 30);
  assert.equal(accepted.delay, 30);
  assert.equal(accepted.playoutTime, 50);
});

test("a duplicate, a stale packet, and a packet past the window do not change the estimate", () => {
  const buffer = new JitterBuffer({ minDelay: 40, maxDelay: 100, capacity: 4 });
  buffer.push(packet(10, 0, 0));
  buffer.push(packet(11, 16, 48));
  assert.equal(buffer.jitter, 2);
  const delay = buffer.delay;
  const duplicate = buffer.push(packet(11, 16, 400));
  const stale = buffer.push(packet(9, 0, 500));
  const far = buffer.push(packet(14, 80, 800));
  assert.equal(duplicate.status, DUPLICATE);
  assert.equal(stale.status, STALE);
  assert.equal(far.status, TOO_FAR);
  assert.equal(duplicate.playoutTime, null);
  assert.equal(stale.playoutTime, null);
  assert.equal(far.playoutTime, null);
  assert.equal(buffer.jitter, 2);
  assert.equal(buffer.delay, delay);
  assert.equal(buffer.size, 2);
  assert.equal(buffer.nextSequence, 10);
});

test("a late packet updates the estimate and does not occupy a slot", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  buffer.push(packet(0, 0, 0));
  const late = buffer.push(packet(1, 10, 11));
  assert.equal(late.status, LATE);
  assert.equal(late.playoutTime, 10);
  assert.equal(buffer.jitter, 1 / 16);
  assert.equal(buffer.delay, 0);
  assert.equal(buffer.size, 1);
  const again = buffer.push(packet(1, 10, 12));
  assert.equal(again.status, DUPLICATE);
  assert.equal(buffer.jitter, 1 / 16);
  assert.equal(buffer.size, 1);
});

test("arrival at the playout time is stored and one unit later is late", () => {
  const onTime = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  onTime.push(packet(0, 0, 0));
  assert.equal(onTime.push(packet(1, 10, 10)).status, STORED);

  const missed = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  missed.push(packet(0, 0, 0));
  assert.equal(missed.push(packet(1, 10, 11)).status, LATE);
});
