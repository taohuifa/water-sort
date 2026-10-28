/**
 * 道具背包纯逻辑（PRD-玩法扩展 §2 D/E）：
 * 全局库存 {undo, shuffle, addBottle} 的默认值、存档清洗合并、首入发放叠加与扣减校验。
 * 纯函数、无状态、不依赖 wx（持久化读写与时机控制归 main.js 胶水层）。
 */

export const PROP_KEYS = ['undo', 'shuffle', 'addBottle'];

/** 初始存量（PRD 默认值：undo 3 / shuffle 1 / addBottle 1） */
export function defaultInventory() {
  return { undo: 3, shuffle: 1, addBottle: 1 };
}

/**
 * 存档清洗合并：旧存档（可能为空串 / null / 缺字段 / 含非法值）与默认库存合并。
 * 只认非负整数，非法或缺省字段回退默认值；返回新对象，不修改入参。
 */
export function mergeInventory(saved) {
  const inv = defaultInventory();
  if (saved && typeof saved === 'object') {
    for (const k of PROP_KEYS) {
      const v = saved[k];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0) inv[k] = v;
    }
  }
  return inv;
}

/**
 * 首入赠送叠加：按关卡 grant（如 {shuffle:1}）把合法非负整数累加进背包。
 * grant 缺省 / 字段非法时原值保持；返回新对象，不修改入参。
 */
export function applyGrant(inv, grant) {
  const out = { ...inv };
  if (grant && typeof grant === 'object') {
    for (const k of PROP_KEYS) {
      const v = grant[k];
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) out[k] += v;
    }
  }
  return out;
}

/** 库存是否可消耗（> 0 即可用；局面可行性由 core 层判定） */
export function canConsume(inv, type) {
  return !!inv[type] && inv[type] > 0;
}

/** 扣减 1（原地修改；调用方须先 canConsume，或接受无副作用的责任） */
export function consume(inv, type) {
  if (canConsume(inv, type)) inv[type]--;
  return inv;
}
