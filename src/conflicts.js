// 通道占用冲突检测
// 在两种走位模式算出逐边路线后，将所有演员对同一无向连接的占用区间
// 按 [进入(enter), 离开(leave)) 汇总（半开区间：首尾恰好相接不算重叠；
// 等待发生在区域内，不会产生占用区间）。
// 任一时刻并发演员数（按演员去重）超过连接容量（默认 1，可设 1～10）即冲突，
// 连续的超载区间合并为一条冲突事件，记录起止时刻、峰值人数与涉及的各次占用。

/** 连接容量：旧数据无该字段时按 1 处理 */
function capacityOf(edge) {
  return Number.isInteger(edge.capacity) && edge.capacity >= 1 && edge.capacity <= 10 ? edge.capacity : 1;
}

/** 同一无向连接上的事件扫描：返回该连接上的合并超载区间列表 */
function sweepEdge(edge, occs) {
  const capacity = capacityOf(edge);
  // 占用为半开区间 [enter, leave)，零时长通过不产生占用
  const events = [];
  for (const occ of occs) {
    if (occ.leave > occ.enter) {
      events.push({ t: occ.enter, type: 'in', occ });
      events.push({ t: occ.leave, type: 'out', occ });
    }
  }
  events.sort((x, y) => x.t - y.t || (x.type === 'out' ? -1 : 1));

  const conflicts = [];
  let active = []; // 当前时刻仍占用通道的记录
  let cur = null; // 当前（已合并连续区间的）超载事件

  const close = (t) => {
    cur.endTime = t;
    // 仅保留真正参与超载的占用（超载区间内的活跃占用）
    cur.occupancies = cur.occupancies.filter((o) => o.enter < t && o.leave > cur.startTime);
    conflicts.push(cur);
    cur = null;
  };

  let i = 0;
  while (i < events.length) {
    const t = events[i].t;
    // 同一时刻的事件成批处理：先离开、后进入（首尾相接不算重叠）
    let j = i;
    while (j < events.length && events[j].t === t) j++;
    for (let k = i; k < j; k++) {
      const ev = events[k];
      if (ev.type === 'out') active = active.filter((o) => o !== ev.occ);
    }
    for (let k = i; k < j; k++) {
      const ev = events[k];
      if (ev.type === 'in') active.push(ev.occ);
    }

    // 并发「人数」按演员去重（同一演员的多段假想路线不重复计数）
    const actorCount = new Set(active.map((o) => o.actorId)).size;
    if (actorCount > capacity) {
      if (!cur) {
        cur = { edgeId: edge.id, startTime: t, endTime: t, peak: actorCount, occupancies: active.slice() };
      } else {
        if (actorCount > cur.peak) cur.peak = actorCount;
        for (const o of active) {
          if (!cur.occupancies.includes(o)) cur.occupancies.push(o);
        }
      }
    } else if (cur) {
      close(t);
    }
    i = j;
  }
  if (cur) close(cur.endTime); // 理论上最后一个事件必为 out，兜底
  return conflicts;
}

/**
 * 汇总全部占用并检测通道占用冲突。
 * @param {Array} edges 连接（无向；capacity 缺省 1）
 * @param {Array} occupancies 占用记录
 *   [{ edgeId, actorId, actorName, fromId, toId, fromName, toName,
 *      enter, leave, actorIndex, segmentIndex }]
 * @param {function} [nameOfArea] 区域 id → 名称（用于渲染连接名）
 * @returns {Array} 冲突事件（按开始时刻、连接名排序），每条：
 *   { id, edgeId, edgeName, capacity, startTime, endTime, durationSeconds,
 *     peak, occupancies: [{ actorName, direction, enter, leave, actorIndex, segmentIndex }] }
 */
function detectConflicts(edges, occupancies, nameOfArea) {
  const byEdge = new Map(edges.map((e) => [e.id, []]));
  for (const occ of occupancies) {
    if (byEdge.has(occ.edgeId)) byEdge.get(occ.edgeId).push(occ);
  }

  const raw = [];
  for (const edge of edges) {
    raw.push(...sweepEdge(edge, byEdge.get(edge.id) || []));
  }

  const edgeLabel = (edge) => {
    if (!nameOfArea) return edge.id;
    return `${nameOfArea(edge.a) || edge.a} ↔ ${nameOfArea(edge.b) || edge.b}`;
  };

  return raw
    .map((c) => {
      const edge = edges.find((e) => e.id === c.edgeId);
      return {
        edgeId: c.edgeId,
        edgeName: edgeLabel(edge),
        capacity: capacityOf(edge),
        startTime: c.startTime,
        endTime: c.endTime,
        durationSeconds: c.endTime - c.startTime,
        peak: c.peak,
        occupancies: c.occupancies
          .slice()
          .sort(
            (x, y) =>
              x.enter - y.enter ||
              x.leave - y.leave ||
              x.actorIndex - y.actorIndex ||
              x.segmentIndex - y.segmentIndex
          )
          .map((o) => ({
            actorId: o.actorId,
            actorName: o.actorName,
            direction: `${o.fromName} → ${o.toName}`,
            enter: o.enter,
            leave: o.leave,
            actorIndex: o.actorIndex,
            segmentIndex: o.segmentIndex,
          })),
      };
    })
    .sort((x, y) => x.startTime - y.startTime || x.endTime - y.endTime || x.edgeId.localeCompare(y.edgeId))
    .map((c, i) => ({ id: `conflict-${i + 1}`, ...c }));
}

module.exports = { detectConflicts, capacityOf };
