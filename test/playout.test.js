import assert from "node:assert/strict";
import test from "node:test";
import { DUPLICATE, JitterBuffer, LATE, STALE, STORED, TOO_FAR } from "../src/index.js";
import { sequencesOf } from "./helpers.js";

function packet(sequence, sendTime, arrivalTime, payload) {
  return { sequence, sendTime, arrivalTime, payload };
}

test("the usage stream reorders across the sequence wrap", () => {
  const buffer = new JitterBuffer({ minDelay: 30, maxDelay: 30, capacity: 8 });
  buffer.push({ sequence: 65535, sendTime: 0, arrivalTime: 100, payload: "a" });
  const replay = buffer.push({ sequence: 65535, sendTime: 0, arrivalTime: 101, payload: "a" });
  buffer.push({ sequence: 1, sendTime: 40, arrivalTime: 110, payload: "c" });
  buffer.push({ sequence: 0, sendTime: 20, arrivalTime: 130, payload: "b" });

  assert.equal(replay.status, DUPLICATE);
  assert.equal(buffer.delay, 30);
  const early = buffer.pop(120);
  assert.deepEqual(early, { packets: [], losses: [] });
  assert.equal(buffer.nextSequence, 65535);
  assert.equal(buffer.size, 3);

  const played = buffer.pop(170);
  assert.deepEqual(sequencesOf(played), [65535, 0, 1]);
  assert.deepEqual(
    played.packets.map((item) => item.playoutTime),
    [130, 150, 170]
  );
  assert.deepEqual(
    played.packets.map((item) => item.payload),
    ["a", "b", "c"]
  );
  assert.deepEqual(played.losses, []);
  assert.equal(buffer.nextSequence, 2);
  assert.equal(buffer.size, 0);
});

test("a missing sequence between due packets is a loss", () => {
  const gap = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  gap.push({ sequence: 4, sendTime: 0, arrivalTime: 0, payload: "a" });
  gap.push({ sequence: 6, sendTime: 40, arrivalTime: 40, payload: "c" });
  const released = gap.pop(50);
  assert.deepEqual(released.losses, [5]);
  assert.deepEqual(sequencesOf(released), [4, 6]);
  assert.deepEqual(
    released.packets.map((item) => item.payload),
    ["a", "c"]
  );
  assert.deepEqual(
    released.packets.map((item) => item.playoutTime),
    [10, 50]
  );
  assert.equal(gap.nextSequence, 7);
  const again = gap.pop(50);
  assert.deepEqual(again, { packets: [], losses: [] });
});

test("a wrapped gap is reported in playout order", () => {
  const wrap = new JitterBuffer({ minDelay: 0, maxDelay: 0, capacity: 4 });
  wrap.push({ sequence: 65534, sendTime: 0, arrivalTime: 0, payload: "a" });
  wrap.push({ sequence: 1, sendTime: 60, arrivalTime: 60, payload: "d" });
  const released = wrap.pop(60);
  assert.deepEqual(sequencesOf(released), [65534, 1]);
  assert.deepEqual(released.losses, [65535, 0]);
  assert.equal(wrap.nextSequence, 2);
});

test("a packet is due at its playout time and not before", () => {
  const buffer = new JitterBuffer({ minDelay: 20, maxDelay: 20 });
  buffer.push(packet(0, 0, 100, "a"));
  const waiting = buffer.pop(119);
  assert.deepEqual(waiting, { packets: [], losses: [] });
  assert.equal(buffer.size, 1);
  assert.equal(buffer.nextSequence, 0);
  const due = buffer.pop(120);
  assert.deepEqual(sequencesOf(due), [0]);
  assert.equal(due.packets[0].playoutTime, 120);
  assert.equal(buffer.nextSequence, 1);
  assert.equal(buffer.size, 0);
});

test("a late packet is a loss once its playout time is reached", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  buffer.push(packet(0, 0, 0, "a"));
  const late = buffer.push(packet(1, 10, 11, "b"));
  assert.equal(late.status, LATE);
  assert.equal(late.playoutTime, 10);
  const first = buffer.pop(0);
  assert.deepEqual(sequencesOf(first), [0]);
  assert.deepEqual(first.losses, []);
  assert.equal(buffer.nextSequence, 1);
  const second = buffer.pop(9);
  assert.deepEqual(second, { packets: [], losses: [] });
  assert.equal(buffer.nextSequence, 1);
  const third = buffer.pop(10);
  assert.deepEqual(third.packets, []);
  assert.deepEqual(third.losses, [1]);
  assert.equal(buffer.nextSequence, 2);
  assert.equal(buffer.push(packet(1, 10, 30)).status, STALE);
});

test("an earlier sequence that is not yet lost holds a later packet", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0, capacity: 8 });
  buffer.push(packet(0, 0, 0));
  assert.equal(buffer.push(packet(1, 30, 40)).status, LATE);
  assert.equal(buffer.push(packet(1, 30, 40)).playoutTime, null);
  const later = buffer.push(packet(2, 10, 5, "c"));
  assert.equal(later.status, STORED);
  assert.equal(later.playoutTime, 10);
  const early = buffer.pop(20);
  assert.deepEqual(sequencesOf(early), [0]);
  assert.deepEqual(early.losses, []);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.nextSequence, 1);
  const done = buffer.pop(30);
  assert.deepEqual(done.losses, [1]);
  assert.deepEqual(sequencesOf(done), [2]);
  assert.equal(done.packets[0].payload, "c");
});

test("a hole stays open until a later known playout time is due", () => {
  const buffer = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  buffer.push(packet(0, 0, 0, "a"));
  buffer.push(packet(2, 40, 40, "c"));
  const partial = buffer.pop(10);
  assert.deepEqual(sequencesOf(partial), [0]);
  assert.deepEqual(partial.losses, []);
  assert.equal(buffer.nextSequence, 1);
  assert.equal(buffer.size, 1);
  const filled = buffer.push(packet(1, 20, 25, "b"));
  assert.equal(filled.status, STORED);
  assert.equal(filled.playoutTime, 30);
  const rest = buffer.pop(50);
  assert.deepEqual(sequencesOf(rest), [1, 2]);
  assert.deepEqual(rest.losses, []);
});

test("playout keeps the anchor while a packet is still waiting", () => {
  const buffer = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  buffer.push(packet(0, 0, 100));
  buffer.push(packet(2, 40, 140));
  const first = buffer.pop(110);
  assert.deepEqual(sequencesOf(first), [0]);
  assert.equal(buffer.nextSequence, 1);
  const middle = buffer.push(packet(1, 20, 130));
  assert.equal(middle.status, STORED);
  assert.equal(middle.playoutTime, 130);
  const rest = buffer.pop(150);
  assert.deepEqual(sequencesOf(rest), [1, 2]);
  assert.deepEqual(
    rest.packets.map((item) => item.playoutTime),
    [130, 150]
  );
});

test("an empty buffer anchors the next stored packet again", () => {
  const drained = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  drained.push(packet(0, 0, 0));
  drained.pop(10);
  assert.equal(drained.nextSequence, 1);
  assert.equal(drained.size, 0);
  const restarted = drained.push(packet(1, 1000, 5000));
  assert.equal(restarted.status, STORED);
  assert.equal(restarted.playoutTime, 5010);
  assert.equal(drained.delay, 10);

  const held = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  held.push(packet(0, 0, 0));
  const late = held.push(packet(1, 1000, 5000));
  assert.equal(late.status, LATE);
  assert.equal(late.playoutTime, 1010);
});

test("pop slides the acceptance window forward", () => {
  const buffer = new JitterBuffer({ capacity: 4, minDelay: 0, maxDelay: 0 });
  assert.equal(buffer.push(packet(10, 0, 0)).status, STORED);
  assert.equal(buffer.push(packet(9, 0, 0)).status, STALE);
  assert.equal(buffer.push(packet(13, 3, 3)).status, STORED);
  assert.equal(buffer.push(packet(14, 4, 4)).status, TOO_FAR);
  assert.equal(buffer.jitter, 0);
  const released = buffer.pop(0);
  assert.deepEqual(sequencesOf(released), [10]);
  assert.equal(buffer.nextSequence, 11);
  assert.equal(buffer.push(packet(14, 4, 4)).status, STORED);
  assert.equal(buffer.size, 2);
});

test("capacity 1 accepts only the next sequence", () => {
  const buffer = new JitterBuffer({ capacity: 1, minDelay: 0, maxDelay: 0 });
  assert.equal(buffer.push(packet(5, 0, 0)).status, STORED);
  assert.equal(buffer.push(packet(6, 1, 1)).status, TOO_FAR);
  assert.equal(buffer.push(packet(4, 0, 0)).status, STALE);
  const released = buffer.pop(0);
  assert.deepEqual(sequencesOf(released), [5]);
  assert.equal(buffer.nextSequence, 6);
  assert.equal(buffer.push(packet(6, 1, 1)).status, STORED);
});

test("moving now backward does not return a packet that was already released", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  buffer.push(packet(0, 0, 50));
  buffer.push(packet(1, 10, 60));
  const released = buffer.pop(60);
  assert.deepEqual(sequencesOf(released), [0, 1]);
  const backward = buffer.pop(0);
  assert.deepEqual(backward, { packets: [], losses: [] });
  assert.equal(buffer.nextSequence, 2);
});

test("stored records keep the payload reference and drop extra fields", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  const payload = { n: 1 };
  const input = { sequence: 3, sendTime: 1, arrivalTime: 2, payload, note: "ignore" };
  const snapshot = { sequence: 3, sendTime: 1, arrivalTime: 2, payload, note: "ignore" };
  buffer.push(input);
  assert.deepEqual(input, snapshot);
  const released = buffer.pop(2);
  const played = released.packets[0];
  assert.equal(played.payload, payload);
  assert.deepEqual(Object.keys(played).sort(), [
    "arrivalTime",
    "payload",
    "playoutTime",
    "sendTime",
    "sequence"
  ]);
  assert.equal(Object.isFrozen(played), true);
  assert.throws(() => {
    played.sequence = 9;
  }, TypeError);
  released.packets.push(packet(8, 0, 0));
  assert.deepEqual(buffer.pop(2), { packets: [], losses: [] });
});

test("payload values that are empty are preserved", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0, capacity: 8 });
  const values = [0, false, null, ""];
  for (let index = 0; index < values.length; index += 1) {
    buffer.push(packet(index, index, index, values[index]));
  }
  buffer.push({ sequence: 4, sendTime: 4, arrivalTime: 4 });
  const released = buffer.pop(4);
  assert.deepEqual(
    released.packets.map((item) => item.payload),
    [0, false, null, "", undefined]
  );
  for (const item of released.packets) {
    assert.equal(Object.hasOwn(item, "payload"), true);
  }
});

test("a null-prototype packet and non-enumerable fields are accepted", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  const bare = Object.create(null);
  bare.sequence = 0;
  bare.sendTime = 0;
  bare.arrivalTime = 0;
  bare.payload = "bare";
  assert.equal(buffer.push(bare).status, STORED);

  const hidden = {};
  Object.defineProperty(hidden, "sequence", { value: 1 });
  Object.defineProperty(hidden, "sendTime", { value: 1 });
  Object.defineProperty(hidden, "arrivalTime", { value: 1 });
  Object.defineProperty(hidden, "payload", { value: "hidden" });
  assert.equal(buffer.push(hidden).status, STORED);
  const released = buffer.pop(1);
  assert.deepEqual(
    released.packets.map((item) => item.payload),
    ["bare", "hidden"]
  );
});

test("reset drops stored packets and late sequences without playing them", () => {
  const buffer = new JitterBuffer({ minDelay: 8, maxDelay: 40, capacity: 5 });
  buffer.push(packet(10, 0, 0));
  buffer.push(packet(11, 10, 80));
  buffer.reset();
  assert.equal(buffer.minDelay, 8);
  assert.equal(buffer.maxDelay, 40);
  assert.equal(buffer.capacity, 5);
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 8);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.nextSequence, null);
  assert.deepEqual(buffer.pop(100), { packets: [], losses: [] });
  const restarted = buffer.push(packet(1, 0, 5, "next"));
  assert.equal(restarted.status, STORED);
  assert.equal(buffer.nextSequence, 1);
  assert.equal(buffer.jitter, 0);
  assert.equal(restarted.playoutTime, 13);
});

test("two buffers do not share estimates or packets", () => {
  const left = new JitterBuffer({ minDelay: 40, maxDelay: 100 });
  const right = new JitterBuffer({ minDelay: 10, maxDelay: 10 });
  left.push(packet(0, 0, 0));
  left.push(packet(1, 10, 42));
  assert.equal(left.jitter, 2);
  assert.equal(right.jitter, 0);
  assert.equal(right.delay, 10);
  assert.equal(right.size, 0);
  right.push(packet(0, 0, 0, "r"));
  assert.equal(left.size, 2);
  assert.deepEqual(sequencesOf(right.pop(10)), [0]);
  assert.equal(left.size, 2);
});
