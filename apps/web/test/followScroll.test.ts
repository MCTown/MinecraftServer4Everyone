import assert from "node:assert/strict";
import test from "node:test";
import { createFollowScroll } from "../utils/followScroll";

function setup() {
  let top = 600;
  const element = {
    scrollHeight: 1000,
    clientHeight: 400,
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  };
  let list: typeof element | null = element;
  const frames: Array<() => void> = [];
  const follow = createFollowScroll(() => list, (callback) => frames.push(callback));
  // Initialize against the currently mounted list.
  follow.onScroll();
  function flush() {
    while (frames.length) frames.shift()!();
  }
  return { element, follow, frames, flush, replace: (next: typeof list) => { list = next; } };
}

test("new streaming output follows the bottom without mistaking content growth for user scrolling", () => {
  const { element, follow, flush } = setup();
  element.scrollHeight += 300;
  follow.scrollToBottom();
  flush();
  assert.equal(element.scrollTop, 900);
  assert.equal(follow.isFollowing(), true);
});

test("a small upward scroll pauses following even within the old 72px threshold", () => {
  const { element, follow, flush } = setup();
  element.scrollTop -= 10;
  follow.onScroll();
  assert.equal(follow.isFollowing(), false);
  element.scrollHeight += 100;
  follow.scrollToBottom();
  flush();
  assert.equal(element.scrollTop, 590);
});

test("upward input cancels a queued follow before the browser scroll event arrives", () => {
  const { element, follow, flush } = setup();
  element.scrollHeight += 100;
  follow.scrollToBottom();
  follow.pause();
  flush();
  assert.equal(element.scrollTop, 600);
});

test("user scrolling between layout frames cancels the second scroll", () => {
  const { element, follow, frames, flush } = setup();
  element.scrollHeight += 100;
  follow.scrollToBottom();
  frames.shift()!();
  assert.equal(element.scrollTop, 700);
  element.scrollTop = 680;
  follow.onScroll();
  flush();
  assert.equal(element.scrollTop, 680);
});

test("downward scrolling does not resume following until the user reaches the bottom", () => {
  const { element, follow, flush } = setup();
  element.scrollTop = 200;
  follow.onScroll();
  element.scrollTop = 500;
  follow.onScroll();
  assert.equal(follow.isFollowing(), false);
  element.scrollTop = 600;
  follow.onScroll();
  assert.equal(follow.isFollowing(), true);
  element.scrollHeight += 100;
  follow.scrollToBottom();
  flush();
  assert.equal(element.scrollTop, 700);
});

test("a delayed programmatic scroll event cannot undo an upward-input pause", () => {
  const { follow } = setup();
  follow.pause();
  follow.onScroll();
  assert.equal(follow.isFollowing(), false);
});

test("return-to-latest explicitly resumes following and scrolls to the latest content", () => {
  const { element, follow, flush } = setup();
  element.scrollTop = 100;
  follow.onScroll();
  element.scrollHeight += 200;
  follow.scrollToBottom(true);
  flush();
  assert.equal(element.scrollTop, 800);
  assert.equal(follow.isFollowing(), true);
});

test("even an explicit return-to-latest yields to subsequent user input", () => {
  const { element, follow, flush } = setup();
  element.scrollTop = 100;
  follow.onScroll();
  follow.scrollToBottom(true);
  follow.pause();
  flush();
  assert.equal(element.scrollTop, 100);
});

test("repeated streaming updates coalesce and use the latest content height", () => {
  const { element, follow, frames, flush } = setup();
  for (let i = 0; i < 20; i += 1) {
    element.scrollHeight += 10;
    follow.scrollToBottom();
  }
  assert.equal(frames.length, 1);
  flush();
  assert.equal(element.scrollTop, 800);
});

test("queued callbacks do not scroll a detached message list", () => {
  const { element, follow, replace, flush } = setup();
  element.scrollHeight += 100;
  follow.scrollToBottom();
  replace(null);
  flush();
  assert.equal(element.scrollTop, 600);
});
