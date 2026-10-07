// 简单 JSON 文件持久化（个人站单进程足够），带写互斥
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.RESUME_DATA_DIR ? path.resolve(process.env.RESUME_DATA_DIR) : path.join(__dirname, '..', 'resume-data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let cache = null;
let chain = Promise.resolve();

function ensureDirs() {
  for (const d of ['', 'artifacts', 'snapshots']) {
    fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
  }
}

function seed() {
  const now = new Date().toISOString();
  return {
    meta: { createdAt: now },
    sources: {
      contact: {
        name: '林知远',
        phone: '138-0000-1234',
        email: 'lin.zhiyuan@example.com',
        site: 'https://linzhiyuan.example.com',
      },
      educations: [
        { id: 'edu-1', school: '华东理工大学', degree: '本科', major: '软件工程', period: '2015-09 至 2019-06' },
        { id: 'edu-2', school: '上海交通大学', degree: '硕士', major: '计算机技术', period: '2019-09 至 2022-03' },
      ],
      skills: [
        { id: 'sk-fe', group: '前端工程', items: 'JavaScript / TypeScript、Vue、React、Vite、CSS 架构' },
        { id: 'sk-node', group: '后端与平台', items: 'Node.js、PostgreSQL、Redis、REST / OpenAPI、消息队列' },
        { id: 'sk-design', group: '设计与协作', items: 'Figma、设计系统、可访问性、Code Review、敏捷协作' },
        { id: 'sk-ops', group: '工程效能', items: 'CI/CD、Docker、可观测性、灰度发布' },
      ],
      projects: [
        { id: 'pj-neo', title: 'Neo-Finance 理财工作台', role: '前端负责人', period: '2023-03 至 2024-12', visibility: 'public',
          bullets: ['主导交易看板重构，首屏渲染从 3.8s 降至 1.1s', '搭建组件库与设计令牌体系，复用率提升 60%', '推动前端异常监控接入，线上故障定位时间缩短 70%'] },
        { id: 'pj-solar', title: 'Solar 光伏运维监控平台', role: '全栈工程师', period: '2022-04 至 2023-02', visibility: 'public',
          bullets: ['设计设备实时数据管线，支撑 2 万+ 测点秒级刷新', '实现告警规则引擎与工单联动，误报率下降 35%'] },
        { id: 'jp-ui', title: '企业级 UI 设计系统', role: '核心贡献者', period: '2021-09 至 2022-03', visibility: 'public',
          bullets: ['维护 80+ 基础组件的无障碍与主题能力', '建立视觉回归测试，阻断 12 次样式回归事故'] },
        { id: 'pj-ops', title: '前端发布平台', role: '独立开发', period: '2020-06 至 2021-08', visibility: 'private',
          bullets: ['集成多环境灰度、回滚与变更审计', '把单次发布平均耗时从 25 分钟压缩到 4 分钟'] },
      ],
    },
    positions: [],
    documents: [],
    shares: [],
    receipts: [],
    events: [],
  };
}

function load() {
  if (cache) return cache;
  ensureDirs();
  if (fs.existsSync(DB_FILE)) {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } else {
    cache = seed();
    flush();
  }
  return cache;
}

function flush() {
  ensureDirs();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// 所有写操作串行化，读永远拿当前内存快照
async function mutate(fn) {
  const res = await chain.then(() => fn(load()));
  flush();
  return res;
}

function resetForTests() {
  cache = seed();
  flush();
  return cache;
}

function receiptsList() {
  return load().receipts || (load().receipts = []);
}

module.exports = { load, mutate, flush, resetForTests, DATA_DIR };
