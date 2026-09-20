// 舞台区域连接图的通行耗时计算
// 支持「通道封闭时段」的时间依赖推演：从出发时刻起逐边推演，
// 进入连接的占用区间 [t, t+seconds] 若与封闭区间 [start, end) 重叠，
// 则在连接起点所在区域等待至封闭结束；同时自动比较绕行路径（FIFO 网络，Dijkstra 适用）。

function buildAdjacency(edges) {
  const adj = new Map();
  const add = (from, to, edge) => {
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ to, edge });
  };
  for (const e of edges) {
    if (e.a === e.b) continue;
    // 无向边：两个方向耗时与封闭时段相同
    add(e.a, e.b, e);
    add(e.b, e.a, e);
  }
  return adj;
}

/**
 * 在时刻 t 进入一条通行耗时为 seconds 的连接，占用区间为 [t, t+seconds]。
 * 若占用区间与某段封闭 [start, end) 重叠（t < end 且 t+seconds > start），
 * 则需在连接入口等待至该封闭结束。返回最早可进入（出发）时刻。
 */
function earliestDeparture(t, seconds, closures) {
  let depart = t;
  const sorted = (closures || []).slice().sort((x, y) => x.start - y.start || x.end - y.end);
  for (const { start, end } of sorted) {
    if (end <= depart) continue; // 封闭已结束，不影响
    if (depart + seconds <= start) break; // 可在封闭开始前通过，之后的封闭更晚
    depart = end; // 与封闭冲突：等待至该封闭结束（等待发生在连接起点的区域内）
  }
  return depart;
}

/**
 * 从 startTime 时刻自 fromId 出发，推演至 toId 的最早到达时刻与实际路线。
 * 遇到封闭时段时在区域等待或改走其他路径。
 * @returns {{time: number, legs: Array} | null} 不可达时返回 null
 *   legs 按行进顺序排列：[{ edgeId, fromId, toId, depart, arrive, wait }]
 *   其中 wait 为进入该连接前在 fromId 区域等待的秒数。
 */
function earliestArrival(edges, fromId, toId, startTime) {
  if (fromId === toId) return { time: startTime, legs: [] };

  const adj = buildAdjacency(edges);
  const dist = new Map([[fromId, startTime]]);
  const prev = new Map();
  const visited = new Set();
  const queue = [{ id: fromId, d: startTime }];

  while (queue.length > 0) {
    // 图规模小，直接线性取最小值
    let bestIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].d < queue[bestIdx].d) bestIdx = i;
    }
    const { id, d } = queue.splice(bestIdx, 1)[0];
    if (visited.has(id)) continue;
    visited.add(id);
    if (id === toId) break;

    for (const { to, edge } of adj.get(id) || []) {
      const depart = earliestDeparture(d, edge.seconds, edge.closures);
      const nd = depart + edge.seconds;
      if (nd < (dist.has(to) ? dist.get(to) : Infinity)) {
        dist.set(to, nd);
        prev.set(to, { from: id, edgeId: edge.id, depart, arrive: nd });
        queue.push({ id: to, d: nd });
      }
    }
  }

  if (!dist.has(toId)) return null;

  // 回溯实际路线（正序）
  const legs = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur);
    legs.unshift({ edgeId: p.edgeId, fromId: p.from, toId: cur, depart: p.depart, arrive: p.arrive });
    cur = p.from;
  }
  // 逐段计算在起点区域的等待时长
  let t = startTime;
  for (const leg of legs) {
    leg.wait = leg.depart - t;
    t = leg.arrive;
  }
  return { time: dist.get(toId), legs };
}

module.exports = { earliestArrival, earliestDeparture };
