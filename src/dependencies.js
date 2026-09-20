// 跨演员口令依赖
// 在两条口令（可属于不同演员）之间维护有向约束：
// 前置口令「完成」（当前模式下的实际到达时刻 + 停留时长）后至少等待 N 秒，
// 后置口令才可实际出发。依赖集合本身构成一张以口令为节点的有向图，
// 每次保存前必须对整张图做环检测：成环则拒绝写入并返回口令链。

const { fmtTime } = require('./report');

/** 最短等待秒数上限 */
const MAX_WAIT_SECONDS = 3600;

/**
 * 在依赖有向图中查找一个环。
 * @param {Array} dependencies [{ predecessorId, successorId }]
 * @returns {Array<string>|null} 有环返回节点 ID 序列（首尾相同，便于直接渲染为口令链）；无环返回 null
 */
function findCycle(dependencies) {
  const adj = new Map();
  for (const d of dependencies) {
    if (!adj.has(d.predecessorId)) adj.set(d.predecessorId, []);
    adj.get(d.predecessorId).push(d.successorId);
  }

  const GRAY = 1; // 在当前递归栈中
  const BLACK = 2; // 已完成
  const color = new Map();
  const stack = [];

  const dfs = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) || []) {
      const cv = color.get(v) || 0;
      if (cv === GRAY) {
        // 回到当前递归栈中的节点：提取环并把起点补到末尾形成闭合口令链
        return stack.slice(stack.indexOf(v)).concat(v);
      }
      if (cv === 0) {
        const found = dfs(v);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(u, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if (!color.has(node)) {
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

/** 口令的可读标签：演员 时刻 区域（用于成环错误中的口令链） */
function cueLabel(data, cueId) {
  const cue = data.cues.find((c) => c.id === cueId);
  if (!cue) return `（已删除口令 ${cueId}）`;
  const actor = data.actors.find((a) => a.id === cue.actorId);
  const area = data.areas.find((a) => a.id === cue.areaId);
  const actorText = actor ? actor.name : '（已删除演员）';
  const areaText = area ? area.name : '（已删除区域）';
  return `${actorText} ${fmtTime(cue.time)} ${areaText}`;
}

/** 成环错误文案：包含完整口令链 */
function cycleMessage(data, chain) {
  return '依赖图存在环，无法保存，闭环口令链为：' + chain.map((id) => cueLabel(data, id)).join(' → ');
}

module.exports = { findCycle, cueLabel, cycleMessage, MAX_WAIT_SECONDS };
