// 走位方案基线对比
// 用户可在当前校验模式下保存一次校验结果作为「基线快照」，
// 之后编辑区域 / 连接 / 演员 / 口令时，将当前校验结果与基线按稳定区段键
// （演员 ID + 相邻口令 ID）逐项对比，而不是按数组下标对齐——
// 新增 / 删除 / 重排口令不会造成区段错配。

const STATUS_RANK = { ok: 0, fail: 1, unreachable: 2 };

/** 区段稳定键：演员 ID + 相邻两条口令 ID */
function segmentKey(actorId, seg) {
  return `${actorId}#${seg.fromCueId}>${seg.toCueId}`;
}

/** 区段迟到秒数：两种模式统一取 max(0, 实际到达 - 终点口令计划时刻)；不可达为 null */
function latenessOf(seg) {
  if (!seg || seg.status === 'unreachable' || seg.arrivalTime === null || seg.arrivalTime === undefined) {
    return null;
  }
  return Math.max(0, seg.arrivalTime - seg.to.time);
}

/** 实际路线按无向边 ID 序列表示（空数组表示起点即终点） */
function routeEdges(seg) {
  return (seg && seg.legs ? seg.legs : []).map((l) => l.edgeId);
}

/** 区段关联的通道冲突：按 连接ID#起#止 去重，用于冲突新增 / 解除对比 */
function conflictIndex(seg) {
  const idx = new Map();
  for (const c of (seg && seg.conflicts) || []) {
    idx.set(`${c.edgeId}#${c.startTime}#${c.endTime}`, c);
  }
  return idx;
}

/** 把一次完整校验结果索引为 actorName / segment 映射，并取出汇总 */
function indexResult(result) {
  const actorNames = new Map();
  const segments = new Map();
  for (const ar of result.actors || []) {
    actorNames.set(ar.actorId, ar.actorName);
    for (const seg of ar.segments || []) {
      segments.set(segmentKey(ar.actorId, seg), {
        actorId: ar.actorId,
        actorName: ar.actorName,
        seg,
      });
    }
  }
  return { actorNames, segments, summary: result.summary || null };
}

/** 新增 / 移除区段的展示描述 */
function describeEntry(entry) {
  const { actorName, seg } = entry;
  return {
    actorName,
    index: seg.index,
    fromTime: seg.from.time,
    toTime: seg.to.time,
    fromArea: seg.from.areaName,
    toArea: seg.to.areaName,
    status: seg.status,
    arrivalTime: seg.arrivalTime,
    lateness: latenessOf(seg),
    path: Array.isArray(seg.path) ? seg.path : [],
  };
}

/** 按 演员名 → 区段起点时刻 排序（供展示） */
function sortEntries(entries) {
  return entries.slice().sort(
    (x, y) =>
      String(x.actorName).localeCompare(String(y.actorName), 'zh') ||
      x.fromTime - y.fromTime ||
      x.toTime - y.toTime
  );
}

/**
 * 对比当前校验结果与基线快照。
 * @param {object} current validate() 的当前结果
 * @param {object} baselineResult 基线保存时的 validate() 结果
 * @returns {object} 对比摘要（新增 / 移除 / 共有区段变化与汇总）
 */
function buildComparison(current, baselineResult) {
  const base = indexResult(baselineResult);
  const cur = indexResult(current);

  const added = [];
  const removed = [];
  const shared = [];

  let statusImproved = 0;
  let statusWorsened = 0;
  let latenessImproved = 0; // 迟到秒数减少（含由迟到变准时）
  let latenessWorsened = 0; // 迟到秒数增加（含由准时变迟到）
  let conflictAddedCount = 0; // 冲突新增：共有区段上新出现的关联冲突条数
  let conflictResolvedCount = 0; // 冲突解除：共有区段上不再存在的关联冲突条数
  let conflictAddedSegs = 0;
  let conflictResolvedSegs = 0;
  let changed = 0;
  let unchanged = 0;

  for (const [key, c] of cur.segments) {
    if (!base.segments.has(key)) added.push(describeEntry(c));
  }
  for (const [key, b] of base.segments) {
    if (!cur.segments.has(key)) removed.push(describeEntry(b));
  }

  for (const [key, c] of cur.segments) {
    const b = base.segments.get(key);
    if (!b) continue;

    const cs = c.seg;
    const bs = b.seg;

    const baseStatus = bs.status;
    const curStatus = cs.status;
    const statusDir =
      STATUS_RANK[curStatus] < STATUS_RANK[baseStatus]
        ? 'improved'
        : STATUS_RANK[curStatus] > STATUS_RANK[baseStatus]
          ? 'worsened'
          : 'same';
    if (statusDir === 'improved') statusImproved++;
    if (statusDir === 'worsened') statusWorsened++;

    // 实际到达
    const arrivalDelta =
      cs.arrivalTime === null || bs.arrivalTime === null
        ? null
        : cs.arrivalTime - bs.arrivalTime; // 负数表示到达更早

    // 迟到秒数（按当前计划时刻口径比较）
    const baseLateness = latenessOf(bs);
    const curLateness = latenessOf(cs);
    let latenessDelta = null;
    if (baseLateness !== null && curLateness !== null) {
      latenessDelta = curLateness - baseLateness; // 负数表示迟到减少
      if (latenessDelta < 0) latenessImproved++;
      else if (latenessDelta > 0) latenessWorsened++;
    }

    // 路线（边 ID 序列）
    const baseEdges = routeEdges(bs);
    const curEdges = routeEdges(cs);
    const routeChanged =
      baseEdges.length !== curEdges.length || baseEdges.some((id, i) => id !== curEdges[i]);

    // 关联通道冲突（按 连接 + 超载时段 匹配，而非按冲突序号）
    const baseConflicts = conflictIndex(bs);
    const curConflicts = conflictIndex(cs);
    const conflictsAdded = [];
    const conflictsResolved = [];
    for (const [ck, conf] of curConflicts) {
      if (!baseConflicts.has(ck)) conflictsAdded.push(conf);
    }
    for (const [ck, conf] of baseConflicts) {
      if (!curConflicts.has(ck)) conflictsResolved.push(conf);
    }
    conflictAddedCount += conflictsAdded.length;
    conflictResolvedCount += conflictsResolved.length;
    if (conflictsAdded.length > 0) conflictAddedSegs++;
    if (conflictsResolved.length > 0) conflictResolvedSegs++;

    const isChanged =
      statusDir !== 'same' ||
      (arrivalDelta !== null && arrivalDelta !== 0) ||
      (latenessDelta !== null && latenessDelta !== 0) ||
      routeChanged ||
      conflictsAdded.length > 0 ||
      conflictsResolved.length > 0;

    if (isChanged) changed++;
    else unchanged++;

    const entry = {
      actorName: c.actorName,
      actorId: c.actorId,
      index: cs.index,
      fromTime: cs.from.time,
      toTime: cs.to.time,
      fromArea: cs.from.areaName,
      toArea: cs.to.areaName,
      statusChanged: statusDir !== 'same',
      statusDirection: statusDir,
      baseStatus,
      currentStatus: curStatus,
      arrivalChanged: arrivalDelta !== null && arrivalDelta !== 0,
      arrivalDelta, // 当前实际到达 - 基线实际到达（null 表示任一侧不可达）
      baseArrivalTime: bs.arrivalTime,
      currentArrivalTime: cs.arrivalTime,
      latenessChanged: latenessDelta !== null && latenessDelta !== 0,
      latenessDelta, // 当前迟到 - 基线迟到（null 表示任一侧不可达）
      baseLateness,
      currentLateness: curLateness,
      routeChanged,
      basePath: Array.isArray(bs.path) ? bs.path : [],
      currentPath: Array.isArray(cs.path) ? cs.path : [],
      conflictsAdded: conflictsAdded.map((x) => ({
        edgeId: x.edgeId,
        edgeName: x.edgeName,
        startTime: x.startTime,
        endTime: x.endTime,
        capacity: x.capacity,
        peak: x.peak,
      })),
      conflictsResolved: conflictsResolved.map((x) => ({
        edgeId: x.edgeId,
        edgeName: x.edgeName,
        startTime: x.startTime,
        endTime: x.endTime,
        capacity: x.capacity,
        peak: x.peak,
      })),
    };
    if (isChanged) shared.push(entry);
  }

  return {
    added: sortEntries(added),
    removed: sortEntries(removed),
    shared: sortEntries(shared),
    unchanged,
    summary: {
      segmentsAdded: added.length,
      segmentsRemoved: removed.length,
      segmentsShared: cur.segments.size - added.length,
      segmentsChanged: changed,
      segmentsUnchanged: unchanged,
      statusImproved,
      statusWorsened,
      latenessImproved,
      latenessWorsened,
      conflictsAdded: conflictAddedCount,
      conflictsResolved: conflictResolvedCount,
      conflictAddedSegments: conflictAddedSegs,
      conflictResolvedSegments: conflictResolvedSegs,
    },
    baselineSummary: base.summary,
    currentSummary: cur.summary,
  };
}

module.exports = { buildComparison, segmentKey, latenessOf };
