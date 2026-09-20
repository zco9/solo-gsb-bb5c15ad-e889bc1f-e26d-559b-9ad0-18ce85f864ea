/* 舞台走位校验系统 —— 前端逻辑（原生 JS） */

const MODE_LABEL = {
  propagate: '连续口令延误传导：首条口令准时到位，每段实际出发 = max(计划时刻, 实际到达) + 停留时长；迟到逐段传导，间隔充足时可吸收恢复。',
  classic: '区段独立校验：每段从上一口令计划时刻出发，段与段互不影响（停留时长不参与本模式）。',
};

const MODE_NAME = { propagate: '连续口令延误传导', classic: '区段独立校验' };

const state = {
  data: { areas: [], edges: [], actors: [], cues: [], dependencies: [] },
  validation: null,
  mode: localStorage.getItem('validate-mode') === 'classic' ? 'classic' : 'propagate',
  evacuation: null, // 已生成快照的参数 { time, exits: [areaId] }；null 表示未启用
  evacResult: null, // 最近一次应急疏散快照结果
};

/* ---------- 工具 ---------- */

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtTime(sec) {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 解析 "90" 或 "01:30" 形式的时间输入，返回秒数；非法返回 NaN */
function parseTime(str) {
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return NaN;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `请求失败（${res.status}）`);
  }
  return res.status === 204 ? null : res.json();
}

function areaName(id) {
  const a = state.data.areas.find((x) => x.id === id);
  return a ? a.name : '（已删除）';
}

function actorName(id) {
  const a = state.data.actors.find((x) => x.id === id);
  return a ? a.name : '（已删除）';
}

/* ---------- 数据加载与渲染 ---------- */

async function refresh() {
  const [data, validation] = await Promise.all([api('/api/data'), api(`/api/validate?mode=${state.mode}`)]);
  state.data = data;
  state.validation = validation;
  renderAreas();
  renderEdges();
  renderActors();
  renderCues();
  renderDependencies();
  renderValidation();
  renderEvacExitOptions();
  await refreshEvacuation();
}

/** 仅重新校验并刷新结果区（模式切换时使用） */
async function refreshValidation() {
  state.validation = await api(`/api/validate?mode=${state.mode}`);
  renderValidation();
  renderDependencies();
}

/** 更新「导出校验报告」链接：已生成疏散快照时携带同一快照参数，报告将追加同一快照 */
function updateExportHref() {
  let href = `/api/report?mode=${state.mode}`;
  if (state.evacuation) {
    href += `&time=${state.evacuation.time}&exits=${state.evacuation.exits.map(encodeURIComponent).join(',')}`;
  }
  $('btn-export').href = href;
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('validate-mode', mode);
  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  $('mode-hint').textContent = MODE_LABEL[mode];
  updateExportHref();
}

function renderAreas() {
  const tbody = $('areas-tbody');
  tbody.innerHTML = state.data.areas
    .map(
      (a) => `<tr>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.description || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-area="${a.id}">编辑</button>
          <button class="btn btn-danger" data-del-area="${a.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="3" class="empty-hint">暂无区域</td></tr>';
}

function renderEdges() {
  const tbody = $('edges-tbody');
  tbody.innerHTML = state.data.edges
    .map((e) => {
      const closures = Array.isArray(e.closures) ? e.closures : [];
      const closuresText = closures.length
        ? closures.map((c) => `${c.start}~${c.end} 秒`).join('、')
        : '<span class="empty-hint">无</span>';
      const capacity = Number.isInteger(e.capacity) && e.capacity >= 1 ? e.capacity : 1;
      return `<tr>
        <td>${escapeHtml(areaName(e.a))}</td>
        <td>${escapeHtml(areaName(e.b))}</td>
        <td>${e.seconds} 秒</td>
        <td>${capacity} 人</td>
        <td class="closures-cell">${closuresText}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-edge="${e.id}">编辑</button>
          <button class="btn btn-danger" data-del-edge="${e.id}">删除</button>
        </td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="6" class="empty-hint">暂无连接</td></tr>';
}

function renderActors() {
  const tbody = $('actors-tbody');
  tbody.innerHTML = state.data.actors
    .map(
      (a) => `<tr>
        <td>${escapeHtml(a.name)}</td>
        <td>${escapeHtml(a.role || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-actor="${a.id}">编辑</button>
          <button class="btn btn-danger" data-del-actor="${a.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="3" class="empty-hint">暂无演员</td></tr>';
}

function renderCues() {
  const tbody = $('cues-tbody');
  const sorted = state.data.cues
    .slice()
    .sort((x, y) => actorName(x.actorId).localeCompare(actorName(y.actorId), 'zh') || x.time - y.time);
  tbody.innerHTML = sorted
    .map(
      (c) => `<tr>
        <td>${escapeHtml(actorName(c.actorId))}</td>
        <td>${fmtTime(c.time)}</td>
        <td>${escapeHtml(areaName(c.areaId))}</td>
        <td>${c.dwell > 0 ? `${c.dwell} 秒` : '<span class="empty-hint">—</span>'}</td>
        <td>${escapeHtml(c.note || '')}</td>
        <td class="col-ops">
          <button class="btn btn-small" data-edit-cue="${c.id}">编辑</button>
          <button class="btn btn-danger" data-del-cue="${c.id}">删除</button>
        </td>
      </tr>`
    )
    .join('') || '<tr><td colspan="6" class="empty-hint">暂无口令</td></tr>';
}

const STATUS_LABEL = { ok: '✅ 可达', fail: '❌ 超时', unreachable: '⛔ 不可达' };

function renderSummary(s) {
  $('summary').innerHTML = `
    <div class="badge"><span class="num">${s.actors}</span><span class="label">演员</span></div>
    <div class="badge"><span class="num">${s.segments}</span><span class="label">校验区段</span></div>
    <div class="badge ok"><span class="num">${s.ok}</span><span class="label">按时可达</span></div>
    <div class="badge fail"><span class="num">${s.failed}</span><span class="label">无法按时抵达</span></div>
    <div class="badge warn"><span class="num">${s.unreachable}</span><span class="label">区域不可达</span></div>
    <div class="badge conflict"><span class="num">${s.conflicts || 0}</span><span class="label">通道占用冲突</span></div>
    <div class="badge dep"><span class="num">${s.dependencies || 0}</span><span class="label">口令依赖 满足${s.dependenciesSatisfied || 0}/违约${s.dependenciesViolated || 0}/未知${s.dependenciesUnknown || 0}</span></div>
  `;
}

/** 通道占用冲突总览（全局，跨演员） */
function renderConflicts(conflicts) {
  const el = $('conflict-overview');
  if (!conflicts || conflicts.length === 0) {
    el.innerHTML = '<p class="empty-hint">✅ 所有连接各时刻并发占用均未超过容量，无通道占用冲突（首尾相接不算重叠，等待不占用通道）。</p>';
    return;
  }
  const rows = conflicts
    .map((c, idx) => {
      const occs = c.occupancies
        .map(
          (o) =>
            `<li><strong>${escapeHtml(o.actorName)}</strong> ${escapeHtml(o.direction)}：` +
            `${fmtTime(o.enter)} 进入 ~ ${fmtTime(o.leave)} 离开（${escapeHtml(o.actorName)} 区段 ${o.segmentIndex}）</li>`
        )
        .join('');
      return `<div class="conflict-card">
        <div class="conflict-head">
          <span class="conflict-no">冲突 ${idx + 1}</span>
          <span class="conflict-edge">🚶 ${escapeHtml(c.edgeName)}</span>
          <span class="conflict-time">${fmtTime(c.startTime)} ~ ${fmtTime(c.endTime)}（${c.durationSeconds} 秒）</span>
          <span class="conflict-peak">容量 ${c.capacity} / 峰值 ${c.peak} 人</span>
        </div>
        <ul class="conflict-occs">${occs}</ul>
      </div>`;
    })
    .join('');
  el.innerHTML = `<p class="conflict-intro">共发现 <strong>${conflicts.length}</strong> 段连续超载区间（已合并首尾相接的连续超载）：</p>${rows}`;
}

/* ---------- 走位方案基线对比 ---------- */

function fmtSavedAt(iso) {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 区段行内的状态文本（基线对比用） */
function cmpStatusText(status) {
  return STATUS_LABEL[status] || status;
}

function cmpArrivalText(entry, side) {
  const t = side === 'base' ? entry.baseArrivalTime : entry.currentArrivalTime;
  return t === null || t === undefined ? '—' : fmtTime(t);
}

function cmpLatenessText(l) {
  if (l === null || l === undefined) return '—';
  return l > 0 ? `${l} 秒` : '准时';
}

function cmpRouteText(pathArr) {
  return Array.isArray(pathArr) && pathArr.length > 0 ? pathArr.map(escapeHtml).join(' → ') : '—';
}

/** 新增 / 移除区段小条目 */
function renderCmpEntry(e, kind) {
  const late = e.lateness > 0 ? `迟到 ${e.lateness} 秒` : '准时';
  return `<li class="cmp-seg ${kind}">
    <span class="cmp-seg-actor">${escapeHtml(e.actorName)}</span>
    <span class="cmp-seg-route">${escapeHtml(e.fromArea)}（${fmtTime(e.fromTime)}）→ ${escapeHtml(e.toArea)}（${fmtTime(e.toTime)}）</span>
    <span class="status-pill ${e.status}">${cmpStatusText(e.status)}</span>
    <span class="cmp-seg-meta">实际到达 ${e.arrivalTime === null || e.arrivalTime === undefined ? '—' : fmtTime(e.arrivalTime)} · ${e.lateness === null ? '—' : late}</span>
  </li>`;
}

/** 共有区段变化明细行 */
function renderCmpSharedRow(e) {
  const segTitle = `${escapeHtml(e.fromArea)}（${fmtTime(e.fromTime)}）→ ${escapeHtml(e.toArea)}（${fmtTime(e.toTime)}）`;

  let statusCell = `<span class="cmp-from">${cmpStatusText(e.baseStatus)}</span> → <span class="status-pill ${e.currentStatus}">${cmpStatusText(e.currentStatus)}</span>`;
  if (e.statusDirection === 'improved') statusCell += ' <span class="cmp-dir up">⬆ 转好</span>';
  else if (e.statusDirection === 'worsened') statusCell += ' <span class="cmp-dir down">⬇ 转差</span>';

  let arrivalCell = `<span class="cmp-from">${cmpArrivalText(e, 'base')}</span> → <strong>${cmpArrivalText(e, 'cur')}</strong>`;
  if (e.arrivalChanged) {
    arrivalCell += e.arrivalDelta < 0
      ? ` <span class="cmp-delta up">早 ${-e.arrivalDelta} 秒</span>`
      : ` <span class="cmp-delta down">晚 ${e.arrivalDelta} 秒</span>`;
  }

  let lateCell = `<span class="cmp-from">${cmpLatenessText(e.baseLateness)}</span> → <strong>${cmpLatenessText(e.currentLateness)}</strong>`;
  if (e.latenessChanged) {
    lateCell += e.latenessDelta < 0
      ? ` <span class="cmp-delta up">减少 ${-e.latenessDelta} 秒</span>`
      : ` <span class="cmp-delta down">增加 ${e.latenessDelta} 秒</span>`;
  }

  let routeCell = '<span class="empty-hint">无变化</span>';
  if (e.routeChanged) {
    routeCell = `<div class="cmp-route"><span class="cmp-from">${cmpRouteText(e.basePath)}</span> → <strong>${cmpRouteText(e.currentPath)}</strong></div>`;
  }

  const confBits = [];
  for (const c of e.conflictsAdded) {
    confBits.push(`<span class="conflict-tag cmp-conf new">🆕 ${escapeHtml(c.edgeName)} ${fmtTime(c.startTime)}~${fmtTime(c.endTime)}（峰值 ${c.peak}/${c.capacity}）</span>`);
  }
  for (const c of e.conflictsResolved) {
    confBits.push(`<span class="conflict-tag cmp-conf gone">✅ 解除 ${escapeHtml(c.edgeName)} ${fmtTime(c.startTime)}~${fmtTime(c.endTime)}</span>`);
  }
  const conflictCell = confBits.length ? `<span class="conflict-tags">${confBits.join('')}</span>` : '<span class="empty-hint">—</span>';

  return `<tr>
    <td>${escapeHtml(e.actorName)}</td>
    <td>${e.index} · ${segTitle}</td>
    <td>${statusCell}</td>
    <td>${arrivalCell}</td>
    <td>${lateCell}</td>
    <td class="route">${routeCell}</td>
    <td>${conflictCell}</td>
  </tr>`;
}

/** 基线对比面板：保存 / 覆盖 / 清除入口，以及即时对比摘要 */
function renderBaseline(v) {
  const panel = $('baseline-panel');
  const currentMode = v.mode;
  const meta = v.baselines || {};
  const cur = meta[currentMode];
  const otherMode = currentMode === 'propagate' ? 'classic' : 'propagate';
  const other = meta[otherMode];

  // 另一模式存在基线、当前模式没有：模式不一致，当前不比较，仅提示
  let mismatch = '';
  if (!cur && other) {
    mismatch = `<p class="baseline-mismatch">⚠️ 已在「${MODE_NAME[otherMode]}」模式保存过基线（${fmtSavedAt(other.savedAt)}），` +
      `与当前「${MODE_NAME[currentMode]}」模式不一致，不对其比较；` +
      `<button type="button" class="btn-link" data-baseline-clear="${otherMode}">清除该模式基线</button>，或切换回该模式查看对比。</p>`;
  }

  if (!cur) {
    panel.innerHTML = `
      <div class="baseline-bar">
        <span class="baseline-title">📸 走位方案基线</span>
        <span class="baseline-info">当前「${MODE_NAME[currentMode]}」模式尚无基线，保存后编辑区域、连接、演员或口令时将在此即时对比。</span>
        <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">保存当前结果为基线</button>
      </div>${mismatch}`;
    return;
  }

  const cmp = v.comparison;
  if (!cmp) {
    panel.innerHTML = `<div class="baseline-bar">
      <span class="baseline-title">📸 走位方案基线</span>
      <span class="baseline-info">基线保存于 ${fmtSavedAt(cur.savedAt)}</span>
      <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">覆盖基线</button>
      <button type="button" class="btn btn-danger btn-small" data-baseline-clear="${currentMode}">清除基线</button>
    </div>${mismatch}`;
    return;
  }

  const s = cmp.summary;
  const chips = [
    `<span class="cmp-chip add">新增区段 <strong>${s.segmentsAdded}</strong></span>`,
    `<span class="cmp-chip del">移除区段 <strong>${s.segmentsRemoved}</strong></span>`,
    `<span class="cmp-chip">共有 <strong>${s.segmentsShared}</strong></span>`,
    `<span class="cmp-chip ${s.statusImproved ? 'good' : ''}">状态转好 <strong>${s.statusImproved}</strong></span>`,
    `<span class="cmp-chip ${s.statusWorsened ? 'bad' : ''}">状态转差 <strong>${s.statusWorsened}</strong></span>`,
    `<span class="cmp-chip ${s.latenessImproved ? 'good' : ''}">迟到减少 <strong>${s.latenessImproved}</strong></span>`,
    `<span class="cmp-chip ${s.latenessWorsened ? 'bad' : ''}">迟到增加 <strong>${s.latenessWorsened}</strong></span>`,
    `<span class="cmp-chip ${s.conflictsAdded ? 'bad' : ''}">冲突新增 <strong>${s.conflictsAdded}</strong></span>`,
    `<span class="cmp-chip ${s.conflictsResolved ? 'good' : ''}">冲突解除 <strong>${s.conflictsResolved}</strong></span>`,
  ].join('');

  const noDiff =
    s.segmentsAdded === 0 &&
    s.segmentsRemoved === 0 &&
    s.segmentsChanged === 0;

  let body = '';
  if (noDiff) {
    body = '<p class="cmp-identical">✅ 当前结果与基线完全一致（区段键：演员 ID + 相邻口令 ID，按稳定键匹配，不按数组位置对齐）。</p>';
  } else {
    body += '<p class="cmp-keyhint">区段按「演员 ID + 相邻口令 ID」稳定匹配，不按数组位置对齐。</p>';
    if (cmp.added.length) {
      body += `<div class="cmp-group"><h4>🟢 新增区段（${cmp.added.length}）</h4><ul class="cmp-seg-list">${cmp.added.map((e) => renderCmpEntry(e, 'added')).join('')}</ul></div>`;
    }
    if (cmp.removed.length) {
      body += `<div class="cmp-group"><h4>🔴 移除区段（${cmp.removed.length}）</h4><ul class="cmp-seg-list">${cmp.removed.map((e) => renderCmpEntry(e, 'removed')).join('')}</ul></div>`;
    }
    if (cmp.shared.length) {
      const rows = cmp.shared.map(renderCmpSharedRow).join('');
      body += `<div class="cmp-group">
        <h4>🟡 共有区段变化（${cmp.shared.length}）</h4>
        <table class="cmp-table">
          <thead><tr><th>演员</th><th>区段（起点 → 终点）</th><th>状态（基线 → 当前）</th><th>实际到达</th><th>迟到秒数</th><th>路线</th><th>关联通道冲突</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    } else if (s.segmentsShared > 0) {
      body += `<p class="empty-hint">共有 ${s.segmentsShared} 个区段均无变化。</p>`;
    }
  }

  panel.innerHTML = `
    <div class="baseline-bar">
      <span class="baseline-title">📸 走位方案基线</span>
      <span class="baseline-info">基线保存于 ${fmtSavedAt(cur.savedAt)}（${MODE_NAME[currentMode]}）· 报告将追加同样的对比摘要</span>
      <button type="button" class="btn btn-accent btn-small" data-baseline-save="${currentMode}">覆盖基线</button>
      <button type="button" class="btn btn-danger btn-small" data-baseline-clear="${currentMode}">清除基线</button>
    </div>
    ${mismatch}
    <div class="cmp-chips">${chips}</div>
    <div class="cmp-detail">${body}</div>`;
}

function renderValidation() {
  const v = state.validation;
  if (!v) return;
  renderBaseline(v);
  renderSummary(v.summary);
  renderConflicts(v.conflicts);

  const container = $('validation-results');
  if (v.actors.length === 0) {
    container.innerHTML = '<p class="empty-hint">暂无演员，请先添加演员与到位口令。</p>';
    return;
  }

  const propagate = v.mode === 'propagate';
  container.innerHTML = v.actors
    .map((actor) => {
      if (actor.segments.length === 0) {
        return `<div class="actor-block">
          <h3>${escapeHtml(actor.actorName)} <span class="cue-count">（${actor.cueCount} 条口令，不足两条，无需校验）</span></h3>
        </div>`;
      }
      const rows = actor.segments.map((seg) => (propagate ? renderPropagateRow(seg) : renderClassicRow(seg))).join('');
      const chainTag = propagate
        ? actor.finalLateness > 0
          ? `<span class="chain-tag late">末条口令最终迟到 ${actor.finalLateness} 秒</span>`
          : '<span class="chain-tag absorbed">末条口令准时（延误已全部吸收）</span>'
        : '';
      const head = propagate
        ? '<thead><tr><th>#</th><th>起点</th><th>终点</th><th>出发（计划 / 实际）</th><th>实际到达</th><th>继承延误</th><th>最终迟到</th><th>实际路线（含等待）</th><th>结论</th></tr></thead>'
        : '<thead><tr><th>#</th><th>起点</th><th>终点</th><th>耗时校验</th><th>实际路线（含等待）</th><th>结论</th></tr></thead>';
      return `<div class="actor-block">
        <h3>${escapeHtml(actor.actorName)} <span class="cue-count">（${actor.cueCount} 条口令 / ${actor.segments.length} 个区段）</span> ${chainTag}</h3>
        <table>${head}<tbody>${rows}</tbody></table>
      </div>`;
    })
    .join('');
}

/** 区段关联的通道冲突标签（两种模式共用） */
function renderConflictTags(seg) {
  if (!seg.conflicts || seg.conflicts.length === 0) return '';
  const tags = seg.conflicts
    .map(
      (c) =>
        `<span class="conflict-tag" title="容量 ${c.capacity} 人，峰值 ${c.peak} 人">🚶 ${escapeHtml(c.edgeName)} ` +
        `${fmtTime(c.startTime)}~${fmtTime(c.endTime)}（峰值 ${c.peak}/${c.capacity} 人）</span>`
    )
    .join('');
  return `<span class="conflict-tags">${tags}</span>`;
}

/** 区段独立校验模式的结果行 */
function renderClassicRow(seg) {
  let timeCell;
  if (seg.status === 'unreachable') {
    timeCell = `<span class="time-detail">可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail"><strong>两区域间无连通路径</strong></span>`;
  } else if (seg.status === 'fail') {
    timeCell = `<span class="time-detail">所需 <strong>${seg.requiredSeconds} 秒</strong> / 可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail"><strong>缺口 ${-seg.slackSeconds} 秒</strong></span>
                <span class="time-detail">最早到达 ${fmtTime(seg.arrivalTime)}</span>`;
  } else {
    timeCell = `<span class="time-detail">所需 ${seg.requiredSeconds} 秒 / 可用 ${seg.availableSeconds} 秒</span>
                <span class="time-detail">余量 ${seg.slackSeconds} 秒</span>
                <span class="time-detail">最早到达 ${fmtTime(seg.arrivalTime)}</span>`;
  }
  return `<tr class="seg-${seg.status}${seg.conflicts && seg.conflicts.length ? ' has-conflict' : ''}">
    <td>${seg.index}</td>
    <td>${escapeHtml(seg.from.areaName)}<span class="time-detail">${fmtTime(seg.from.time)}${seg.from.note ? ' · ' + escapeHtml(seg.from.note) : ''}</span></td>
    <td>${escapeHtml(seg.to.areaName)}<span class="time-detail">${fmtTime(seg.to.time)}${seg.to.note ? ' · ' + escapeHtml(seg.to.note) : ''}</span></td>
    <td>${timeCell}</td>
    <td class="route">${renderRouteCell(seg)}${renderConflictTags(seg)}</td>
    <td><span class="status-pill ${seg.status}">${STATUS_LABEL[seg.status]}</span></td>
  </tr>`;
}

/** 连续口令延误传导模式的结果行：计划/实际出发、实际到达、继承延误、最终迟到 */
function renderPropagateRow(seg) {
  const fromDwell = seg.from.dwell > 0 ? ` · 停留 ${seg.from.dwell} 秒` : '';
  const toDwell = seg.to.dwell > 0 ? ` · 停留 ${seg.to.dwell} 秒` : '';
  const departLate = seg.actualDepart - seg.plannedDepart;
  const departCell =
    departLate > 0
      ? `<span class="time-detail">计划 ${fmtTime(seg.plannedDepart)}</span>
         <span class="time-detail"><strong>实际 ${fmtTime(seg.actualDepart)}（晚 ${departLate} 秒）</strong></span>`
      : `<span class="time-detail">计划 ${fmtTime(seg.plannedDepart)}</span>
         <span class="time-detail">实际 ${fmtTime(seg.actualDepart)}</span>`;
  const arrivalCell =
    seg.status === 'unreachable'
      ? '<span class="time-detail"><strong>两区域间无连通路径</strong></span>'
      : `${fmtTime(seg.arrivalTime)}<span class="time-detail">计划 ${fmtTime(seg.to.time)}</span>`;
  const inheritedCell =
    seg.inheritedDelay > 0
      ? `<span class="delay-tag">+${seg.inheritedDelay} 秒</span>`
      : '<span class="empty-hint">—</span>';
  const lateCell =
    seg.lateness === null
      ? '<span class="empty-hint">—</span>'
      : seg.lateness > 0
        ? `<span class="late-tag">迟到 ${seg.lateness} 秒</span>`
        : '<span class="ontime-tag">准时</span>';
  return `<tr class="seg-${seg.status}${seg.conflicts && seg.conflicts.length ? ' has-conflict' : ''}">
    <td>${seg.index}</td>
    <td>${escapeHtml(seg.from.areaName)}<span class="time-detail">${fmtTime(seg.from.time)}${fromDwell}${seg.from.note ? ' · ' + escapeHtml(seg.from.note) : ''}</span></td>
    <td>${escapeHtml(seg.to.areaName)}<span class="time-detail">${fmtTime(seg.to.time)}${toDwell}${seg.to.note ? ' · ' + escapeHtml(seg.to.note) : ''}</span></td>
    <td>${departCell}</td>
    <td>${arrivalCell}</td>
    <td>${inheritedCell}</td>
    <td>${lateCell}</td>
    <td class="route">${renderRouteCell(seg)}${renderConflictTags(seg)}</td>
    <td><span class="status-pill ${seg.status}">${STATUS_LABEL[seg.status]}</span></td>
  </tr>`;
}

/** 路线单元格：路径链 + 逐边时刻与等待标注（两种模式共用） */
function renderRouteCell(seg) {
  const route = seg.path.length > 0 ? escapeHtml(seg.path.join(' → ')) : '—';
  let legDetail = '';
  if (seg.legs && seg.legs.length > 0) {
    const parts = seg.legs.map((l) => {
      let s = `${fmtTime(l.departTime)} ${escapeHtml(l.fromName)} → ${fmtTime(l.arriveTime)} ${escapeHtml(l.toName)}`;
      if (l.waitSeconds > 0) {
        s += ` <span class="wait-tag">⏱ 在 ${escapeHtml(l.fromName)} 等待 ${l.waitSeconds} 秒</span>`;
      }
      return s;
    });
    legDetail = `<span class="leg-detail">${parts.join('<br>')}</span>`;
  }
  return route + legDetail;
}

/* ---------- 应急疏散快照 ---------- */

/** 出口区域勾选框：快照启用时以快照参数为准，否则保留当前勾选 */
function renderEvacExitOptions() {
  const el = $('evac-exits');
  const checkedNow = new Set([...el.querySelectorAll('input:checked')].map((i) => i.value));
  const selected = state.evacuation ? new Set(state.evacuation.exits) : checkedNow;
  el.innerHTML =
    state.data.areas
      .map((a) => {
        const checked = selected.has(a.id) ? ' checked' : '';
        return `<label class="evac-exit"><input type="checkbox" value="${a.id}"${checked} /> ${escapeHtml(a.name)}</label>`;
      })
      .join('') || '<span class="empty-hint">暂无区域，请先在下方添加舞台区域</span>';
}

/** 拉取并渲染疏散快照；未启用时显示操作提示 */
async function refreshEvacuation() {
  const el = $('evacuation-results');
  if (!state.evacuation) {
    state.evacResult = null;
    el.innerHTML = '<p class="empty-hint">输入事件时刻并勾选一个或多个出口区域后，点击「生成疏散快照」。</p>';
    updateExportHref();
    return;
  }
  // 出口区域可能已被删除：剔除失效选项；全部失效则停用快照
  const valid = new Set(state.data.areas.map((a) => a.id));
  state.evacuation.exits = state.evacuation.exits.filter((id) => valid.has(id));
  if (state.evacuation.exits.length === 0) {
    state.evacuation = null;
    state.evacResult = null;
    $('evac-clear').classList.add('hidden');
    el.innerHTML = '<p class="empty-hint">所选出口区域已被删除，请重新选择出口后再次生成。</p>';
    updateExportHref();
    renderEvacExitOptions();
    return;
  }
  const { time, exits } = state.evacuation;
  state.evacResult = await api(
    `/api/evacuation?mode=${state.mode}&time=${time}&exits=${exits.map(encodeURIComponent).join(',')}`
  );
  renderEvacuation();
  updateExportHref();
}

/** 事件时刻位置单元格 */
function evacPositionHtml(p) {
  if (p.kind === 'corridor') {
    return (
      `<span class="evac-pos">🚶 通道行进中：「${escapeHtml(p.fromName)}」→「${escapeHtml(p.toName)}」</span>` +
      `<span class="time-detail">剩余 ${p.remainingSeconds} 秒，${fmtTime(p.arriveTime)} 抵达「${escapeHtml(p.toName)}」，随后自该区域疏散</span>`
    );
  }
  const icon = p.state === '停留' ? '🧍' : '⏱';
  return (
    `<span class="evac-pos">${icon} ${p.state}：「${escapeHtml(p.areaName)}」</span>` +
    `<span class="time-detail">${escapeHtml(p.reasonText)}，自事件时刻直接疏散</span>`
  );
}

/** 疏散路线单元格：路径链 + 剩余路程 / 逐边时刻与等待标注 */
function evacRouteHtml(e) {
  const ev = e.evacuation;
  const route = ev.path.length > 0 ? escapeHtml(ev.path.join(' → ')) : '—';
  const parts = [];
  if (e.position.kind === 'corridor') {
    parts.push(
      `先按原方向走完剩余 ${e.position.remainingSeconds} 秒，${fmtTime(e.position.arriveTime)} 抵达「${escapeHtml(e.position.toName)}」`
    );
  }
  if (ev.legs.length === 0) {
    parts.push(`已位于出口区域「${escapeHtml(ev.exitName)}」，无需移动`);
  } else {
    parts.push(
      ev.legs
        .map((l) => {
          let s = `${fmtTime(l.departTime)} ${escapeHtml(l.fromName)} → ${fmtTime(l.arriveTime)} ${escapeHtml(l.toName)}`;
          if (l.waitSeconds > 0) s += ` <span class="wait-tag">⏱ 在 ${escapeHtml(l.fromName)} 等待 ${l.waitSeconds} 秒</span>`;
          return s;
        })
        .join('<br>')
    );
  }
  return `${route}<span class="leg-detail">${parts.join('<br>')}</span>`;
}

/** 渲染应急疏散快照：汇总徽章 + 最晚撤离优先的结果表 + 位置未知单列 */
function renderEvacuation() {
  const snap = state.evacResult;
  const el = $('evacuation-results');
  if (!snap) return;
  const s = snap.summary;

  const chips = [
    `<span class="evac-chip">事件时刻 <strong>${fmtTime(snap.eventTime)}</strong></span>`,
    `<span class="evac-chip">出口 <strong>${snap.exits.map((x) => escapeHtml(x.name)).join('、')}</strong></span>`,
    `<span class="evac-chip">模式 <strong>${MODE_NAME[snap.mode]}</strong></span>`,
    `<span class="evac-chip">最晚撤离 <strong>${s.latestArrival === null ? '—' : fmtTime(s.latestArrival)}</strong></span>`,
    `<span class="evac-chip ${s.unreachable ? 'bad' : ''}">无法疏散 <strong>${s.unreachable}</strong></span>`,
    `<span class="evac-chip ${s.unknown ? 'warn' : ''}">位置未知 <strong>${s.unknown}</strong></span>`,
  ].join('');

  const rows = snap.entries
    .map((e) => {
      const pos = evacPositionHtml(e.position);
      if (e.status === 'unreachable') {
        return `<tr class="evac-row-unreachable">
          <td>${escapeHtml(e.actorName)}</td>
          <td>${pos}</td>
          <td colspan="3"><span class="status-pill unreachable">⛔ 无可达出口的路线</span></td>
          <td>—</td>
        </tr>`;
      }
      const ev = e.evacuation;
      return `<tr>
        <td>${escapeHtml(e.actorName)}</td>
        <td>${pos}</td>
        <td>${escapeHtml(ev.exitName)}</td>
        <td>${fmtTime(ev.arrivalTime)}</td>
        <td>${ev.durationSeconds} 秒</td>
        <td class="route">${evacRouteHtml(e)}</td>
      </tr>`;
    })
    .join('');

  const unknownHtml = snap.unknown.length
    ? `<div class="evac-unknown">
        <h4>❓ 位置未知（${snap.unknown.length}）</h4>
        <ul>${snap.unknown.map((u) => `<li><strong>${escapeHtml(u.actorName)}</strong>：${escapeHtml(u.reasonText)}</li>`).join('')}</ul>
      </div>`
    : '';

  el.innerHTML = `
    <div class="evac-chips">${chips}</div>
    <p class="evac-order-hint">按最晚撤离优先排序（无法疏散视为最晚，位置未知单列）；「导出校验报告」将追加同一快照。</p>
    <table>
      <thead><tr><th>演员</th><th>事件时刻位置</th><th>出口</th><th>到达时刻</th><th>耗时</th><th>疏散路线</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="empty-hint">无位置已知的演员</td></tr>'}</tbody>
    </table>
    ${unknownHtml}`;
}

function bindEvacuation() {
  $('form-evacuation').addEventListener('submit', async (e) => {
    e.preventDefault();
    const time = parseTime($('evac-time').value);
    if (Number.isNaN(time)) {
      toast('事件时刻格式不正确，请输入秒数（如 25）或 mm:ss（如 00:25）', true);
      return;
    }
    const exits = [...$('evac-exits').querySelectorAll('input:checked')].map((i) => i.value);
    if (exits.length === 0) {
      toast('请至少勾选一个出口区域', true);
      return;
    }
    state.evacuation = { time, exits };
    $('evac-clear').classList.remove('hidden');
    try {
      await refreshEvacuation();
      toast('疏散快照已生成，报告将追加同一快照');
    } catch (err) {
      toast(err.message, true);
    }
  });

  $('evac-clear').addEventListener('click', () => {
    state.evacuation = null;
    state.evacResult = null;
    $('evac-clear').classList.add('hidden');
    renderEvacExitOptions();
    refreshEvacuation();
    toast('已清除疏散快照');
  });
}

/* ---------- 跨演员口令依赖 ---------- */

const DEP_STATUS_LABEL = {
  satisfied: '✅ 满足',
  violated: '❌ 违约',
  unknown: '❓ 无法判定',
};

/** 口令选项文本：时刻 区域（说明）（演员由下拉分组标题展示） */
function cueOptionText(c) {
  const note = c.note ? `（${c.note}）` : '';
  return `${fmtTime(c.time)} ${escapeHtml(areaName(c.areaId))}${escapeHtml(note)}`;
}

/** 填充依赖表单的两个口令下拉（按演员分组、组内按时间升序） */
function fillDependencySelects() {
  const groups = new Map();
  const sortedCues = state.data.cues.slice().sort((x, y) => x.time - y.time);
  for (const c of sortedCues) {
    const actor = state.data.actors.find((a) => a.id === c.actorId);
    const key = c.actorId;
    if (!groups.has(key)) groups.set(key, { name: actor ? actor.name : '（已删除演员）', cues: [] });
    groups.get(key).cues.push(c);
  }
  const html = [...groups.values()]
    .map(
      (g) =>
        `<optgroup label="${escapeHtml(g.name)}">${g.cues
          .map((c) => `<option value="${c.id}">${cueOptionText(c)}</option>`)
          .join('')}</optgroup>`
    )
    .join('');
  $('dep-before').innerHTML = html || '<option value="">暂无口令</option>';
  $('dep-after').innerHTML = html || '<option value="">暂无口令</option>';
}

/** 依赖评估条目取前端兜底描述（评估结果缺失时使用数据文件中的原始口令） */
function fallbackCue(cueId) {
  const c = state.data.cues.find((x) => x.id === cueId);
  if (!c) return { cueId, actorName: '（已删除）', time: null, areaName: '（已删除）', note: '', dwell: 0 };
  return {
    cueId,
    actorName: actorName(c.actorId),
    time: c.time,
    areaName: areaName(c.areaId),
    note: c.note || '',
    dwell: c.dwell > 0 ? c.dwell : 0,
  };
}

function renderDependencyCueCell(cue, dwellVisible) {
  if (!cue || cue.time === null || cue.time === undefined) return escapeHtml('（口令已删除）');
  const cross = cue.crossActorTag || '';
  const note = cue.note ? ` · ${escapeHtml(cue.note)}` : '';
  const dwell = dwellVisible && cue.dwell > 0 ? `<span class="time-detail">停留 ${cue.dwell} 秒</span>` : '';
  return `<strong>${escapeHtml(cue.actorName)}</strong>${cross}<span class="time-detail">${fmtTime(cue.time)} · ${escapeHtml(cue.areaName)}${note}</span>${dwell}`;
}

/** 渲染依赖评估表（随校验结果即时重算） */
function renderDependencies() {
  const v = state.validation;
  const el = $('dependency-results');
  if (!v) return;

  const byId = new Map((v.dependencies?.items || []).map((d) => [d.id, d]));
  const deps = state.data.dependencies || [];

  if (deps.length === 0) {
    el.innerHTML = '<p class="empty-hint">暂无口令依赖。选择前置 / 后置口令并填写至少等待秒数后点击「添加依赖」。</p>';
    fillDependencySelects();
    return;
  }

  const s = v.dependencies ? v.dependencies.summary : { total: deps.length, satisfied: 0, violated: 0, unknown: deps.length };
  const chips = [
    `<span class="dep-chip">依赖 <strong>${s.total}</strong></span>`,
    `<span class="dep-chip ${s.satisfied ? 'good' : ''}">满足 <strong>${s.satisfied}</strong></span>`,
    `<span class="dep-chip ${s.violated ? 'bad' : ''}">违约 <strong>${s.violated}</strong></span>`,
    `<span class="dep-chip ${s.unknown ? 'warn' : ''}">无法判定 <strong>${s.unknown}</strong></span>`,
  ].join('');

  // 渲染顺序与服务端一致：违约 → 无法判定 → 满足；评估结果缺失（极端情况）时补在末尾
  const ordered = v.dependencies
    ? [...v.dependencies.items, ...deps.filter((d) => !byId.has(d.id))]
    : deps;

  const rows = ordered
    .map((raw) => {
      const d = byId.get(raw.id) || {
        id: raw.id,
        waitSeconds: raw.waitSeconds,
        predecessor: fallbackCue(raw.predecessorId),
        successor: fallbackCue(raw.successorId),
        status: 'unknown',
        reason: '当前模式下暂无评估结果',
        completionTime: null,
        successorDepart: null,
        requiredDepart: null,
        delta: null,
      };
      const before = d.predecessor;
      const after = d.successor;
      before.crossActorTag = d.crossActor ? '<span class="cross-tag">跨演员</span>' : '';

      let verdict;
      if (d.status === 'satisfied') {
        verdict = `<span class="status-pill ok">✅ 满足</span><span class="time-detail">余量 ${d.delta} 秒</span>`;
      } else if (d.status === 'violated') {
        verdict = `<span class="status-pill fail">❌ 违约</span><span class="time-detail"><strong>缺口 ${-d.delta} 秒</strong></span>`;
      } else {
        verdict = `<span class="status-pill unreachable">❓ 无法判定</span><span class="time-detail">${escapeHtml(d.reason || '任一端时刻不可得')}</span>`;
      }

      const timeCell =
        d.completionTime === null
          ? '<span class="empty-hint">—</span>'
          : `<span class="time-detail">完成 ${fmtTime(d.completionTime)}</span>` +
            `<span class="time-detail">后置实际出发 ${fmtTime(d.successorDepart)}</span>` +
            `<span class="time-detail">允许最早 ${fmtTime(d.requiredDepart)}</span>`;

      return `<tr class="dep-${d.status}">
        <td>${renderDependencyCueCell(before, true)}</td>
        <td class="dep-wait">≥ <strong>${d.waitSeconds}</strong> 秒</td>
        <td>${renderDependencyCueCell(after, false)}</td>
        <td>${timeCell}</td>
        <td>${verdict}</td>
        <td class="col-ops"><button class="btn btn-danger" data-del-dep="${d.id}">删除</button></td>
      </tr>`;
    })
    .join('');

  el.innerHTML = `
    <div class="dep-chips">${chips}</div>
    <p class="dep-hint">判定口径：前置完成时刻 = 当前模式实际到达 + 停留时长；后置实际出发 = 前往后置口令区段的实际出发；相差秒数 = 后置实际出发 −（前置完成 + 等待）。</p>
    <table class="dep-table">
      <thead><tr><th>前置口令</th><th>至少等待</th><th>后置口令</th><th>时刻对比</th><th>结论 / 相差秒数</th><th class="col-ops">操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  fillDependencySelects();
}

function bindDependencies() {
  $('form-dependency').addEventListener('submit', (e) => {
    e.preventDefault();
    const predecessorId = $('dep-before').value;
    const successorId = $('dep-after').value;
    const waitSeconds = Number($('dep-wait').value);
    if (!predecessorId || !successorId) {
      toast('请选择前置口令与后置口令', true);
      return;
    }
    if (predecessorId === successorId) {
      toast('前置与后置不能是同一条口令', true);
      return;
    }
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 3600) {
      toast('至少等待秒数必须是 0～3600 的整数', true);
      return;
    }
    mutate(
      async () => {
        await api('/api/dependencies', 'POST', { predecessorId, successorId, waitSeconds });
        $('dep-wait').value = '';
      },
      '依赖已添加，已即时重算'
    );
  });

  $('dependency-results').addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const id = t.dataset.delDep;
    if (!id) return;
    mutate(() => api(`/api/dependencies/${id}`, 'DELETE'), '依赖已删除，已即时重算');
  });
}

/* ---------- 下拉框选项 ---------- */

function fillSelect(el, items, placeholder) {
  const current = el.value;
  el.innerHTML =
    `<option value="" disabled selected>${placeholder}</option>` +
    items.map((it) => `<option value="${it.id}">${escapeHtml(it.name)}</option>`).join('');
  if (items.some((it) => it.id === current)) el.value = current;
}

function refreshSelects() {
  fillSelect($('edge-a'), state.data.areas, '选择区域 A');
  fillSelect($('edge-b'), state.data.areas, '选择区域 B');
  fillSelect($('cue-actor'), state.data.actors, '选择演员');
  fillSelect($('cue-area'), state.data.areas, '选择目标区域');
}

/* ---------- 封闭时段编辑器 ---------- */

function addClosureRow(start, end) {
  const row = document.createElement('div');
  row.className = 'closure-row';
  row.innerHTML = `
    <input type="number" class="closure-start" min="0" step="1" placeholder="开始(秒)" />
    <span class="closure-sep">~</span>
    <input type="number" class="closure-end" min="0" step="1" placeholder="结束(秒)" />
    <button type="button" class="btn btn-danger btn-remove-closure" title="删除该时段">×</button>
  `;
  if (start !== undefined && start !== null) row.querySelector('.closure-start').value = start;
  if (end !== undefined && end !== null) row.querySelector('.closure-end').value = end;
  row.querySelector('.btn-remove-closure').addEventListener('click', () => row.remove());
  $('closures-list').appendChild(row);
}

function clearClosureRows() {
  $('closures-list').innerHTML = '';
}

/** 收集封闭时段行，返回 { closures } 或 { error } */
function collectClosures() {
  const closures = [];
  for (const row of document.querySelectorAll('#closures-list .closure-row')) {
    const s = row.querySelector('.closure-start').value.trim();
    const e = row.querySelector('.closure-end').value.trim();
    if (s === '' && e === '') continue; // 忽略空行
    const start = Number(s);
    const end = Number(e);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0) {
      return { error: '封闭时段的起止必须是不小于 0 的整数秒' };
    }
    if (start >= end) return { error: '封闭时段的开始秒数必须小于结束秒数' };
    closures.push({ start, end });
  }
  return { closures };
}

/* ---------- 编辑模式 ---------- */

function setEditing(prefix, submitBtn, cancelBtn, isEditing, addText, updateText) {
  $(submitBtn).textContent = isEditing ? updateText : addText;
  $(cancelBtn).classList.toggle('hidden', !isEditing);
  if (!isEditing) $(prefix).value = '';
}

function clearAreaForm() {
  $('form-area').reset();
  setEditing('area-id', 'area-submit', 'area-cancel', false, '添加区域', '保存修改');
}
function clearEdgeForm() {
  $('form-edge').reset();
  clearClosureRows();
  setEditing('edge-id', 'edge-submit', 'edge-cancel', false, '添加连接', '保存修改');
}
function clearActorForm() {
  $('form-actor').reset();
  setEditing('actor-id', 'actor-submit', 'actor-cancel', false, '添加演员', '保存修改');
}
function clearCueForm() {
  $('form-cue').reset();
  setEditing('cue-id', 'cue-submit', 'cue-cancel', false, '添加口令', '保存修改');
}

/* ---------- 提交与变更 ---------- */

async function mutate(fn, successMsg) {
  try {
    await fn();
    await refresh();
    refreshSelects();
    if (successMsg) toast(successMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function bindForms() {
  $('form-area').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('area-id').value;
    const body = { name: $('area-name').value.trim(), description: $('area-desc').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/areas/${id}`, 'PUT', body);
      else await api('/api/areas', 'POST', body);
      clearAreaForm();
    }, id ? '区域已更新' : '区域已添加');
  });

  $('form-edge').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('edge-id').value;
    const { closures, error } = collectClosures();
    if (error) {
      toast(error, true);
      return;
    }
    const capacityRaw = $('edge-capacity').value.trim();
    const capacity = capacityRaw === '' ? 1 : Number(capacityRaw);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 10) {
      toast('通道容量必须是 1～10 的整数', true);
      return;
    }
    const body = {
      a: $('edge-a').value,
      b: $('edge-b').value,
      seconds: Number($('edge-seconds').value),
      capacity,
      closures,
    };
    mutate(async () => {
      if (id) await api(`/api/edges/${id}`, 'PUT', body);
      else await api('/api/edges', 'POST', body);
      clearEdgeForm();
    }, id ? '连接已更新，已重新校验' : '连接已添加');
  });

  $('form-actor').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('actor-id').value;
    const body = { name: $('actor-name').value.trim(), role: $('actor-role').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/actors/${id}`, 'PUT', body);
      else await api('/api/actors', 'POST', body);
      clearActorForm();
    }, id ? '演员已更新' : '演员已添加');
  });

  $('form-cue').addEventListener('submit', (e) => {
    e.preventDefault();
    const time = parseTime($('cue-time').value);
    if (Number.isNaN(time)) {
      toast('时间格式不正确，请输入秒数（如 90）或 mm:ss（如 01:30）', true);
      return;
    }
    const dwellRaw = $('cue-dwell').value.trim();
    const dwell = dwellRaw === '' ? 0 : Number(dwellRaw);
    if (!Number.isInteger(dwell) || dwell < 0 || dwell > 600) {
      toast('停留时长必须是 0～600 的整数秒', true);
      return;
    }
    const id = $('cue-id').value;
    const body = { actorId: $('cue-actor').value, areaId: $('cue-area').value, time, dwell, note: $('cue-note').value.trim() };
    mutate(async () => {
      if (id) await api(`/api/cues/${id}`, 'PUT', body);
      else await api('/api/cues', 'POST', body);
      clearCueForm();
    }, id ? '口令已更新' : '口令已添加');
  });

  $('area-cancel').addEventListener('click', clearAreaForm);
  $('edge-cancel').addEventListener('click', clearEdgeForm);
  $('actor-cancel').addEventListener('click', clearActorForm);
  $('cue-cancel').addEventListener('click', clearCueForm);
  $('btn-add-closure').addEventListener('click', () => addClosureRow());
}

function bindTableActions() {
  document.body.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;

    const d = t.dataset;
    if (d.editArea) {
      const a = state.data.areas.find((x) => x.id === d.editArea);
      if (!a) return;
      $('area-id').value = a.id;
      $('area-name').value = a.name;
      $('area-desc').value = a.description || '';
      setEditing('area-id', 'area-submit', 'area-cancel', true, '添加区域', '保存修改');
      $('area-name').focus();
    } else if (d.delArea) {
      if (!confirm('删除该区域将同时删除相关连接与口令，确定？')) return;
      mutate(() => api(`/api/areas/${d.delArea}`, 'DELETE'), '区域已删除');
    } else if (d.editEdge) {
      const ed = state.data.edges.find((x) => x.id === d.editEdge);
      if (!ed) return;
      $('edge-id').value = ed.id;
      $('edge-a').value = ed.a;
      $('edge-b').value = ed.b;
      $('edge-seconds').value = ed.seconds;
      $('edge-capacity').value = Number.isInteger(ed.capacity) && ed.capacity >= 1 ? ed.capacity : 1;
      clearClosureRows();
      (Array.isArray(ed.closures) ? ed.closures : []).forEach((c) => addClosureRow(c.start, c.end));
      setEditing('edge-id', 'edge-submit', 'edge-cancel', true, '添加连接', '保存修改');
    } else if (d.delEdge) {
      mutate(() => api(`/api/edges/${d.delEdge}`, 'DELETE'), '连接已删除');
    } else if (d.editActor) {
      const a = state.data.actors.find((x) => x.id === d.editActor);
      if (!a) return;
      $('actor-id').value = a.id;
      $('actor-name').value = a.name;
      $('actor-role').value = a.role || '';
      setEditing('actor-id', 'actor-submit', 'actor-cancel', true, '添加演员', '保存修改');
      $('actor-name').focus();
    } else if (d.delActor) {
      if (!confirm('删除该演员将同时删除其全部口令，确定？')) return;
      mutate(() => api(`/api/actors/${d.delActor}`, 'DELETE'), '演员已删除');
    } else if (d.editCue) {
      const c = state.data.cues.find((x) => x.id === d.editCue);
      if (!c) return;
      $('cue-id').value = c.id;
      $('cue-actor').value = c.actorId;
      $('cue-area').value = c.areaId;
      $('cue-time').value = fmtTime(c.time);
      $('cue-dwell').value = c.dwell || 0;
      $('cue-note').value = c.note || '';
      setEditing('cue-id', 'cue-submit', 'cue-cancel', true, '添加口令', '保存修改');
    } else if (d.delCue) {
      mutate(() => api(`/api/cues/${d.delCue}`, 'DELETE'), '口令已删除');
    }
  });
}

function bindHeaderActions() {
  $('btn-refresh').addEventListener('click', () =>
    mutate(async () => {}, '已重新校验')
  );
  $('btn-reset').addEventListener('click', () => {
    if (!confirm('将丢弃当前全部修改并恢复为示例数据，确定？')) return;
    mutate(async () => {
      await api('/api/reset', 'POST');
      clearAreaForm();
      clearEdgeForm();
      clearActorForm();
      clearCueForm();
      $('form-dependency').reset();
    }, '已恢复示例数据');
  });
  document.querySelectorAll('#mode-switch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (btn.dataset.mode === state.mode) return;
      setMode(btn.dataset.mode);
      try {
        await refreshValidation();
        await refreshEvacuation(); // 快照按当前校验模式还原位置，模式切换后随动重算
        const otherMode = state.mode === 'propagate' ? 'classic' : 'propagate';
        const meta = state.validation.baselines || {};
        if (meta[state.mode]) toast(`已切换到「${MODE_NAME[state.mode]}」，已加载该模式基线对比`);
        else if (meta[otherMode]) toast(`「${MODE_NAME[state.mode]}」模式没有基线；另一模式的基线模式不一致，未比较`, true);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });

  // 基线保存 / 覆盖 / 清除（事件委托，面板随校验结果重绘）
  $('baseline-panel').addEventListener('click', async (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    const { baselineSave, baselineClear } = t.dataset;
    if (!baselineSave && !baselineClear) return;
    try {
      if (baselineSave) {
        const overwrite = !!(state.validation.baselines && state.validation.baselines[baselineSave]);
        if (overwrite && !confirm('用当前校验结果覆盖该模式已保存的基线？')) return;
        await api(`/api/baseline/${baselineSave}`, 'POST');
        await refreshValidation();
        toast(overwrite ? '基线已覆盖' : '基线已保存，开始与当前结果对比');
      } else if (baselineClear) {
        if (!confirm('确定清除该模式保存的基线？')) return;
        await api(`/api/baseline/${baselineClear}`, 'DELETE');
        await refreshValidation();
        toast('基线已清除');
      }
    } catch (err) {
      toast(err.message, true);
    }
  });
}

/* ---------- 启动 ---------- */

(async function init() {
  bindForms();
  bindTableActions();
  bindHeaderActions();
  bindEvacuation();
  bindDependencies();
  setMode(state.mode);
  try {
    await refresh();
    refreshSelects();
  } catch (err) {
    toast('初始化失败：' + err.message, true);
  }
})();
