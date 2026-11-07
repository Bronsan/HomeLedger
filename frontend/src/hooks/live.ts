import { useEffect, useRef } from "react";
import { subscribeChanges } from "../lib/live";

/**
 * 有人改了数据就重新取一次当前视图。
 *
 * `entities` 为空表示"什么都关心"（首页的统计就是这样）。给了实体名的页面
 * 只在自己关心的东西变了时刷新——详情页不必因为别人改了一台空调就重取。
 *
 * 默认 250ms 防抖：一次批量导入会连着发几十条提示，页面只该刷一次。
 * 重取是静默的（不显示骨架屏），否则每次有人保存，这边就闪一下。
 */
export function useLiveRefresh(reload: () => void, entities?: string[], delay = 250): void {
  const callback = useRef(reload);
  callback.current = reload;

  const key = (entities || []).join(",");

  useEffect(() => {
    const wanted = key ? key.split(",") : [];
    let timer: number | null = null;

    const off = subscribeChanges((event) => {
      if (wanted.length) {
        const hit = event.entities.some((e) => e === "all" || wanted.includes(e));
        if (!hit) return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        callback.current();
      }, delay);
    });

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      off();
    };
  }, [key, delay]);
}
