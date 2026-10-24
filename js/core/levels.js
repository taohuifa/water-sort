/**
 * 关卡配置与颜色表
 * 颜色 ID 即 COLORS 下标；每种颜色的液体总量恒等于瓶容量，保证能满瓶
 */

export const CAPACITY = 4; // 每瓶容量（层数）

export const COLORS = [
  { name: '草莓', main: '#F94F6D' },
  { name: '橙子', main: '#FF9838' },
  { name: '芒果', main: '#FFC933' },
  { name: '青苹果', main: '#8BD450' },
  { name: '蓝莓', main: '#5B8DEF' },
  { name: '葡萄', main: '#A26BF2' },
  { name: '椰子', main: '#F3EAD7' },
  { name: '抹茶', main: '#4FB08C' },
];

/**
 * 10 关难度曲线（对应方案 8.4 阶段二「手工配置 10 关」）：
 * colors = 颜色数；empties = 初始空瓶数；总瓶数 = colors + empties
 * 同一 seed 局面固定，可复现
 */
export const LEVELS = [
  { colors: 2, empties: 2, seed: 101 }, // 第 1 关：4 瓶，教学
  { colors: 3, empties: 2, seed: 102 }, // 第 2 关：5 瓶
  { colors: 3, empties: 2, seed: 103 }, // 第 3 关：5 瓶
  { colors: 4, empties: 2, seed: 104 }, // 第 4 关：6 瓶
  { colors: 4, empties: 2, seed: 105 }, // 第 5 关：6 瓶
  { colors: 5, empties: 2, seed: 106 }, // 第 6 关：7 瓶
  { colors: 5, empties: 3, seed: 107 }, // 第 7 关：8 瓶
  { colors: 6, empties: 3, seed: 108 }, // 第 8 关：9 瓶
  { colors: 6, empties: 3, seed: 109 }, // 第 9 关：9 瓶
  { colors: 7, empties: 3, seed: 110 }, // 第 10 关：10 瓶
];
