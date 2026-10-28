import assert from "node:assert/strict";
import test from "node:test";
import { JitterBuffer } from "../src/index.js";

const CAPACITY_MESSAGE = "capacity must be an integer from 1 to 32767";
const MIN_DELAY_MESSAGE = "minDelay must be a finite number greater than or equal to 0";
const MAX_DELAY_MESSAGE =
  "maxDelay must be Infinity or a finite number greater than or equal to minDelay";
const SEQUENCE_MESSAGE = "sequence must be an integer from 0 to 65535";
const SEND_MESSAGE = "sendTime must be a finite number";
const ARRIVAL_MESSAGE = "arrivalTime must be a finite number";
const NOW_MESSAGE = "now must be a finite number";

function packet(sequence, sendTime, arrivalTime) {
  return { sequence, sendTime, arrivalTime };
}

test("defaults are an open delay and a 64-packet window", () => {
  const buffer = new JitterBuffer();
  assert.equal(buffer.minDelay, 0);
  assert.equal(buffer.maxDelay, Number.POSITIVE_INFINITY);
  assert.equal(buffer.capacity, 64);
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 0);
  assert.equal(buffer.size, 0);
  assert.equal(buffer.nextSequence, null);
});

test("omitted option fields and undefined values use the defaults", () => {
  const buffer = new JitterBuffer({
    minDelay: undefined,
    maxDelay: undefined,
    capacity: undefined,
    extra: true
  });
  assert.equal(buffer.minDelay, 0);
  assert.equal(buffer.maxDelay, Number.POSITIVE_INFINITY);
  assert.equal(buffer.capacity, 64);
});

test("a frozen options object and a null-prototype options object are accepted", () => {
  const frozen = new JitterBuffer(Object.freeze({ minDelay: 5, maxDelay: 5, capacity: 2 }));
  assert.equal(frozen.delay, 5);
  const bare = Object.create(null);
  bare.minDelay = 3;
  bare.maxDelay = 9;
  bare.capacity = 4;
  const buffer = new JitterBuffer(bare);
  assert.equal(buffer.minDelay, 3);
  assert.equal(buffer.maxDelay, 9);
  assert.equal(buffer.capacity, 4);
});

test("equal bounds fix the delay and Infinity is an open maximum", () => {
  const fixed = new JitterBuffer({ minDelay: 12, maxDelay: 12 });
  assert.equal(fixed.minDelay, 12);
  assert.equal(fixed.maxDelay, 12);
  assert.equal(fixed.delay, 12);
  const open = new JitterBuffer({ minDelay: 4, maxDelay: Number.POSITIVE_INFINITY });
  assert.equal(open.maxDelay, Number.POSITIVE_INFINITY);
  assert.equal(open.delay, 4);
});

test("negative zero delays are stored as zero", () => {
  const buffer = new JitterBuffer({ minDelay: -0, maxDelay: -0 });
  assert.equal(Object.is(buffer.minDelay, 0), true);
  assert.equal(Object.is(buffer.maxDelay, 0), true);
  assert.equal(Object.is(buffer.delay, 0), true);
});

test("the constructor rejects an options value that is not an object", () => {
  for (const options of [null, [], "options", 1, true]) {
    assert.throws(() => new JitterBuffer(options), TypeError);
  }
});

test("the constructor rejects a bad minimum delay", () => {
  for (const minDelay of [-1, Number.NaN, Number.POSITIVE_INFINITY, "0", null, 1n]) {
    assert.throws(() => new JitterBuffer({ minDelay }), {
      name: "RangeError",
      message: MIN_DELAY_MESSAGE
    });
  }
});

test("the constructor rejects a bad maximum delay", () => {
  for (const maxDelay of [4, -1, Number.NaN, Number.NEGATIVE_INFINITY, "20", null]) {
    assert.throws(() => new JitterBuffer({ minDelay: 5, maxDelay }), {
      name: "RangeError",
      message: MAX_DELAY_MESSAGE
    });
  }
});

test("the constructor rejects a capacity outside 1 through 32767", () => {
  for (const capacity of [0, -1, 1.5, 32768, Number.NaN, "8", null, 8n]) {
    assert.throws(() => new JitterBuffer({ capacity }), {
      name: "RangeError",
      message: CAPACITY_MESSAGE
    });
  }
  assert.equal(new JitterBuffer({ capacity: 1 }).capacity, 1);
  assert.equal(new JitterBuffer({ capacity: 32767 }).capacity, 32767);
});

test("push rejects a packet that is not an object", () => {
  const buffer = new JitterBuffer();
  for (const packetValue of [null, [], "packet", 1]) {
    assert.throws(() => buffer.push(packetValue), TypeError);
  }
  assert.equal(buffer.size, 0);
  assert.equal(buffer.nextSequence, null);
});

test("push rejects a sequence outside the 16-bit range before it reads timestamps", () => {
  const buffer = new JitterBuffer();
  const badSequences = [
    -1,
    65536,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "0",
    null,
    undefined,
    true,
    false,
    1n
  ];
  for (const sequence of badSequences) {
    assert.throws(() => buffer.push({ sequence, sendTime: Number.NaN, arrivalTime: 0 }), {
      name: "RangeError",
      message: SEQUENCE_MESSAGE
    });
  }
  assert.throws(() => buffer.push({ sendTime: 0, arrivalTime: 0 }), {
    name: "RangeError",
    message: SEQUENCE_MESSAGE
  });
  assert.equal(buffer.size, 0);
});

test("push rejects a timestamp that is not a finite number", () => {
  const buffer = new JitterBuffer();
  for (const sendTime of [Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined]) {
    assert.throws(() => buffer.push({ sequence: 0, sendTime, arrivalTime: 0 }), {
      name: "RangeError",
      message: SEND_MESSAGE
    });
  }
  for (const arrivalTime of [Number.NaN, Number.NEGATIVE_INFINITY, "0", null]) {
    assert.throws(() => buffer.push({ sequence: 0, sendTime: 0, arrivalTime }), {
      name: "RangeError",
      message: ARRIVAL_MESSAGE
    });
  }
  assert.throws(() => buffer.push({ sequence: 0, arrivalTime: 0 }), {
    name: "RangeError",
    message: SEND_MESSAGE
  });
  assert.throws(() => buffer.push({ sequence: 0, sendTime: 0 }), {
    name: "RangeError",
    message: ARRIVAL_MESSAGE
  });
  assert.equal(buffer.size, 0);
});

test("a non-finite transit difference does not change the buffer", () => {
  const buffer = new JitterBuffer({ minDelay: 5, maxDelay: 5 });
  buffer.push(packet(0, 0, 0));
  assert.throws(() => buffer.push(packet(1, -Number.MAX_VALUE, Number.MAX_VALUE)), RangeError);
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 5);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.nextSequence, 0);
  const follow = buffer.push(packet(1, 10, 10));
  assert.equal(follow.status, "stored");
  assert.equal(buffer.jitter, 0);
});

test("a non-finite playout time does not change the buffer", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 10 });
  buffer.push(packet(0, -Number.MAX_VALUE, 0));
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.size, 1);
  assert.throws(
    () => buffer.push(packet(1, Number.MAX_VALUE, Number.MAX_VALUE)),
    (error) => {
      assert.equal(error instanceof RangeError, true);
      assert.equal(error.message, "playout time must be finite");
      return true;
    }
  );
  assert.equal(buffer.jitter, 0);
  assert.equal(buffer.delay, 0);
  assert.equal(buffer.size, 1);
  assert.equal(buffer.nextSequence, 0);
  const released = buffer.pop(0);
  assert.equal(released.packets.length, 1);
  assert.equal(released.losses.length, 0);
});

test("pop rejects a time that is not finite and releases nothing", () => {
  const buffer = new JitterBuffer({ minDelay: 0, maxDelay: 0 });
  buffer.push(packet(0, 0, 0));
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "0", null, undefined]) {
    assert.throws(() => buffer.pop(now), {
      name: "RangeError",
      message: NOW_MESSAGE
    });
  }
  assert.equal(buffer.size, 1);
  assert.equal(buffer.nextSequence, 0);
});

test("pop on an empty buffer rejects a bad time", () => {
  const buffer = new JitterBuffer();
  assert.throws(() => buffer.pop(Number.NaN), RangeError);
  assert.equal(buffer.nextSequence, null);
});
