// A player's virtual address as text (nfsu2-util vip_str): "a.b.c.d" of a u32, its high byte first.

/**
 * @param {number} v a u32
 * @returns {string}
 */
export function vipStr(v) {
  v >>>= 0;
  return (v >>> 24) + '.' + ((v >>> 16) & 255) + '.' + ((v >>> 8) & 255) + '.' + (v & 255);
}
