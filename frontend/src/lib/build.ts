/**
 * 这一份前端是哪次构建。
 *
 * 版本号回答"第几个发布"，构建指纹回答"哪一次编译"。排查"改了怎么没生效"
 * 这类问题时，后者才有用：同一个 1.0.1 可能被打过好几遍。
 */

export const APP_VERSION = "2.0.2-beta";

export const BUILD_ID = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

/** `20261030-1140` → `2026-10-30 11:40`；认不出来就原样返回。 */
export function buildLabel(id: string = BUILD_ID): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(id);
  if (!m) return id;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

export const BUILD_LABEL = buildLabel();
