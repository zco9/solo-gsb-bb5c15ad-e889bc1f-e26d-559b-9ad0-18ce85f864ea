const express = require('express');
const crypto = require('crypto');
const store = require('./store');
const { validate, MODES } = require('./validate');
const { evacuationSnapshot } = require('./evacuation');
const { buildComparison } = require('./baseline');
const { toMarkdown } = require('./report');
const { findCycle, cycleMessage, MAX_WAIT_SECONDS } = require('./dependencies');

const router = express.Router();

/** 解析校验模式：缺省为区段独立校验（兼容旧调用），propagate 为连续口令延误传导 */
function parseMode(query) {
  if (query.mode === undefined) return 'classic';
  return MODES.includes(query.mode) ? query.mode : null;
}

/** 取某模式的基线元信息（不携带快照正文） */
function baselineMeta(data, mode) {
  const b = data.baselines && data.baselines[mode];
  return b ? { mode, savedAt: b.savedAt } : null;
}

/** 各模式的基线元信息（用于提示另一模式下是否存在基线） */
function allBaselineMeta(data) {
  const meta = {};
  for (const m of MODES) meta[m] = baselineMeta(data, m);
  return meta;
}

/** 在校验结果上挂载基线信息与基线对比摘要（当前模式存在基线时） */
function withBaseline(result, data, mode) {
  result.baseline = baselineMeta(data, mode);
  result.baselines = allBaselineMeta(data);
  const snapshot = data.baselines && data.baselines[mode];
  result.comparison = snapshot ? buildComparison(result, snapshot.result) : null;
  return result;
}

/**
 * 解析应急疏散快照参数：time（事件时刻，秒）与 exits（出口区域，逗号分隔的 ID 列表）。
 * 两个参数都未提供时返回 { params: null }（不生成快照）；只提供其一或取值非法时返回 { error }。
 */
function parseEvacuation(query, data) {
  const { time, exits } = query;
  if (time === undefined && exits === undefined) return { params: null };
  const t = Number(time);
  if (!Number.isInteger(t) || t < 0) return { error: 'time 必须是不小于 0 的整数秒（事件时刻）' };
  const ids = String(exits || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return { error: 'exits 必须包含至少一个出口区域 ID' };
  const areaIds = new Set(data.areas.map((a) => a.id));
  for (const id of ids) {
    if (!areaIds.has(id)) return { error: `出口区域不存在：${id}` };
  }
  return { params: { time: t, exits: [...new Set(ids)] } };
}

/* ---------- 入参校验 ---------- */

function isNonEmptyString(v, max = 60) {
  return typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
}

function isNonNegativeInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** 校验封闭时段数组：[{start, end}]，半开区间 [start, end)，单位秒 */
function validateClosures(closures) {
  if (closures === undefined) return null;
  if (!Array.isArray(closures)) return '封闭时段必须是数组';
  if (closures.length > 50) return '每条连接的封闭时段最多 50 个';
  for (const c of closures) {
    if (!c || !isNonNegativeInt(c.start) || !isNonNegativeInt(c.end)) {
      return '封闭时段的起止必须是不小于 0 的整数秒';
    }
    if (c.start >= c.end) return '封闭时段的开始秒数必须小于结束秒数';
  }
  return null;
}

/** 清洗封闭时段：缺省为空数组，按开始秒数排序 */
function normalizeClosures(closures) {
  if (!Array.isArray(closures)) return [];
  return closures
    .map((c) => ({ start: c.start, end: c.end }))
    .sort((x, y) => x.start - y.start || x.end - y.end);
}

const validators = {
  areas(body) {
    if (!isNonEmptyString(body.name, 30)) return '区域名称必填且不超过 30 字';
    if (body.description !== undefined && typeof body.description !== 'string') return '备注格式不正确';
    return null;
  },
  actors(body) {
    if (!isNonEmptyString(body.name, 30)) return '演员姓名必填且不超过 30 字';
    if (body.role !== undefined && typeof body.role !== 'string') return '角色格式不正确';
    return null;
  },
  edges(body, data) {
    const ids = new Set(data.areas.map((a) => a.id));
    if (!ids.has(body.a) || !ids.has(body.b)) return '连接两端必须是已存在的区域';
    if (body.a === body.b) return '连接两端不能是同一区域';
    if (!isNonNegativeInt(body.seconds)) return '通行耗时必须是不小于 0 的整数秒';
    if (
      body.capacity !== undefined &&
      (!Number.isInteger(body.capacity) || body.capacity < 1 || body.capacity > 10)
    ) {
      return '通道容量必须是 1～10 的整数';
    }
    return validateClosures(body.closures);
  },
  cues(body, data) {
    if (!data.actors.some((a) => a.id === body.actorId)) return '必须选择已存在的演员';
    if (!data.areas.some((a) => a.id === body.areaId)) return '必须选择已存在的区域';
    if (!isNonNegativeInt(body.time)) return '时间必须是不小于 0 的整数秒';
    if (body.dwell !== undefined && (!Number.isInteger(body.dwell) || body.dwell < 0 || body.dwell > 600)) {
      return '停留时长必须是 0～600 的整数秒';
    }
    if (body.note !== undefined && typeof body.note !== 'string') return '口令说明格式不正确';
    return null;
  },
};

function sanitize(collection, body) {
  switch (collection) {
    case 'areas':
      return { name: body.name.trim(), description: (body.description || '').trim() };
    case 'actors':
      return { name: body.name.trim(), role: (body.role || '').trim() };
    case 'edges': {
      const edge = { a: body.a, b: body.b, seconds: body.seconds, closures: normalizeClosures(body.closures) };
      // capacity 缺省时不写入：POST 由路由补默认值 1，PUT 保留原值（兼容旧数据）
      if (body.capacity !== undefined) edge.capacity = body.capacity;
      return edge;
    }
    case 'cues': {
      const cue = { actorId: body.actorId, areaId: body.areaId, time: body.time, note: (body.note || '').trim() };
      // dwell 缺省时不写入：POST 由路由补默认值 0，PUT 保留原值（兼容旧数据）
      if (body.dwell !== undefined) cue.dwell = body.dwell;
      return cue;
    }
    default:
      return {};
  }
}

/* ---------- 查询 ---------- */

router.get('/data', (req, res) => {
  const data = store.load();
  // 基线快照仅通过 /api/validate 的对比摘要使用，不随基础数据下发
  const { baselines, ...rest } = data;
  res.json(rest);
});

router.get('/validate', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const result = withBaseline(validate(store.load(), mode), store.load(), mode);
  res.json(result);
});

router.get('/report', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  // 可选：携带 time 与 exits 时在报告末尾追加同一份应急疏散快照
  const { params, error } = parseEvacuation(req.query, data);
  if (error) return res.status(400).json({ error });
  const evacuation = params ? evacuationSnapshot(data, mode, params.time, params.exits) : null;
  const md = toMarkdown(withBaseline(validate(data, mode), data, mode), evacuation);
  const filename = encodeURIComponent('舞台走位校验报告.md');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=report.md; filename*=UTF-8''${filename}`);
  res.send(md);
});

/* ---------- 应急疏散快照 ---------- */

router.get('/evacuation', (req, res) => {
  const mode = parseMode(req.query);
  if (!mode) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  const { params, error } = parseEvacuation(req.query, data);
  if (error) return res.status(400).json({ error });
  if (!params) return res.status(400).json({ error: '缺少参数：time（事件时刻）与 exits（出口区域）' });
  res.json(evacuationSnapshot(data, mode, params.time, params.exits));
});

router.post('/reset', (req, res) => {
  store.reset();
  res.json(store.load());
});

/* ---------- 走位方案基线 ---------- */

/** 保存（或覆盖）当前模式的基线快照 */
router.post('/baseline/:mode', (req, res) => {
  const { mode } = req.params;
  if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode 必须是 classic 或 propagate' });
  const data = store.load();
  const result = validate(data, mode);
  data.baselines[mode] = { savedAt: new Date().toISOString(), result };
  store.save();
  res.status(201).json({ baseline: baselineMeta(data, mode), comparison: buildComparison(result, data.baselines[mode].result) });
});

/** 清除基线：指定模式；all 清除全部模式 */
router.delete('/baseline/:mode', (req, res) => {
  const { mode } = req.params;
  if (mode !== 'all' && !MODES.includes(mode)) {
    return res.status(400).json({ error: 'mode 必须是 classic 或 propagate（或 all）' });
  }
  const data = store.load();
  if (mode === 'all') data.baselines = {};
  else delete data.baselines[mode];
  store.save();
  res.status(204).end();
});

/* ---------- 跨演员口令依赖 ---------- */

/** 过滤掉任一端口令已不存在的依赖（删除口令 / 演员 / 区域后保持引用一致） */
function pruneDependencies(data) {
  const cueIds = new Set(data.cues.map((c) => c.id));
  data.dependencies = (data.dependencies || []).filter(
    (d) => cueIds.has(d.predecessorId) && cueIds.has(d.successorId)
  );
}

/** 新增依赖：写入前对整张依赖图做环检测，成环（含自环、重复反向边）不写入 */
router.post('/dependencies', (req, res) => {
  const data = store.load();
  const body = req.body || {};
  const cueIds = new Set(data.cues.map((c) => c.id));
  if (!cueIds.has(body.predecessorId) || !cueIds.has(body.successorId)) {
    return res.status(400).json({ error: '前置 / 后置口令必须是已存在的口令' });
  }
  if (body.predecessorId === body.successorId) {
    return res.status(400).json({ error: '前置与后置不能是同一条口令' });
  }
  if (!isNonNegativeInt(body.waitSeconds) || body.waitSeconds > MAX_WAIT_SECONDS) {
    return res.status(400).json({ error: `至少等待秒数必须是 0～${MAX_WAIT_SECONDS} 的整数` });
  }
  const dup = data.dependencies.some(
    (d) => d.predecessorId === body.predecessorId && d.successorId === body.successorId
  );
  if (dup) return res.status(409).json({ error: '这两条口令之间已存在相同方向的依赖' });

  const candidate = {
    id: crypto.randomUUID(),
    predecessorId: body.predecessorId,
    successorId: body.successorId,
    waitSeconds: body.waitSeconds,
  };
  data.dependencies.push(candidate);

  const cycle = findCycle(data.dependencies);
  if (cycle) {
    data.dependencies.pop(); // 成环：不写入
    return res.status(400).json({ error: cycleMessage(data, cycle), cycle });
  }

  store.save();
  res.status(201).json(candidate);
});

/** 删除依赖 */
router.delete('/dependencies/:id', (req, res) => {
  const data = store.load();
  const idx = data.dependencies.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '依赖不存在' });
  data.dependencies.splice(idx, 1);
  store.save();
  res.status(204).end();
});

/* ---------- 通用 CRUD ---------- */

const COLLECTIONS = ['areas', 'edges', 'actors', 'cues'];

router.post('/:collection', (req, res) => {
  const { collection } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const err = validators[collection](req.body || {}, data);
  if (err) return res.status(400).json({ error: err });

  const item = { id: crypto.randomUUID(), ...sanitize(collection, req.body) };
  if (collection === 'cues' && item.dwell === undefined) item.dwell = 0; // 停留时长默认 0
  if (collection === 'edges' && item.capacity === undefined) item.capacity = 1; // 通道容量默认 1

  if (collection === 'edges') {
    const dup = data.edges.some(
      (e) => (e.a === item.a && e.b === item.b) || (e.a === item.b && e.b === item.a)
    );
    if (dup) return res.status(409).json({ error: '两个区域之间已存在连接，可直接编辑耗时' });
  }

  data[collection].push(item);
  store.save();
  res.status(201).json(item);
});

router.put('/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const item = data[collection].find((x) => x.id === id);
  if (!item) return res.status(404).json({ error: '记录不存在' });

  const err = validators[collection](req.body || {}, data);
  if (err) return res.status(400).json({ error: err });

  Object.assign(item, sanitize(collection, req.body));

  if (collection === 'edges') {
    const dup = data.edges.some(
      (e) => e.id !== id && ((e.a === item.a && e.b === item.b) || (e.a === item.b && e.b === item.a))
    );
    if (dup) return res.status(409).json({ error: '两个区域之间已存在连接' });
  }

  store.save();
  res.json(item);
});

router.delete('/:collection/:id', (req, res) => {
  const { collection, id } = req.params;
  if (!COLLECTIONS.includes(collection)) return res.status(404).json({ error: '未知资源类型' });

  const data = store.load();
  const idx = data[collection].findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ error: '记录不存在' });

  data[collection].splice(idx, 1);

  // 级联清理，保证校验数据一致
  if (collection === 'areas') {
    data.edges = data.edges.filter((e) => e.a !== id && e.b !== id);
    data.cues = data.cues.filter((c) => c.areaId !== id);
  } else if (collection === 'actors') {
    data.cues = data.cues.filter((c) => c.actorId !== id);
  }

  // 删除口令（或因删除区域 / 演员连带删除口令）后，级联清理相关口令依赖
  pruneDependencies(data);

  store.save();
  res.status(204).end();
});

module.exports = router;
