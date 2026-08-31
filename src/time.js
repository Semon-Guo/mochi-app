/* 北京时间的几个原语。
 *
 * 全组的记录都按北京时间归日：组里的人可能在不同时区开会或出差，按各自的
 * 本地时区分天的话，同一条记录在导师和学生的界面上会落在不同的日期，
 * 讨论「8 月 30 号那次扫描」时就对不上了。
 */
export function bjNow() {
  return new Date(Date.now() + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000));
}
export function toBJ(ts) {
  return new Date(ts + (8 * 3600000) + (new Date().getTimezoneOffset() * 60000));
}
/** 一天的键。用 toDateString 而不是自己拼，省得跨月跨年时自己补零出错。 */
export function dayKeyOf(ts) { return toBJ(ts).toDateString(); }

export const p2 = (n) => String(n).padStart(2, "0");
