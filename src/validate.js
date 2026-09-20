const { earliestArrival } = require('./graph');
const { detectConflicts } = require('./conflicts');

const MODES = ['classic', 'propagate'];

/**
 * 口令停留时长（秒）：旧数据无该字段，按 0 处理；所有模式统一口径。
 * 跨演员口令依赖中「前置口令完成时刻 = 实际到达 + 停留时长」即使用该值。
 */
function dwellOf(cue) {
  const d = cue.dwell;
  return Number.isInteger(d) && d > 0 ? d : 0;
}

/**
 * 演员逐段推演（校验与应急疏散快照共用的事实来源）：
 * 将演员的到位口令按时间升序排列，逐段推演至下一口令区域，
 * 进入连接若与封闭时段重叠，则在区域等待或改走其他路径（复用 graph 的时间依赖 Dijkstra）。
 *
 * mode = 'classic'（区段独立校验）：
 *   每段从上一口令计划时刻出发，段与段互不影响。
 * mode = 'propagate'（连续口令延误传导）：
 *   首条口令视为准时到位；出发时刻 = max(该条计划时刻, 实际到达该条的时刻) + 该条停留时长，
 *   迟到逐段传导；不可达区段无法计算实际到达，其后区段自下一口令计划时刻重新起算。
 *
 * @returns {{ cues: Array, segments: Array, finalArrival: number }}
 *   cues：参与推演的口令（已过滤失效区域、按时间升序）；
 *   segments[i]：{ index, from, to, dwell, plannedDepart, depart, inheritedDelay, route, status }
 *     - route：earliestArrival 的结果 { time, legs }，不可达为 null；
 *     - status：ok / fail / unreachable（按 最早到达 ≤ 下一口令时刻 判定）；
 *   finalArrival：传导链末端的实际到达时刻（不可达区段后按计划时刻起算）。
 */
function simulateActor(data, actor, mode = 'classic') {
  const propagate = mode === 'propagate';
  const areaIds = new Set(data.areas.map((a) => a.id));
  const cues = data.cues
    .filter((c) => c.actorId === actor.id && areaIds.has(c.areaId))
    .slice()
    .sort((x, y) => x.time - y.time);

  const segments = [];
  // 传导模式：首条口令视为准时到位，之后逐段携带上一段的实际到达时刻
  let prevArrival = cues.length > 0 ? cues[0].time : 0;

  for (let i = 0; i + 1 < cues.length; i++) {
    const from = cues[i];
    const to = cues[i + 1];
    const dwell = propagate ? dwellOf(from) : 0;
    // 继承延误 = 到达本段起点口令时已经晚于计划的秒数
    const inheritedDelay = propagate ? Math.max(0, prevArrival - from.time) : 0;
    // 出发时刻取计划时刻与实际到达时刻的较晚值，再加停留时长
    const depart = propagate ? Math.max(from.time, prevArrival) + dwell : from.time;
    const plannedDepart = from.time + dwell;
    const route = earliestArrival(data.edges, from.areaId, to.areaId, depart);

    let status;
    if (!route) {
      status = 'unreachable';
      // 实际到达未知：传导链自下一口令计划时刻重新起算
      if (propagate) prevArrival = to.time;
    } else {
      status = route.time <= to.time ? 'ok' : 'fail';
      if (propagate) prevArrival = route.time;
    }

    segments.push({ index: i + 1, from, to, dwell, plannedDepart, depart, inheritedDelay, route, status });
  }

  return { cues, segments, finalArrival: prevArrival };
}

/**
 * 走位校验：基于 simulateActor 的逐段推演结果，
 * 以最早到达时刻判定 按时 / 超时，图上不连通判定为 不可达，
 * 并汇总全部演员逐边路线对无向连接的占用做通道占用冲突校验。
 */
function validate(data, mode = 'classic') {
  const propagate = mode === 'propagate';
  const areaName = new Map(data.areas.map((a) => [a.id, a.name]));
  const actorById = new Map(data.actors.map((a) => [a.id, a]));
  const actors = [];
  const occupancies = []; // 所有演员逐边路线对无向连接的占用区间 [进入, 离开)
  const cueTiming = new Map(); // 口令 ID → 该模式下的实际到达 / 实际出发事实（供跨演员依赖评估）
  let ok = 0;
  let failed = 0;
  let unreachable = 0;

  for (const actor of data.actors) {
    const actorIndex = data.actors.indexOf(actor);
    const sim = simulateActor(data, actor, mode);

    // 收集每条参与推演口令的时刻事实：
    // 首条口令视为准时到位（实际到达 = 计划时刻，无上游区段、无「实际出发」）；
    // 其余口令的实际到达 / 实际出发来自其上游区段（segments[i-1]）。
    sim.cues.forEach((cue, i) => {
      if (i === 0) {
        cueTiming.set(cue.id, {
          cue,
          actor,
          actualArrival: cue.time,
          actualDepart: null,
          incomingUnreachable: false,
        });
      } else {
        const seg = sim.segments[i - 1];
        cueTiming.set(cue.id, {
          cue,
          actor,
          actualArrival: seg.route ? seg.route.time : null,
          actualDepart: seg.depart, // 自上游口令区域实际出发（不可达区段也有出发时刻，但到达未知）
          incomingUnreachable: !seg.route,
        });
      }
    });

    const segments = [];
    for (const s of sim.segments) {
      const { from, to, dwell, plannedDepart, depart, inheritedDelay, route } = s;
      const available = to.time - depart;

      let required = null;
      let slack = null;
      let arrivalTime = null;
      let lateness = null;
      let routePath = [];
      let legs = [];
      let waits = [];

      if (!route) {
        unreachable++;
      } else {
        arrivalTime = route.time;
        required = route.time - depart; // 含途中等待的实际所需秒数
        slack = available - required;
        lateness = Math.max(0, route.time - to.time); // 到达下一条口令时的最终迟到
        routePath = [from.areaId, ...route.legs.map((l) => l.toId)].map((id) => areaName.get(id) || id);
        legs = route.legs.map((l) => ({
          edgeId: l.edgeId,
          fromName: areaName.get(l.fromId) || l.fromId,
          toName: areaName.get(l.toId) || l.toId,
          departTime: l.depart,
          arriveTime: l.arrive,
          waitSeconds: l.wait,
          travelSeconds: l.arrive - l.depart,
        }));
        // 通道占用：仅实际行进区间 [depart, arrive)；进入前的区域等待不占用通道
        route.legs.forEach((l) => {
          occupancies.push({
            edgeId: l.edgeId,
            actorId: actor.id,
            actorName: actor.name,
            fromId: l.fromId,
            toId: l.toId,
            fromName: areaName.get(l.fromId) || l.fromId,
            toName: areaName.get(l.toId) || l.toId,
            enter: l.depart,
            leave: l.arrive,
            actorIndex,
            segmentIndex: s.index,
          });
        });
        waits = legs
          .filter((l) => l.waitSeconds > 0)
          .map((l) => ({ areaName: l.fromName, seconds: l.waitSeconds }));
        if (s.status === 'ok') ok++;
        else failed++;
      }

      const segment = {
        index: s.index,
        // 稳定区段键依据：演员 ID + 相邻口令 ID（供基线对比，避免按数组位置错配）
        fromCueId: from.id,
        toCueId: to.id,
        from: { time: from.time, areaName: areaName.get(from.areaId), note: from.note || '' },
        to: { time: to.time, areaName: areaName.get(to.areaId), note: to.note || '' },
        availableSeconds: available,
        requiredSeconds: required,
        slackSeconds: slack,
        arrivalTime,
        path: routePath,
        legs,
        waits,
        status: s.status,
      };
      if (propagate) {
        segment.from.dwell = dwell;
        segment.to.dwell = dwellOf(to);
        segment.plannedDepart = plannedDepart; // 计划出发 = 计划时刻 + 停留时长
        segment.actualDepart = depart; // 实际出发（含继承延误）
        segment.inheritedDelay = inheritedDelay; // 从上一段继承的延误
        segment.lateness = lateness; // 到达终点口令时的最终迟到（不可达为 null）
      }
      segments.push(segment);
    }

    const actorResult = {
      actorId: actor.id,
      actorName: actor.name,
      cueCount: sim.cues.length,
      segments,
    };
    if (propagate && sim.cues.length > 0) {
      // 传导链末端（末条口令）的最终迟到；不可达区段后按计划时刻起算，迟到记 0
      actorResult.finalLateness = Math.max(0, sim.finalArrival - sim.cues[sim.cues.length - 1].time);
    }
    actors.push(actorResult);
  }

  // 通道占用冲突：汇总全部逐边占用，按无向连接检测超载区间并合并连续时段
  const conflicts = detectConflicts(data.edges, occupancies, (id) => areaName.get(id));

  // 将冲突关联到相关区段（按演员 + 区段号匹配占用）
  const segByKey = new Map();
  actors.forEach((ar) => {
    ar.segments.forEach((seg) => segByKey.set(`${ar.actorId}#${seg.index}`, seg));
  });
  for (const conflict of conflicts) {
    for (const occ of conflict.occupancies) {
      const seg = segByKey.get(`${occ.actorId}#${occ.segmentIndex}`);
      if (!seg) continue;
      if (!seg.conflicts) seg.conflicts = [];
      const brief = {
        conflictId: conflict.id,
        edgeId: conflict.edgeId,
        edgeName: conflict.edgeName,
        startTime: conflict.startTime,
        endTime: conflict.endTime,
        peak: conflict.peak,
        capacity: conflict.capacity,
      };
      if (!seg.conflicts.some((x) => x.conflictId === brief.conflictId)) seg.conflicts.push(brief);
    }
  }

  const dependencies = evaluateDependencies(data, cueTiming, actorById, areaName);

  return {
    mode: propagate ? 'propagate' : 'classic',
    generatedAt: new Date().toISOString(),
    summary: {
      actors: data.actors.length,
      segments: ok + failed + unreachable,
      ok,
      failed,
      unreachable,
      conflicts: conflicts.length,
      dependencies: dependencies.items.length,
      dependenciesSatisfied: dependencies.summary.satisfied,
      dependenciesViolated: dependencies.summary.violated,
      dependenciesUnknown: dependencies.summary.unknown,
    },
    actors,
    conflicts,
    dependencies,
  };
}

const DEPENDENCY_STATUS_RANK = { violated: 0, unknown: 1, satisfied: 2 };

/** 口令简要信息（报告与页面共用） */
function cueBrief(cue, actor, areaName) {
  return {
    cueId: cue.id,
    actorId: cue.actorId,
    actorName: actor ? actor.name : '（已删除演员）',
    time: cue.time,
    areaName: areaName.get(cue.areaId) || '（已删除区域）',
    note: cue.note || '',
    dwell: dwellOf(cue),
  };
}

/**
 * 评估全部跨演员口令依赖：
 * 前置完成时刻 = 前置口令在当前模式下的实际到达时刻 + 其停留时长；
 * 后置实际出发时刻 = 前往后置口令的区段实际出发时刻；
 * 约束「完成 + 等待 N ≤ 后置实际出发」满足即 satisfied，否则 violated，
 * 任一端时刻事实不可得（口令缺失、首条口令无出发、上游不可达）标 unknown（无法判定）。
 */
function evaluateDependencies(data, cueTiming, actorById, areaName) {
  const list = Array.isArray(data.dependencies) ? data.dependencies : [];
  const items = [];

  for (const dep of list) {
    const before = cueTiming.get(dep.predecessorId);
    const after = cueTiming.get(dep.successorId);
    const beforeCue = data.cues.find((c) => c.id === dep.predecessorId);
    const afterCue = data.cues.find((c) => c.id === dep.successorId);
    const beforeActor = beforeCue ? actorById.get(beforeCue.actorId) : null;
    const afterActor = afterCue ? actorById.get(afterCue.actorId) : null;

    const item = {
      id: dep.id,
      waitSeconds: dep.waitSeconds,
      predecessor: beforeCue ? cueBrief(beforeCue, beforeActor, areaName) : { cueId: dep.predecessorId },
      successor: afterCue ? cueBrief(afterCue, afterActor, areaName) : { cueId: dep.successorId },
      crossActor: beforeCue && afterCue ? beforeCue.actorId !== afterCue.actorId : null,
      completionTime: null, // 前置实际完成时刻（实际到达 + 停留）
      successorDepart: null, // 后置实际出发时刻
      requiredDepart: null, // 后置允许的最早实际出发时刻（完成 + 等待）
      delta: null, // 实际出发 - 允许最早出发：满足时为余量，违约时为负的缺口
      status: 'unknown',
      reason: '',
    };

    if (!beforeCue || !afterCue) {
      item.reason = '口令已不存在（依赖为失效残留，将在下次保存时清理）';
    } else if (!before) {
      item.reason = '前置口令未参与推演（其目标区域可能已删除），实际到达未知';
    } else if (before.actualArrival === null) {
      item.reason = '前往前置口令的区段不可达，前置口令实际到达时刻未知';
    } else if (!after) {
      item.reason = '后置口令未参与推演（其目标区域可能已删除），实际出发未知';
    } else if (after.actualDepart === null) {
      // 该演员的首条口令没有上游区段，不存在「实际出发时刻」
      item.reason = '后置口令是该演员的首条口令，没有前往该口令的区段，实际出发时刻未知';
    } else if (after.incomingUnreachable) {
      item.reason = '前往后置口令的区段不可达，后置口令实际无法抵达，实际出发时刻不具参考性';
    } else {
      const completion = before.actualArrival + dwellOf(beforeCue);
      const required = completion + dep.waitSeconds;
      const delta = after.actualDepart - required;
      item.completionTime = completion;
      item.successorDepart = after.actualDepart;
      item.requiredDepart = required;
      item.delta = delta;
      if (delta >= 0) {
        item.status = 'satisfied';
      } else {
        item.status = 'violated';
      }
    }
    items.push(item);
  }

  // 违约优先、无法判定其次、满足最后；组内按前置演员与时刻稳定排序
  items.sort(
    (x, y) =>
      DEPENDENCY_STATUS_RANK[x.status] - DEPENDENCY_STATUS_RANK[y.status] ||
      String(x.predecessor.actorName || '').localeCompare(String(y.predecessor.actorName || ''), 'zh') ||
      (x.predecessor.time ?? 0) - (y.predecessor.time ?? 0) ||
      (x.successor.time ?? 0) - (y.successor.time ?? 0)
  );

  return {
    items,
    summary: {
      total: items.length,
      satisfied: items.filter((i) => i.status === 'satisfied').length,
      violated: items.filter((i) => i.status === 'violated').length,
      unknown: items.filter((i) => i.status === 'unknown').length,
    },
  };
}

module.exports = { validate, simulateActor, dwellOf, MODES };
