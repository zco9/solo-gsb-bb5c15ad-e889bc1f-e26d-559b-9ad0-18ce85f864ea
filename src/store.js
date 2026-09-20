const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const SEED_FILE = path.join(__dirname, '..', 'seed', 'sample-data.json');

let cache = null;

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.copyFileSync(SEED_FILE, DATA_FILE);
    console.log('[store] 数据文件不存在，已用示例数据初始化:', DATA_FILE);
  }
}

/** 规整数据结构：补齐缺失的集合与基线存储（兼容旧版数据文件） */
function normalize(data) {
  for (const key of ['areas', 'edges', 'actors', 'cues', 'dependencies']) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  // 清理历史残留：依赖任一端口令不存在（如手工编辑过数据文件）时直接丢弃
  const cueIds = new Set(data.cues.map((c) => c.id));
  data.dependencies = data.dependencies.filter(
    (d) => d && cueIds.has(d.predecessorId) && cueIds.has(d.successorId)
  );
  // baselines: { [mode]: { savedAt, result } }，基线随数据持久化
  if (!data.baselines || typeof data.baselines !== 'object' || Array.isArray(data.baselines)) {
    data.baselines = {};
  }
  return data;
}

function load() {
  if (!cache) {
    ensureDataFile();
    cache = normalize(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  }
  return cache;
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2) + '\n');
}

function reset() {
  cache = normalize(JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')));
  // 恢复示例数据后基线失去对应关系，一并清空
  cache.baselines = {};
  save();
  return cache;
}

module.exports = { load, save, reset };
