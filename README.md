# 个人创意主页 - 技术说明文档

本项目是一个现代化的个人主页系统，采用 3 级页面架构，旨在展示个人的技术见解、兴趣爱好及专业作品。

## 项目特点

1.  **现代化视觉设计**：采用流行的 "Glassmorphism" (毛玻璃) 风格，结合动态渐变背景和丝滑的微动画，提供极佳的视觉体验。
2.  **3 级导航结构**：
    *   **Level 1**: 首页 (`index.html`) - 整体概览。
    *   **Level 2**: 列表页 (`hobbies.html`, `portfolio.html`, `contact.html`) - 分类展示。
    *   **Level 3**: 详情页 (`hobby-detail.html`, `work-detail.html`) - 深度内容。
3.  **自定义交互系统**：弃用原生 `alert`，开发了基于 Vanilla JS 的 Toast 通知系统，用于表单验证反馈和交互提示。
4.  **纯净技术栈**：仅使用 HTML5, CSS3 和原生 JavaScript，无需任何外部框架。

## 文件结构

- `index.html`: 入口首页
- `hobbies.html`: 兴趣爱好列表 (L2)
- `hobby-detail.html`: 摄影兴趣详情 (L3)
- `portfolio.html`: 作品集列表 (L2)
- `work-detail.html`: Neo-Finance 应用案例 (L3)
- `contact.html`: 联系表单页 (L2)
- `css/style.css`: 全局样式表
- `js/main.js`: 交互逻辑与表单验证
- `images/`: 项目多媒体资源

## 技术要点

- **CSS 选择器**：广泛使用伪类 (`:hover`, `:focus`), 子选择器及复杂层叠关系。
- **盒模型布局**：利用 Flexbox 和 CSS Grid 实现响应式布局。
- **表单验证**：实时检测用户输入，并通过自定义 UI 组件进行错误提示。

## 岗位简历工作流（新增）

- 页面：`resume.html` + `js/resume.js`（导航“岗位简历”入口），可按岗位勾选教育/技能/项目，
  并区分 **草稿 / 已生成 / 已分享** 三种版本状态。
- 后端：`server/`（Node + better-sqlite3 + Headless Chromium）。API 冻结内容与固定模板
  `onepage-v1`，数据库保存岗位版本、访问授权（受控代理 / 离线签名）、渲染任务与导出回执，
  后台真实渲染一页 PDF。
- 渲染后强制检查（非字符数估算）：逐元素溢出、生成 PDF 后核对实际页数必须为 1、
  fontkit cmap + 浏览器逐字符光栅化双重缺字检测、联系方式最小字号/对比比/mailto·tel 机读性。
- 自动压缩只在 4 级版式内调整，绝不裁切/删除字段；到最小字号（姓名 15pt、联系方式/正文 9pt 等）
  仍超一页则返回删减建议。分享默认用可即时撤销的受控代理（no-store）；离线签名短链仅短有效期，
  且不声称可即时撤销。**已下载的 PDF 不承诺远程收回。**
- 启动与 16 项端到端验收见 `server/README.md`（`cd server && ./run.sh`，另开 `npm test`）。
