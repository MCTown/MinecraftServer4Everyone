interface ScrollList {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** Track reading intent separately from the distance to the newest message. */
export function createFollowScroll<T extends ScrollList>(getList: () => T | null, schedule: (callback: () => void) => void) {
  let following = true;
  let currentList: T | null = null;
  let lastScrollTop = 0;
  let revision = 0;
  let pending = false;

  function list() {
    const next = getList();
    if (next !== currentList) {
      currentList = next;
      lastScrollTop = next?.scrollTop ?? 0;
      revision += 1;
      pending = false;
    }
    return next;
  }

  function pause() {
    list();
    following = false;
    revision += 1;
    pending = false;
  }

  function onScroll() {
    const element = list();
    if (!element) return;
    if (element.scrollTop < lastScrollTop) pause();
    else if (element.scrollTop > lastScrollTop && element.scrollHeight - element.scrollTop - element.clientHeight <= 2) following = true;
    lastScrollTop = element.scrollTop;
  }

  function scrollToBottom(force = false) {
    const element = list();
    if (force) following = true;
    if (!following || !element || pending) return;
    pending = true;
    const scheduledRevision = revision;
    const scroll = () => {
      if (scheduledRevision !== revision || !following || getList() !== element) return false;
      element.scrollTop = element.scrollHeight;
      lastScrollTop = element.scrollTop;
      return true;
    };
    schedule(() => {
      if (!scroll()) return;
      // A second frame accounts for layout changes, but must still respect user input.
      schedule(() => {
        if (scheduledRevision !== revision) return;
        scroll();
        pending = false;
      });
    });
  }

  return { isFollowing: () => following, pause, onScroll, scrollToBottom };
}
