// 应急疏散快照
// 给定事件时刻与一个或多个出口区域，按当前校验模式（区段独立 / 连续口令延误传导）
// 已推演出的实际路线，还原每位演员在事件时刻的位置：
//   - 通道行进中：先按原方向走完剩余路程，抵达通道另一端区域后，
//     再从该区域按事件时刻之后的封闭时段计算到任一出口的最早疏散路线；
//   - 区域等待 / 停留：从所在区域、事件时刻直接计算疏散路线；
//   - 因不可达链无法确定位置（或事件时刻早于走位时间轴）：标为位置未知，不猜测。
// 疏散路线复用 graph 的时间依赖 Dijkstra（封闭时段仍会造成等待或绕行），
// 在全部出口区域中取到达时刻最早者。

const { earliestArrival } = require('./graph');
const { simulateActor } = require('./validate');

/** 等待原因（区域等待） */
const WAIT_REASON_TEXT = {
  closure: '通道封闭等待',
  cue: '等待下一口令时刻',
};

/** 停留原因（停留） */
const DWELL_REASON_TEXT = {
  dwell: '计划停留',
  final: '走位结束后停留',
};

/**
 * 将一位演员的逐段推演结果展开为覆盖 [首条口令时刻, +∞) 的互斥时间区间序列。
 * 区间 kind：
 *   travel  通道行进中（edgeId/fromId/toId；end 为该区间的位置窗口结束时刻，
 *           legArrive 为按原方向走完该边实际抵达 toId 区域的时刻——
 *           区段独立模式下后段按计划时刻重新起算可能截断位置窗口，
 *           但物理上仍在通道内，剩余路程以 legArrive 为准）
 *   wait    区域等待（areaId；reason: closure=封闭等待 / cue=等待下一口令时刻）
 *   dwell   停留（areaId；reason: dwell=计划停留 / final=走位结束后停留）
 *   unknown 位置未知（reason: unreachable=不可达区段，连接图不连通，不猜测位置）
 */
function buildTimeline(sim, mode) {
  const propagate = mode === 'propagate';
  const { cues, segments } = sim;
  const intervals = [];
  if (cues.length === 0) return intervals;

  const push = (iv) => {
    if (iv.end > iv.start) intervals.push(iv);
  };
  // 截断时间轴：丢弃 at 及之后的内容
  // （区段独立模式后段按计划时刻重新起算、覆盖前段迟到的重叠；传导模式不可达重置）
  // 注意：被截断的 travel 区间仅缩短位置窗口，legArrive 保留真实抵达时刻，
  // 供「位于通道者先按原方向走完剩余路程」使用。
  const cut = (at) => {
    for (let i = intervals.length - 1; i >= 0; i--) {
      const iv = intervals[i];
      if (iv.start >= at) intervals.splice(i, 1);
      else if (iv.end > at) iv.end = at;
    }
  };

  // 首条口令视为准时到位：演员自该时刻起位于首条口令区域
  let t = cues[0].time;
  let areaId = cues[0].areaId;

  for (const seg of segments) {
    const { from, to } = seg;
    if (propagate) {
      // 到达起点区域后：早到则等待至口令计划时刻，再按计划停留 dwell 秒
      if (from.time > t) push({ start: t, end: from.time, kind: 'wait', reason: 'cue', areaId: from.areaId });
      const dwellStart = Math.max(from.time, t);
      if (seg.dwell > 0) {
        push({ start: dwellStart, end: dwellStart + seg.dwell, kind: 'dwell', reason: 'dwell', areaId: from.areaId });
      }
    } else {
      // 区段独立：每段自上一口令计划时刻重新起算，覆盖此前可能迟到的重叠区间
      cut(from.time);
      t = from.time;
      areaId = from.areaId;
    }

    if (seg.route) {
      let tt = seg.depart;
      for (const leg of seg.route.legs) {
        // 进入连接前的封闭等待发生在其起点区域内
        if (leg.depart > tt) push({ start: tt, end: leg.depart, kind: 'wait', reason: 'closure', areaId: leg.fromId });
        push({
          start: leg.depart,
          end: leg.arrive,
          kind: 'travel',
          edgeId: leg.edgeId,
          fromId: leg.fromId,
          toId: leg.toId,
          legArrive: leg.arrive, // 按原方向走完该边的真实抵达时刻（位置窗口被截断时仍以此为准）
        });
        tt = leg.arrive;
      }
      t = seg.route.time;
      areaId = to.areaId;
      if (!propagate) {
        // 区段独立：到达后在该区域等待下一段计划出发（下一段开始时会被 cut 截断）
        push({ start: t, end: Infinity, kind: 'wait', reason: 'cue', areaId: to.areaId });
      }
    } else if (propagate) {
      // 不可达区段：路线不存在，位置无法确定；传导链自下一口令计划时刻重新起算
      push({ start: seg.depart, end: to.time, kind: 'unknown', reason: 'unreachable' });
      cut(to.time); // 兼容 depart 晚于 to.time 的极端情形（等时刻口令 + 停留）
      t = to.time;
      areaId = to.areaId;
    } else {
      // 区段独立：直至下一段计划出发前位置未知（下一段开始时被 cut 截断）
      push({ start: seg.depart, end: Infinity, kind: 'unknown', reason: 'unreachable' });
    }
  }

  // 时间轴末尾：演员停留在最后所在区域
  if (propagate) {
    push({ start: t, end: Infinity, kind: 'dwell', reason: 'final', areaId });
  } else {
    const last = intervals[intervals.length - 1];
    if (last && last.kind === 'wait' && last.end === Infinity) {
      last.kind = 'dwell';
      last.reason = 'final';
    } else if (!last) {
      // 仅有首条口令、无区段：自首条口令时刻起停留于该区域
      push({ start: cues[0].time, end: Infinity, kind: 'dwell', reason: 'final', areaId: cues[0].areaId });
    }
  }
  return intervals;
}

/** 定位事件时刻所在区间；早于首条口令时刻（时间轴尚未开始）返回 null */
function intervalAt(intervals, eventTime) {
  for (const iv of intervals) {
    if (eventTime >= iv.start && eventTime < iv.end) return iv;
  }
  return null;
}

/** 位置未知的原因说明 */
function unknownReasonText(reason, firstCueTime) {
  switch (reason) {
    case 'no-cues':
      return '该演员没有到位口令，无法还原位置';
    case 'before-start':
      return `事件时刻早于首条口令时刻（第 ${firstCueTime} 秒），走位时间轴尚未开始`;
    default:
      return '事件时刻处于不可达区段（连接图不连通）期间，实际位置无法确定';
  }
}

/**
 * 生成应急疏散快照。
 * @param {object} data 数据（areas / edges / actors / cues）
 * @param {string} mode 校验模式（classic / propagate），与页面当前模式一致
 * @param {number} eventTime 事件时刻（秒，不小于 0 的整数）
 * @param {string[]} exitIds 出口区域 ID（至少一个，均已校验存在）
 * @returns {object} 快照：entries 按最晚撤离优先排序（无法疏散视为最晚），unknown 单列
 */
function evacuationSnapshot(data, mode, eventTime, exitIds) {
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const nameOf = (id) => areaName.get(id) || id;

  const entries = []; // 位置已知（含无法疏散）
  const unknown = []; // 位置未知（不可达链等原因，不猜测）

  data.actors.forEach((actor, actorIndex) => {
    const sim = simulateActor(data, actor, mode);
    const firstCueTime = sim.cues.length > 0 ? sim.cues[0].time : null;

    let iv = null;
    let unknownReason = null;
    if (firstCueTime === null) unknownReason = 'no-cues';
    else if (eventTime < firstCueTime) unknownReason = 'before-start';
    else {
      iv = intervalAt(buildTimeline(sim, mode), eventTime);
      if (!iv || iv.kind === 'unknown') unknownReason = 'unreachable';
    }

    if (unknownReason) {
      unknown.push({
        actorId: actor.id,
        actorName: actor.name,
        reason: unknownReason,
        reasonText: unknownReasonText(unknownReason, firstCueTime),
      });
      return;
    }

    // 疏散起点与开始时刻：位于通道者先按原方向走完剩余路程
    let evacFrom;
    let evacStart;
    let position;
    if (iv.kind === 'travel') {
      // 真实抵达时刻：位置窗口可能被后段截断（区段独立模式），剩余路程以实际抵达为准
      const arrive = iv.legArrive !== undefined ? iv.legArrive : iv.end;
      evacFrom = iv.toId;
      evacStart = arrive; // 抵达通道另一端区域的时刻
      position = {
        kind: 'corridor',
        state: '通道行进中',
        edgeId: iv.edgeId,
        fromId: iv.fromId,
        fromName: nameOf(iv.fromId),
        toId: iv.toId,
        toName: nameOf(iv.toId),
        remainingSeconds: arrive - eventTime,
        arriveTime: arrive,
      };
    } else {
      evacFrom = iv.areaId;
      evacStart = eventTime;
      position = {
        kind: 'area',
        state: iv.kind === 'dwell' ? '停留' : '区域等待',
        reason: iv.reason,
        reasonText: iv.kind === 'dwell' ? DWELL_REASON_TEXT[iv.reason] : WAIT_REASON_TEXT[iv.reason],
        areaId: iv.areaId,
        areaName: nameOf(iv.areaId),
      };
    }

    // 到任一出口的最早疏散路线（出发时刻 ≥ 事件时刻，封闭时段自然生效）
    let best = null;
    for (const exitId of exitIds) {
      const ea = earliestArrival(data.edges, evacFrom, exitId, evacStart);
      if (ea && (!best || ea.time < best.time)) best = { exitId, time: ea.time, legs: ea.legs };
    }

    const entry = { actorId: actor.id, actorName: actor.name, actorIndex, position };
    if (!best) {
      entry.status = 'unreachable'; // 位置已知，但没有任何出口可达
      entry.evacuation = null;
    } else {
      entry.status = 'ok';
      entry.evacuation = {
        exitId: best.exitId,
        exitName: nameOf(best.exitId),
        startTime: evacStart,
        arrivalTime: best.time,
        durationSeconds: best.time - eventTime, // 自事件时刻起的疏散耗时（含剩余路程）
        path: [evacFrom, ...best.legs.map((l) => l.toId)].map(nameOf),
        legs: best.legs.map((l) => ({
          edgeId: l.edgeId,
          fromName: nameOf(l.fromId),
          toName: nameOf(l.toId),
          departTime: l.depart,
          arriveTime: l.arrive,
          waitSeconds: l.wait,
          travelSeconds: l.arrive - l.depart,
        })),
        waits: best.legs
          .filter((l) => l.wait > 0)
          .map((l) => ({ areaName: nameOf(l.fromId), seconds: l.wait })),
      };
    }
    entries.push(entry);
  });

  // 最晚撤离优先：无法疏散（永远无法撤离）排最前，其余按到达时刻降序
  const rank = (e) => (e.status === 'unreachable' ? Number.POSITIVE_INFINITY : e.evacuation.arrivalTime);
  entries.sort((x, y) => rank(y) - rank(x) || x.actorIndex - y.actorIndex);

  const arrivals = entries.filter((e) => e.status === 'ok').map((e) => e.evacuation.arrivalTime);
  return {
    mode: mode === 'propagate' ? 'propagate' : 'classic',
    eventTime,
    exits: exitIds.map((id) => ({ id, name: nameOf(id) })),
    generatedAt: new Date().toISOString(),
    summary: {
      actors: data.actors.length,
      known: entries.length,
      unknown: unknown.length,
      unreachable: entries.filter((e) => e.status === 'unreachable').length,
      latestArrival: arrivals.length > 0 ? Math.max(...arrivals) : null,
    },
    entries,
    unknown,
  };
}

module.exports = { evacuationSnapshot, buildTimeline };
