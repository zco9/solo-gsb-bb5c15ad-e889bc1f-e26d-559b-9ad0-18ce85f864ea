const path = require('path');
const express = require('express');
const store = require('./src/store');
const routes = require('./src/routes');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '2mb' }));
app.use('/api', routes);
app.use(express.static(path.join(__dirname, 'public')));

// API 404
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] 未处理异常:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

// 启动时初始化数据（数据文件不存在则写入示例数据）
store.load();

app.listen(PORT, () => {
  console.log(`舞台走位校验系统已启动: http://localhost:${PORT}`);
});
