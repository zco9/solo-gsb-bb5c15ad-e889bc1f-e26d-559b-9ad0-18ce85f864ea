function fmtTime(sec) {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const STATUS_TEXT = {
  ok: '✅ 可达',
  fail: '❌ 无法按时抵达',
  unreachable: '⛔ 区域不可达',
};

/** 将单个区段的实际路线渲染为带时刻与等待信息的行进链 */
function renderLegChain(seg) {
  let chain = `${fmtTime(seg.actualDepart !== undefined ? seg.actualDepart : seg.from.time)}「${seg.from.areaName}」`;
  for (const leg of seg.legs) {
    if (leg.waitSeconds > 0) chain += ` ⏱等待 ${leg.waitSeconds} 秒`;
    chain += ` —${leg.travelSeconds} 秒→ ${fmtTime(leg.arriveTime)}「${leg.toName}」`;
  }
  return chain;
}

/** 区段独立校验模式下的演员区段表 */
function renderClassicTable(lines, actor) {
  lines.push('| # | 起点 | 终点 | 可用时间 | 所需时间 | 最早到达 | 结论 | 实际路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const seg of actor.segments) {
    const from = `${seg.from.areaName}（${fmtTime(seg.from.time)}）`;
    const to = `${seg.to.areaName}（${fmtTime(seg.to.time)}）`;
    const available = `${seg.availableSeconds} 秒`;
    const required = seg.requiredSeconds === null ? '—' : `${seg.requiredSeconds} 秒`;
    const arrival = seg.arrivalTime === null ? '—' : fmtTime(seg.arrivalTime);
    let verdict = STATUS_TEXT[seg.status];
    if (seg.status === 'ok') verdict += `（余 ${seg.slackSeconds} 秒）`;
    if (seg.status === 'fail') verdict += `（缺 ${-seg.slackSeconds} 秒）`;
    verdict += segmentConflictBadge(seg);
    const route = seg.path.length > 0 ? seg.path.join(' → ') : '—';
    lines.push(`| ${seg.index} | ${from} | ${to} | ${available} | ${required} | ${arrival} | ${verdict} | ${route} |`);
  }
}

/** 连续口令延误传导模式下的演员区段表（含计划/实际出发、继承延误、最终迟到） */
function renderPropagateTable(lines, actor) {
  lines.push('| # | 起点 | 终点 | 计划出发 | 实际出发 | 实际到达 | 继承延误 | 最终迟到 | 结论 | 实际路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const seg of actor.segments) {
    const dwellText = seg.from.dwell > 0 ? `，停留 ${seg.from.dwell} 秒` : '';
    const from = `${seg.from.areaName}（${fmtTime(seg.from.time)}${dwellText}）`;
    const to = `${seg.to.areaName}（${fmtTime(seg.to.time)}）`;
    const planned = fmtTime(seg.plannedDepart);
    const depart = fmtTime(seg.actualDepart);
    const arrival = seg.arrivalTime === null ? '—' : fmtTime(seg.arrivalTime);
    const inherited = seg.inheritedDelay > 0 ? `+${seg.inheritedDelay} 秒` : '—';
    const late = seg.lateness === null ? '—' : seg.lateness > 0 ? `迟到 ${seg.lateness} 秒` : '准时';
    let verdict = STATUS_TEXT[seg.status];
    if (seg.status === 'ok') verdict += `（余 ${seg.slackSeconds} 秒）`;
    if (seg.status === 'fail') verdict += `（缺 ${-seg.slackSeconds} 秒）`;
    verdict += segmentConflictBadge(seg);
    const route = seg.path.length > 0 ? seg.path.join(' → ') : '—';
    lines.push(`| ${seg.index} | ${from} | ${to} | ${planned} | ${depart} | ${arrival} | ${inherited} | ${late} | ${verdict} | ${route} |`);
  }
}

/** 传导明细：逐段用文字说明延误如何产生、传导与被吸收 */
function renderPropagationDetails(lines, actor) {
  lines.push('**延误传导明细：**');
  lines.push('');
  for (const seg of actor.segments) {
    if (seg.status === 'unreachable') {
      lines.push(
        `- 区段 ${seg.index}：⛔ 「${seg.from.areaName}」→「${seg.to.areaName}」在连接图上不连通，` +
          `实际到达未知，后续区段自 ${fmtTime(seg.to.time)}（计划时刻）重新起算`
      );
      continue;
    }
    let text = `- 区段 ${seg.index}：${fmtTime(seg.actualDepart)} 自「${seg.from.areaName}」出发`;
    const departNotes = [];
    departNotes.push(`计划 ${fmtTime(seg.plannedDepart)}`);
    if (seg.from.dwell > 0) departNotes.push(`含停留 ${seg.from.dwell} 秒`);
    if (seg.inheritedDelay > 0) departNotes.push(`继承上段延误 ${seg.inheritedDelay} 秒`);
    text += `（${departNotes.join('，')}）`;
    text += `，${fmtTime(seg.arrivalTime)} 抵达「${seg.to.areaName}」`;
    if (seg.lateness > 0) {
      text += `，迟到 ${seg.lateness} 秒 → 传导至后续区段`;
    } else if (seg.inheritedDelay > 0) {
      text += `，间隔充足，吸收 ${seg.inheritedDelay} 秒延误，恢复准时`;
    } else {
      text += '，准时';
    }
    lines.push(text);
  }
  lines.push('');
}

/** 通道占用冲突：汇总表 + 每条冲突的明细（连接、时刻、峰值、参与占用） */
function renderConflictSummary(lines, result) {
  const conflicts = result.conflicts || [];
  lines.push('## 通道占用冲突汇总');
  lines.push('');
  if (conflicts.length === 0) {
    lines.push('所有连接各时刻并发占用人数均未超过容量，无通道占用冲突。');
    lines.push('');
    return;
  }
  lines.push(`共发现 **${conflicts.length}** 段连续超载区间（占用按 [进入, 离开) 计，首尾相接不重叠，等待不占用通道）：`);
  lines.push('');
  lines.push('| # | 通道（无向连接） | 容量 | 起 | 止 | 持续 | 峰值人数 | 涉及演员 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  conflicts.forEach((c, idx) => {
    const actors = [...new Set(c.occupancies.map((o) => o.actorName))].join('、');
    lines.push(
      `| ${idx + 1} | ${c.edgeName} | ${c.capacity} | ${fmtTime(c.startTime)} | ${fmtTime(c.endTime)} | ${c.durationSeconds} 秒 | ${c.peak} | ${actors} |`
    );
  });
  lines.push('');
  lines.push('### 冲突明细');
  lines.push('');
  conflicts.forEach((c, idx) => {
    lines.push(
      `**冲突 ${idx + 1}：${c.edgeName}**　${fmtTime(c.startTime)} ~ ${fmtTime(c.endTime)}` +
        `（持续 ${c.durationSeconds} 秒，容量 ${c.capacity}，峰值 ${c.peak} 人）`
    );
    lines.push('');
    lines.push('| 演员 | 方向 | 进入 | 离开 | 关联区段 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const o of c.occupancies) {
      lines.push(
        `| ${o.actorName} | ${o.direction} | ${fmtTime(o.enter)} | ${fmtTime(o.leave)} | 区段 ${o.segmentIndex} |`
      );
    }
    lines.push('');
  });
}

/** 区段关联冲突的简短标记（纯文本，附加在结论后） */
function segmentConflictBadge(seg) {
  if (!seg.conflicts || seg.conflicts.length === 0) return '';
  const peak = Math.max(...seg.conflicts.map((c) => c.peak));
  return ` 🚶通道冲突×${seg.conflicts.length}（峰值${peak}人）`;
}

/* ---------- 跨演员口令依赖 ---------- */

const DEPENDENCY_STATUS_TEXT = {
  satisfied: '✅ 满足',
  violated: '❌ 违约',
  unknown: '❓ 无法判定',
};

/** 口令位置的纯文本描述：演员 时刻 区域（说明） */
function dependencyCueText(cue) {
  if (!cue || cue.cueId === undefined) return '（已删除口令）';
  const note = cue.note ? `，${cue.note}` : '';
  const crossActor = cue.actorName ? `${cue.actorName} ` : '';
  return `${crossActor}${fmtTime(cue.time)}「${cue.areaName}」${note}`;
}

/** 跨演员口令依赖汇总与明细（前置完成 + 等待 N ≤ 后置实际出发） */
function renderDependencies(lines, result) {
  const dep = result.dependencies;
  lines.push('## 跨演员口令依赖');
  lines.push('');
  if (!dep || dep.items.length === 0) {
    lines.push('未维护跨演员口令依赖。');
    lines.push('');
    return;
  }
  const s = dep.summary;
  lines.push(
    `共 **${s.total}** 条依赖：✅ 满足 **${s.satisfied}** · ❌ 违约 **${s.violated}** · ❓ 无法判定 **${s.unknown}**。`
  );
  lines.push('');
  lines.push(
    '判定口径：前置口令完成时刻 = 其在当前模式下的实际到达时刻 + 停留时长；后置口令的实际出发时刻取前往该口令区段的实际出发时刻；满足「完成 + 至少等待 N 秒 ≤ 后置实际出发」即为满足，相差秒数为后置实际出发相对最早允许时刻的余量（违约时为负的缺口）。'
  );
  lines.push('');
  lines.push('| # | 前置口令 | 等待 | 后置口令 | 前置完成 | 后置实际出发 | 相差 | 结论 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  dep.items.forEach((d, idx) => {
    const before = dependencyCueText(d.predecessor);
    const after = dependencyCueText(d.successor);
    const wait = `≥ ${d.waitSeconds} 秒`;
    const completion = d.completionTime === null ? '—' : `${fmtTime(d.completionTime)}（到达 ${fmtTime(d.completionTime - d.predecessor.dwell)} + 停留 ${d.predecessor.dwell} 秒）`;
    const depart = d.successorDepart === null ? '—' : fmtTime(d.successorDepart);
    let diff = '—';
    if (d.status === 'satisfied') diff = `余 ${d.delta} 秒`;
    else if (d.status === 'violated') diff = `缺 ${-d.delta} 秒`;
    let verdict = DEPENDENCY_STATUS_TEXT[d.status];
    if (d.status === 'unknown') verdict += `（${d.reason}）`;
    lines.push(
      `| ${idx + 1} | ${before} | ${wait} | ${after} | ${completion} | ${depart} | ${diff} | ${verdict} |`
    );
  });
  lines.push('');
}

/* ---------- 基线对比摘要 ---------- */

function statusPlain(status) {
  return STATUS_TEXT[status] || status;
}

function arrivalPlain(arrivalTime) {
  return arrivalTime === null || arrivalTime === undefined ? '—' : fmtTime(arrivalTime);
}

function latenessPlain(lateness) {
  if (lateness === null || lateness === undefined) return '—';
  return lateness > 0 ? `迟到 ${lateness} 秒` : '准时（0 秒）';
}

function routePlain(pathArr) {
  return Array.isArray(pathArr) && pathArr.length > 0 ? pathArr.join(' → ') : '—';
}

function conflictLine(list) {
  return list
    .map((c) => `${c.edgeName} ${fmtTime(c.startTime)}~${fmtTime(c.endTime)}（峰值 ${c.peak}/${c.capacity} 人）`)
    .join('；');
}

/** 新增 / 移除区段表 */
function renderSegmentDeltaTable(lines, title, entries) {
  lines.push(`### ${title}（${entries.length}）`);
  lines.push('');
  if (entries.length === 0) {
    lines.push('无。');
    lines.push('');
    return;
  }
  lines.push('| 演员 | 区段 | 起点 | 终点 | 状态 | 实际到达 | 迟到 | 实际路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const e of entries) {
    lines.push(
      `| ${e.actorName} | ${e.index} | ${e.fromArea}（${fmtTime(e.fromTime)}） | ${e.toArea}（${fmtTime(e.toTime)}） | ` +
        `${statusPlain(e.status)} | ${arrivalPlain(e.arrivalTime)} | ${latenessPlain(e.lateness)} | ${routePlain(e.path)} |`
    );
  }
  lines.push('');
}

/** 基线对比摘要：按稳定区段键（演员 ID + 相邻口令 ID）对比，附状态 / 迟到 / 路线 / 冲突变化 */
function renderBaselineComparison(lines, result) {
  const cmp = result.comparison;
  if (!result.baseline || !cmp) return;

  const s = cmp.summary;
  const modeText = result.mode === 'propagate' ? '连续口令延误传导' : '区段独立校验';

  lines.push('## 走位方案基线对比摘要');
  lines.push('');
  lines.push(`- 基线保存时间：${new Date(result.baseline.savedAt).toLocaleString('zh-CN', { hour12: false })}（${modeText} 模式）`);
  lines.push(`- 当前结果生成时间：${new Date(result.generatedAt).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`- 区段键：演员 ID + 相邻口令 ID（稳定匹配，不按数组位置对齐）`);
  lines.push(
    `- 区段：**新增 ${s.segmentsAdded}** · **移除 ${s.segmentsRemoved}** · 共有 ${s.segmentsShared}（有变化 ${s.segmentsChanged} / 无变化 ${s.segmentsUnchanged}）`
  );
  lines.push('');

  const hasAny =
    s.segmentsAdded > 0 ||
    s.segmentsRemoved > 0 ||
    s.statusImproved > 0 ||
    s.statusWorsened > 0 ||
    s.latenessImproved > 0 ||
    s.latenessWorsened > 0 ||
    s.conflictsAdded > 0 ||
    s.conflictsResolved > 0 ||
    cmp.shared.length > 0;
  if (!hasAny) {
    lines.push('当前结果与基线完全一致，无差异。');
    lines.push('');
    return;
  }

  lines.push('### 总体变化');
  lines.push('');
  lines.push('| 指标 | 变化 |');
  lines.push('| --- | --- |');
  lines.push(`| 状态转好 | ${s.statusImproved} 个共有区段 |`);
  lines.push(`| 状态转差 | ${s.statusWorsened} 个共有区段 |`);
  lines.push(`| 迟到减少 | ${s.latenessImproved} 个共有区段 |`);
  lines.push(`| 迟到增加 | ${s.latenessWorsened} 个共有区段 |`);
  lines.push(`| 通道冲突新增 | ${s.conflictsAdded} 处（涉及 ${s.conflictAddedSegments} 个区段） |`);
  lines.push(`| 通道冲突解除 | ${s.conflictsResolved} 处（涉及 ${s.conflictResolvedSegments} 个区段） |`);
  lines.push('');

  if (cmp.baselineSummary && cmp.currentSummary) {
    lines.push('### 汇总计数对比');
    lines.push('');
    lines.push('| 指标 | 基线 | 当前 |');
    lines.push('| --- | --- | --- |');
    lines.push(`| 校验区段数 | ${cmp.baselineSummary.segments} | ${cmp.currentSummary.segments} |`);
    lines.push(`| ✅ 按时可达 | ${cmp.baselineSummary.ok} | ${cmp.currentSummary.ok} |`);
    lines.push(`| ❌ 无法按时抵达 | ${cmp.baselineSummary.failed} | ${cmp.currentSummary.failed} |`);
    lines.push(`| ⛔ 区域不可达 | ${cmp.baselineSummary.unreachable} | ${cmp.currentSummary.unreachable} |`);
    lines.push(`| 🚶 通道占用冲突 | ${cmp.baselineSummary.conflicts || 0} | ${cmp.currentSummary.conflicts || 0} |`);
    lines.push('');
  }

  renderSegmentDeltaTable(lines, '新增区段（基线中不存在）', cmp.added);
  renderSegmentDeltaTable(lines, '移除区段（当前不存在）', cmp.removed);

  lines.push(`### 共有区段变化明细（${cmp.shared.length}）`);
  lines.push('');
  if (cmp.shared.length === 0) {
    lines.push('共有区段均无变化。');
    lines.push('');
    return;
  }
  lines.push('| 演员 | 区段 | 状态（基线 → 当前） | 实际到达（基线 → 当前） | 迟到（基线 → 当前） | 路线变化 | 通道冲突新增 / 解除 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const e of cmp.shared) {
    const segText = `${e.fromArea}（${fmtTime(e.fromTime)}）→ ${e.toArea}（${fmtTime(e.toTime)}）`;

    let statusCell = `${statusPlain(e.baseStatus)} → ${statusPlain(e.currentStatus)}`;
    if (e.statusDirection === 'improved') statusCell += ' ⬆ 转好';
    else if (e.statusDirection === 'worsened') statusCell += ' ⬇ 转差';

    let arrivalCell = `${arrivalPlain(e.baseArrivalTime)} → ${arrivalPlain(e.currentArrivalTime)}`;
    if (e.arrivalChanged) {
      arrivalCell += e.arrivalDelta < 0 ? `（早 ${-e.arrivalDelta} 秒）` : `（晚 ${e.arrivalDelta} 秒）`;
    }

    let lateCell = `${latenessPlain(e.baseLateness)} → ${latenessPlain(e.currentLateness)}`;
    if (e.latenessChanged) {
      lateCell += e.latenessDelta < 0 ? `（减少 ${-e.latenessDelta} 秒）` : `（增加 ${e.latenessDelta} 秒）`;
    }

    let routeCell = '无变化';
    if (e.routeChanged) {
      routeCell = `基线：${routePlain(e.basePath)}；当前：${routePlain(e.currentPath)}`;
    }

    const confParts = [];
    if (e.conflictsAdded.length > 0) confParts.push(`🆕 ${conflictLine(e.conflictsAdded)}`);
    if (e.conflictsResolved.length > 0) confParts.push(`✅ 解除：${conflictLine(e.conflictsResolved)}`);
    const confCell = confParts.length > 0 ? confParts.join('；') : '—';

    lines.push(
      `| ${e.actorName} | ${e.index} ${segText} | ${statusCell} | ${arrivalCell} | ${lateCell} | ${routeCell} | ${confCell} |`
    );
  }
  lines.push('');
}

/* ---------- 应急疏散快照 ---------- */

/** 事件时刻位置的纯文本描述 */
function evacPositionText(position) {
  if (position.kind === 'corridor') {
    return (
      `通道行进中：「${position.fromName}」→「${position.toName}」` +
      `（剩余 ${position.remainingSeconds} 秒，${fmtTime(position.arriveTime)} 抵达「${position.toName}」）`
    );
  }
  return `${position.state}：「${position.areaName}」（${position.reasonText}）`;
}

/** 疏散路线的纯文本描述（通道行进者含剩余路程说明） */
function evacRouteText(entry) {
  const ev = entry.evacuation;
  const parts = [];
  if (entry.position.kind === 'corridor') {
    parts.push(
      `先按原方向走完剩余 ${entry.position.remainingSeconds} 秒，` +
        `${fmtTime(entry.position.arriveTime)} 抵达「${entry.position.toName}」`
    );
  }
  if (ev.legs.length === 0) {
    parts.push(`已位于出口区域「${ev.exitName}」，无需移动`);
  } else {
    let chain = `${fmtTime(ev.startTime)}「${ev.path[0]}」`;
    for (const leg of ev.legs) {
      if (leg.waitSeconds > 0) chain += ` ⏱等待 ${leg.waitSeconds} 秒`;
      chain += ` —${leg.travelSeconds} 秒→ ${fmtTime(leg.arriveTime)}「${leg.toName}」`;
    }
    parts.push(chain);
  }
  return parts.join('；');
}

/** 应急疏散快照：与页面一致的快照表（最晚撤离优先）+ 位置未知单列 */
function renderEvacuation(lines, evacuation) {
  const s = evacuation.summary;
  const modeText = evacuation.mode === 'propagate' ? '连续口令延误传导' : '区段独立校验';

  lines.push('## 应急疏散快照');
  lines.push('');
  lines.push(`- 事件时刻：${fmtTime(evacuation.eventTime)}（第 ${evacuation.eventTime} 秒）`);
  lines.push(`- 校验模式：${modeText}（按该模式实际路线还原位置）`);
  lines.push(`- 出口区域：${evacuation.exits.map((e) => e.name).join('、')}`);
  lines.push(`- 快照生成时间：${new Date(evacuation.generatedAt).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(
    `- 位置已知 ${s.known} 人（其中无法疏散 ${s.unreachable} 人）、位置未知 ${s.unknown} 人；` +
      (s.latestArrival === null ? '暂无可用的疏散路线。' : `最晚撤离到达时刻 ${fmtTime(s.latestArrival)}。`)
  );
  lines.push('');
  lines.push('按最晚撤离优先排序（无法疏散视为最晚；位置未知者单列于文末，不猜测其位置）：');
  lines.push('');
  lines.push('| 演员 | 事件时刻位置 | 出口 | 到达时刻 | 耗时 | 疏散路线 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  if (evacuation.entries.length === 0) {
    lines.push('| — | — | — | — | — | — |');
  }
  for (const e of evacuation.entries) {
    const pos = evacPositionText(e.position);
    if (e.status === 'unreachable') {
      lines.push(`| ${e.actorName} | ${pos} | — | — | — | ⛔ 无可达出口的路线 |`);
    } else {
      const ev = e.evacuation;
      lines.push(
        `| ${e.actorName} | ${pos} | ${ev.exitName} | ${fmtTime(ev.arrivalTime)} | ${ev.durationSeconds} 秒 | ${evacRouteText(e)} |`
      );
    }
  }
  lines.push('');

  if (evacuation.unknown.length > 0) {
    lines.push(`### 位置未知（${evacuation.unknown.length}）`);
    lines.push('');
    lines.push('| 演员 | 原因 |');
    lines.push('| --- | --- |');
    for (const u of evacuation.unknown) {
      lines.push(`| ${u.actorName} | ${u.reasonText} |`);
    }
    lines.push('');
  }
}

/** 将校验结果渲染为 Markdown 报告（可选追加应急疏散快照） */
function toMarkdown(result, evacuation) {
  const propagate = result.mode === 'propagate';
  const lines = [];
  const s = result.summary;

  lines.push('# 舞台走位校验报告');
  lines.push('');
  lines.push(`生成时间：${new Date(result.generatedAt).toLocaleString('zh-CN', { hour12: false })}`);
  lines.push(`校验模式：${propagate ? '连续口令延误传导' : '区段独立校验'}`);
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| 演员数 | ${s.actors} |`);
  lines.push(`| 校验区段数 | ${s.segments} |`);
  lines.push(`| ✅ 按时可达 | ${s.ok} |`);
  lines.push(`| ❌ 无法按时抵达 | ${s.failed} |`);
  lines.push(`| ⛔ 区域不可达 | ${s.unreachable} |`);
  lines.push(`| 🚶 通道占用冲突 | ${s.conflicts || 0} |`);
  lines.push(`| 🔗 口令依赖（满足 / 违约 / 无法判定） | ${s.dependencies || 0}（${s.dependenciesSatisfied || 0} / ${s.dependenciesViolated || 0} / ${s.dependenciesUnknown || 0}） |`);
  lines.push('');

  renderBaselineComparison(lines, result);

  renderConflictSummary(lines, result);

  renderDependencies(lines, result);

  for (const actor of result.actors) {
    lines.push(`## ${actor.actorName}`);
    lines.push('');
    if (actor.segments.length === 0) {
      lines.push(`（口令数 ${actor.cueCount}，不足两条，无需校验区段）`);
      lines.push('');
      continue;
    }
    if (propagate) {
      const finalText =
        actor.finalLateness > 0 ? `末条口令最终迟到 ${actor.finalLateness} 秒` : '末条口令准时（延误已全部吸收）';
      lines.push(`传导链末端状态：${finalText}`);
      lines.push('');
      renderPropagateTable(lines, actor);
    } else {
      renderClassicTable(lines, actor);
    }
    lines.push('');

    if (propagate) renderPropagationDetails(lines, actor);

    // 动态路线明细：逐边列出出发 / 到达时刻与等待位置、时长
    if (actor.segments.some((seg) => seg.legs && seg.legs.length > 0)) {
      lines.push('**路线明细（含封闭时段等待推演）：**');
      lines.push('');
      for (const seg of actor.segments) {
        if (seg.status === 'unreachable') {
          lines.push(`- 区段 ${seg.index}：⛔ 两区域在连接图上不连通，无可用路线`);
        } else if (!seg.legs || seg.legs.length === 0) {
          lines.push(`- 区段 ${seg.index}：起点即终点（${seg.from.areaName}），无需移动`);
        } else {
          lines.push(`- 区段 ${seg.index}：${renderLegChain(seg)}；最早到达 ${fmtTime(seg.arrivalTime)}`);
        }
        if (seg.conflicts && seg.conflicts.length > 0) {
          for (const c of seg.conflicts) {
            lines.push(
              `  - 🚶 关联通道冲突（${c.edgeName}）：${fmtTime(c.startTime)} ~ ${fmtTime(c.endTime)}，` +
                `容量 ${c.capacity}，峰值 ${c.peak} 人`
            );
          }
        }
      }
      lines.push('');
    }
  }

  // 应急疏散快照（页面已生成快照时追加同一快照）
  if (evacuation) renderEvacuation(lines, evacuation);

  return lines.join('\n');
}

module.exports = { toMarkdown, fmtTime };
