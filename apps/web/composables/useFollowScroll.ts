import { createFollowScroll } from "~/utils/followScroll";

export function useFollowScroll(getList: () => HTMLElement | null) {
  let disposed = false;
  let touchY: number | undefined;
  const frames = new Set<number>();
  const follow = createFollowScroll(getList, (callback) => {
    if (!import.meta.client || disposed) return;
    void nextTick(() => {
      if (disposed) return;
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        if (!disposed) callback();
      });
      frames.add(frame);
    });
  });

  function onWheel(event: WheelEvent) {
    if (event.deltaY < 0) follow.pause();
  }
  function onTouchstart(event: TouchEvent) {
    touchY = event.touches[0]?.clientY;
  }
  function onTouchmove(event: TouchEvent) {
    const nextY = event.touches[0]?.clientY;
    if (nextY !== undefined && touchY !== undefined && nextY > touchY) follow.pause();
    touchY = nextY;
  }
  function onKeydown(event: KeyboardEvent) {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) follow.pause();
  }

  onBeforeUnmount(() => {
    disposed = true;
    follow.pause();
    for (const frame of frames) cancelAnimationFrame(frame);
  });

  return { ...follow, onWheel, onTouchstart, onTouchmove, onKeydown };
}
