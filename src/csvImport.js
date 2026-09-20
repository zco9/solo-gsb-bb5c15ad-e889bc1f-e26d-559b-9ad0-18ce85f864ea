// 排练数据 CSV 导入
// 模板下载 + 上传预览 + 版本化提交：
// 预览按「姓名+角色」复用现有演员（无匹配则计划新建）、按区域名解析目标区域，
// 逐行校验时间 / 停留格式、未知或重名区域、文件内重复与现有口令冲突；
// 全部行通过时生成携带数据版本的导入计划，提交时若底库已变化（版本不一致）
// 返回 409 并要求重新预览，否则一次性写入全部新演员与口令——任何校验失败都不落库。

const crypto = require('crypto');

/** 单次导入的最大数据行数 */
const MAX_ROWS = 1000;
/** 单次上传的 CSV 文本最大长度（字符数） */
const MAX_CSV_CHARS = 2000000;
/** 停留时长上限（与口令 CRUD 一致，秒） */
const MAX_DWELL = 600;
const MAX_NAME_LEN = 30;
const MAX_ROLE_LEN = 30;
const MAX_NOTE_LEN = 60;

/** 表头别名：按表头名定位列，允许调整列顺序 */
const HEADER_ALIASES = {
  name: ['姓名', '演员', '演员姓名'],
  role: ['角色'],
  area: ['目标区域', '区域', '区域名称'],
  time: ['时间', '到位时间'],
  dwell: ['停留秒数', '停留时长', '停留'],
  note: ['说明', '备注', '口令说明'],
};

/** 模板内容（下载时前置 BOM，便于 Excel 直接打开） */
const TEMPLATE_CSV = [
  ['姓名', '角色', '目标区域', '时间', '停留秒数', '说明'],
  ['张三', '饰 王子', '舞台中央', '95', '0', '示例：姓名+角色与现有演员完全一致时复用该演员'],
  ['赵六', '饰 侍从', '侧台右', '01:40', '5', '示例：无匹配演员时自动新建；时间支持 90 或 01:30'],
]
  .map((row) => row.map(csvCell).join(','))
  .join('\r\n') + '\r\n';

/** CSV 单元格转义：含引号 / 逗号 / 换行时加引号并转义内部引号 */
function csvCell(value) {
  const v = String(value ?? '');
  return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** 带 HTTP 状态码的错误（路由层捕获后按状态码响应） */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * 解析 CSV 文本为二维数组。
 * 支持 UTF-8 BOM、引号包裹字段（"" 转义）、CRLF / CR / LF 换行；
 * 未闭合的引号按宽容处理（剩余内容并入当前字段）。
 */
function parseCsv(text) {
  const s = String(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0; // 跳过 BOM
  for (; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** 解析 "90" 或 "01:30" 形式的时间，返回秒数；非法返回 NaN（与前端 parseTime 同规则） */
function parseTimeInput(str) {
  const s = String(str).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = s.match(/^(\d{1,3}):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  return NaN;
}

/** 秒数格式化为 mm:ss（用于错误提示） */
function fmtTimeText(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 演员匹配键：姓名 + 角色（导入复用与计划复核的共同口径；以控制字符分隔避免拼接碰撞） */
function actorKeyOf(name, role) {
  return `${name}\u0001${role}`;
}

/**
 * 数据版本：对导入计划依赖的底库数据（区域 / 演员 / 口令）取哈希。
 * 任何相关增删改都会改变版本，使已生成的导入计划失效（提交时返回 409）。
 */
function computeDataVersion(data) {
  const pick = {
    areas: (data.areas || []).map((a) => [a.id, a.name]),
    actors: (data.actors || []).map((a) => [a.id, a.name, a.role || '']),
    cues: (data.cues || []).map((c) => [c.id, c.actorId, c.areaId, c.time, Number.isInteger(c.dwell) ? c.dwell : 0]),
  };
  return crypto.createHash('sha256').update(JSON.stringify(pick)).digest('hex').slice(0, 24);
}

/**
 * 上传预览：解析 CSV 并逐行校验，返回行级结果、汇总与（全部通过时的）导入计划。
 * 任一数据行存在错误时 plan 为 null（前端据此禁止提交）。
 */
function buildPreview(data, csvText) {
  const rows = parseCsv(csvText).filter((r) => r.some((cell) => String(cell).trim() !== ''));
  if (rows.length === 0) throw httpError(400, 'CSV 文件为空');

  const header = rows[0].map((h) => String(h).trim());
  const col = {};
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    const idx = header.findIndex((h) => aliases.includes(h));
    if (idx !== -1) col[key] = idx;
  }
  const missing = [];
  if (col.name === undefined) missing.push('姓名');
  if (col.area === undefined) missing.push('目标区域');
  if (col.time === undefined) missing.push('时间');
  if (missing.length > 0) {
    throw httpError(400, `CSV 缺少必需表头：${missing.join('、')}（模板表头：姓名,角色,目标区域,时间,停留秒数,说明）`);
  }

  const dataRows = rows.slice(1);
  if (dataRows.length === 0) throw httpError(400, 'CSV 中没有数据行（第一行须为表头）');
  if (dataRows.length > MAX_ROWS) throw httpError(400, `单次最多导入 ${MAX_ROWS} 行，当前共 ${dataRows.length} 行`);

  // 区域名 → 区域列表（检测未知 / 重名）
  const areasByName = new Map();
  for (const a of data.areas) {
    const key = a.name.trim();
    if (!areasByName.has(key)) areasByName.set(key, []);
    areasByName.get(key).push(a);
  }
  // 姓名+角色 → 现有演员（重名演员取第一位，保持确定性）
  const existingActorByKey = new Map();
  for (const a of data.actors) {
    const key = actorKeyOf(a.name.trim(), (a.role || '').trim());
    if (!existingActorByKey.has(key)) existingActorByKey.set(key, a);
  }
  // 现有口令冲突键：演员 ID + 区域 ID + 时间
  const existingCueKeys = new Set(data.cues.map((c) => `${c.actorId}|${c.areaId}|${c.time}`));

  const seenInFile = new Map(); // 文件内重复键 → 首次出现的行号
  const newActorByKey = new Map(); // 计划新建的演员（按 姓名+角色 去重）
  const resultRows = [];

  dataRows.forEach((cells, i) => {
    const line = i + 2; // 表头占第 1 行，数据行从第 2 行起
    const get = (idx) => (idx === undefined ? '' : String(cells[idx] ?? '').trim());
    const name = get(col.name);
    const role = get(col.role);
    const areaName = get(col.area);
    const timeText = get(col.time);
    const dwellText = get(col.dwell);
    const note = get(col.note);
    const errors = [];

    // 姓名 / 角色 / 说明长度
    if (!name) errors.push('姓名不能为空');
    else if (name.length > MAX_NAME_LEN) errors.push(`姓名不能超过 ${MAX_NAME_LEN} 字`);
    if (role.length > MAX_ROLE_LEN) errors.push(`角色不能超过 ${MAX_ROLE_LEN} 字`);
    if (note.length > MAX_NOTE_LEN) errors.push(`说明不能超过 ${MAX_NOTE_LEN} 字`);

    // 时间格式
    let time = null;
    if (!timeText) {
      errors.push('时间不能为空');
    } else {
      const t = parseTimeInput(timeText);
      if (Number.isNaN(t)) errors.push(`时间格式不正确：「${timeText}」，支持秒数（如 90）或 mm:ss（如 01:30）`);
      else time = t;
    }

    // 停留时长格式（可空，缺省 0）
    let dwell = 0;
    if (dwellText) {
      if (!/^\d+$/.test(dwellText)) {
        errors.push(`停留时长格式不正确：「${dwellText}」，应为 0～${MAX_DWELL} 的整数秒`);
      } else {
        const d = parseInt(dwellText, 10);
        if (d > MAX_DWELL) errors.push(`停留时长必须是 0～${MAX_DWELL} 的整数秒`);
        else dwell = d;
      }
    }

    // 目标区域解析
    let areaId = null;
    let areaStatus = null;
    if (!areaName) {
      errors.push('目标区域不能为空');
    } else {
      const matches = areasByName.get(areaName) || [];
      if (matches.length === 0) {
        areaStatus = 'unknown';
        errors.push(`未知区域：「${areaName}」在舞台区域中不存在`);
      } else if (matches.length > 1) {
        areaStatus = 'ambiguous';
        errors.push(`重名区域：「${areaName}」匹配到 ${matches.length} 个同名区域，无法确定目标`);
      } else {
        areaStatus = 'ok';
        areaId = matches[0].id;
      }
    }

    // 演员复用：姓名+角色 完全一致才复用，否则计划新建
    const key = actorKeyOf(name, role);
    let actorAction = null;
    let actorId = null;
    if (name) {
      const existing = existingActorByKey.get(key);
      if (existing) {
        actorAction = 'reuse';
        actorId = existing.id;
      } else {
        actorAction = 'create';
        if (!newActorByKey.has(key)) newActorByKey.set(key, { key, name, role });
      }
    }

    // 文件内重复 + 与现有口令冲突（关键字段均有效时判定）
    if (name && areaId && time !== null) {
      const fileKey = `${key}|${areaId}|${time}`;
      if (seenInFile.has(fileKey)) {
        errors.push(`文件内重复：与第 ${seenInFile.get(fileKey)} 行相同（姓名+角色+区域+时间）`);
      } else {
        seenInFile.set(fileKey, line);
      }
      if (actorId && existingCueKeys.has(`${actorId}|${areaId}|${time}`)) {
        errors.push(`与现有口令冲突：${name} 在 ${fmtTimeText(time)} 已有该区域「${areaName}」的口令`);
      }
    }

    resultRows.push({
      line,
      name,
      role,
      areaName,
      timeText,
      dwellText,
      note,
      time,
      dwell,
      areaId,
      areaStatus,
      actorAction,
      actorId,
      errors,
    });
  });

  const errorRows = resultRows.filter((r) => r.errors.length > 0).length;
  const validRows = resultRows.length - errorRows;
  const validNewActorKeys = new Set(
    resultRows.filter((r) => r.errors.length === 0 && r.actorAction === 'create').map((r) => actorKeyOf(r.name, r.role))
  );
  const summary = {
    totalRows: resultRows.length,
    validRows,
    errorRows,
    newActors: validNewActorKeys.size,
    reusedActors: new Set(resultRows.filter((r) => r.errors.length === 0 && r.actorAction === 'reuse').map((r) => r.actorId)).size,
    newCues: validRows,
  };

  const dataVersion = computeDataVersion(data);
  // 存在错误行时禁止提交：不生成导入计划
  let plan = null;
  if (errorRows === 0 && validRows > 0) {
    plan = {
      dataVersion,
      newActors: [...validNewActorKeys].map((k) => newActorByKey.get(k)),
      cues: resultRows.map((r) => ({
        actorKey: actorKeyOf(r.name, r.role),
        actorId: r.actorId, // 复用现有演员时为现有 ID；新建演员为 null，提交时映射到新 ID
        areaId: r.areaId,
        time: r.time,
        dwell: r.dwell,
        note: r.note,
      })),
    };
  }

  return { dataVersion, rows: resultRows, summary, plan };
}

/**
 * 提交导入计划：先核对数据版本，再逐项复核计划内容（防御客户端篡改），
 * 全部通过后一次性写入全部新演员与口令；任何检查失败都不修改数据。
 * @returns {{ actors: number, cues: number }} 实际新增数量
 */
function applyPlan(data, plan) {
  if (!plan || typeof plan !== 'object') throw httpError(400, '缺少导入计划，请先上传预览');
  if (plan.dataVersion !== computeDataVersion(data)) {
    throw httpError(409, '底库数据已变化，导入计划失效，请重新上传预览后再提交');
  }
  const { newActors, cues } = plan;
  if (!Array.isArray(newActors) || !Array.isArray(cues) || cues.length === 0 || cues.length > MAX_ROWS) {
    throw httpError(400, '导入计划格式不正确，请重新预览');
  }

  // 复核计划与当前底库一致（版本一致时以下检查必然通过；不一致则要求重新预览）
  const stale = () => httpError(409, '导入计划与当前数据不一致，请重新上传预览后再提交');
  const areaIds = new Set(data.areas.map((a) => a.id));
  const actorById = new Map(data.actors.map((a) => [a.id, a]));
  const existingActorKeys = new Set(data.actors.map((a) => actorKeyOf(a.name.trim(), (a.role || '').trim())));
  const existingCueKeys = new Set(data.cues.map((c) => `${c.actorId}|${c.areaId}|${c.time}`));

  const newActorKeys = new Set();
  for (const a of newActors) {
    if (!a || typeof a.name !== 'string' || !a.name.trim() || a.name.trim().length > MAX_NAME_LEN) throw stale();
    if (typeof a.role !== 'string' || a.role.trim().length > MAX_ROLE_LEN) throw stale();
    const key = actorKeyOf(a.name.trim(), a.role.trim());
    if (a.key !== key || newActorKeys.has(key) || existingActorKeys.has(key)) throw stale();
    newActorKeys.add(key);
  }

  const planCueKeys = new Set();
  for (const c of cues) {
    if (!c || !areaIds.has(c.areaId)) throw stale();
    if (!Number.isInteger(c.time) || c.time < 0) throw stale();
    if (!Number.isInteger(c.dwell) || c.dwell < 0 || c.dwell > MAX_DWELL) throw stale();
    if (c.note !== undefined && c.note !== null && (typeof c.note !== 'string' || c.note.length > MAX_NOTE_LEN)) throw stale();
    if (typeof c.actorKey !== 'string') throw stale();
    if (c.actorId === null || c.actorId === undefined) {
      if (!newActorKeys.has(c.actorKey)) throw stale();
    } else {
      const actor = actorById.get(c.actorId);
      if (!actor || actorKeyOf(actor.name.trim(), (actor.role || '').trim()) !== c.actorKey) throw stale();
      if (existingCueKeys.has(`${c.actorId}|${c.areaId}|${c.time}`)) throw stale();
    }
    const cueKey = `${c.actorKey}|${c.areaId}|${c.time}`;
    if (planCueKeys.has(cueKey)) throw stale();
    planCueKeys.add(cueKey);
  }

  // 全部复核通过后才落库：先建演员并映射 姓名+角色 → 新 ID，再建口令，一次写入
  const newActorIdByKey = new Map();
  const createdActors = newActors.map((a) => {
    const actor = { id: crypto.randomUUID(), name: a.name.trim(), role: a.role.trim() };
    newActorIdByKey.set(actorKeyOf(actor.name, actor.role), actor.id);
    return actor;
  });
  const createdCues = cues.map((c) => ({
    id: crypto.randomUUID(),
    actorId: c.actorId ?? newActorIdByKey.get(c.actorKey),
    areaId: c.areaId,
    time: c.time,
    dwell: c.dwell,
    note: (c.note || '').trim(),
  }));

  data.actors.push(...createdActors);
  data.cues.push(...createdCues);
  return { actors: createdActors.length, cues: createdCues.length };
}

module.exports = {
  TEMPLATE_CSV,
  MAX_ROWS,
  MAX_CSV_CHARS,
  parseCsv,
  computeDataVersion,
  buildPreview,
  applyPlan,
};
