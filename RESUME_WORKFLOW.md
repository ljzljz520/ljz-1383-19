# 岗位简历工作流 — 设计与验收说明

在静态个人站基础上增加「按岗位生成一页 PDF 简历」的完整工作流：
Web 端选择教育 / 技能 / 项目字段 → API 冻结内容与模板 → 数据库保存岗位版本、访问授权与渲染任务 →
后台用真实 Chromium 渲染 PDF → 渲染后做一页校验 → 受控分享链接。

## 1. 架构与数据流

```
resume.html (选择字段/草稿/生成物/分享管理)
      │  X-Admin-Key
      ▼
server/server.js ── 岗位(草稿+revision 乐观锁)
      │            ── 文档(冻结内容快照 + 渲染任务 + 检查报告)
      │            ── 分享(授权 token + 到期 + 撤销 + 访问记录)
      │            ── 导出回执(持久化，可重取)
      ▼
server/render/template.js  冻结后的 HTML 模板（A4，三档版式）
server/render/pdf.js       Puppeteer + 真实 Chromium：渲染 → 检查 → PDF
resume-data/db.json        JSON 持久化（写串行化、原子替换）
resume-data/artifacts/*.pdf
resume-data/snapshots/*.json  每次冻结的内容快照证据
```

- **冻结**：`POST /api/positions/:id/freeze`。从当前「源库」拷贝所选教育/技能/项目为**独立快照**，
  记录 `frozenAt` 与联系方式快照；之后源库如何增删改都不影响已冻结文档。
- **历史简历固定来源**：重新生成同一岗位时，只从该岗位**已选中的项目 id** 重新抓取最新文字，
  **不会**自动把源库新增项目塞进历史岗位。
- **岗位版本**：草稿用 `revision` 做乐观锁（`If-Match`），并行编辑第二个保存者收到 `409 revision-conflict`
  及服务器当前版本，前端展示冲突而非静默覆盖。两个不同岗位各自独立、可并行。

## 2. 一页校验：全部基于“渲染后真实测量”，禁止字符数估算

渲染后在 Chromium 内执行（`server/render/pdf.js#inPageChecks`）：

1. **溢出 / 裁切**：对每个含文本的叶子节点用 `Range.getClientRects()` 取实际渲染矩形，
   判断是否超出 A4 `#page` 内容区；并判断文本是否被 `overflow:hidden` 容器实际裁切
   （不依赖 `scrollHeight` 的亚像素误差，也不靠估算字数）。
2. **字体缺字**：先确认 `Noto Sans SC` 的 latin + CJK 两个子集面都 `status==='loaded'`，
   再对页面出现过的**每个去重字符**调用 `document.fonts.check()`。
   字体 CSS / 字体文件下载失败（HTTP 4xx/5xx、请求失败、面 error）一律记为硬失败。
3. **页数**：解析生成 PDF 字节（inflate 全部 FlateDecode 对象流）统计 `/Type /Page`，必须恰为 1 页。
4. **联系方式可读性**：对 `[data-required]` 的姓名与联系方式行校验实际字号（pt）、
   WCAG 对比度（≥4.5:1）、矩形完整位于页面内（未被裁切）。
5. **最小字号**：扫描所有可见叶子文字，任何低于 9pt 即失败。

字体由同源端点 `/__resume/fonts.css` 注入（Noto Sans SC，400/500/700，latin + chinese-simplified 子集），
渲染前显式 `face.load()`，避免 `@font-face` 懒加载导致的误报。

## 3. 自动压缩版式 vs 提示用户删减

| 版式档 | 正文 | 标题 | 姓名 | 行距/间距 |
|---|---|---|---|---|
| 1 | 10.5pt | 13pt | 22pt | 1.5 / 1.0× |
| 2 | 10pt | 12pt | 20pt | 1.4 / 0.78× |
| 3（最小） | **9pt** | 11pt | 18pt | 1.3 / 0.6× |

- **自动模式**：依次尝试 1→2→3，任一档通过全部检查即产出 PDF；
  到 9pt 仍溢出则返回 `NEED_MANUAL_TRIM` 与溢出报告，**停止压缩、提示用户删减**（去掉项目条目/技能组/教育）。
- **手动模式**：直接按 9pt 渲染一次，返回还超多少，由用户决定删什么。
- **硬约束**：
  - 最小正文字号 **9pt**（姓名/标题更大；次级元信息也用 `max(9, …)` 兜底，不允许 8.5pt）；
  - **不可裁切字段**：姓名、电话、邮箱 `white-space:nowrap; overflow:visible`，永不省略号、永不参与截断；
  - 任何字段都不允许被 `overflow:hidden` 切掉来“凑一页”。

## 4. 分享链接：服务器验证 + 两种信任模型

| | 受控下载代理（默认 7 天） | 独立签名直链（≤10 分钟） |
|---|---|---|
| URL | `/s/:token` 预览 + `/p/:token/pdf` | `/dl/:hmac` |
| 到期/撤销校验 | **每次请求查库** | 在线同样查库；但 HMAC **可离线验证**有效期 |
| 撤销生效 | **即时**（响应 `no-store`） | 在线访问立即拦；**有效期内已离线持有副本无法保证撤销** |
| 缓存 | `Cache-Control: no-store` | `private, max-age=<剩余秒数>`（明确缓存边界） |

关键事实（已在创建接口、`/meta`、预览页与管理台文案中显式告知）：
> **独立签名 URL 若在有效期内可离线验证，就不能声称“即时撤销”。**
> 因此签名直链只给短有效期（默认 300s、上限 600s）；需要即时撤销请使用受控下载代理。
> **已下载到本地的 PDF 无法远程收回**——任何模式都不承诺对已落盘副本的撤回能力。

- 撤销：`POST /api/shares/:id` → `revoked=true`；代理的旧链接随后返回 `410 revoked`，并有审计事件 `share-denied`。
- 篡改签名 → `403`；过期 → `410 expired`；伪造 token → `404`。

## 5. 页面状态区分（网页可见）

- **草稿**：岗位列表中的岗位（`revision` 标记），改动不影响已生成文档。
- **已生成**：文档卡片，含状态徽标 `生成中 / 已生成 / 失败`、所用版式档、渲染后检查报告、SHA256/字节数。
- **已分享**：分享 Tab 中 `生效中 / 已撤销 / 已过期` 徽标、到期时间、访问次数、撤销按钮。

## 6. 异常与运维语义

- **渲染中断**（进程重启）：启动时把停留在 `rendering` 的文档恢复为 `failed/INTERRUPTED`，记录不丢、可重试。
- **导出回执**：每次下载先把回执（id、时间、sha256、字节数、文件名）落库再返回，
  响应头 `x-receipt-id`；客户端回执丢失可用 `GET /api/documents/:id/receipts` 重取。
- **PDF 工件缺失**：下载接口返回 `409 artifact-not-ready`，提示重新生成，而不是给坏文件。

## 7. API 一览（均需 `X-Admin-Key`，公开访问接口除外）

```
GET   /api/sources
POST  /api/sources/projects/:id/visibility
GET/POST /api/positions ; GET/PATCH/DELETE /api/positions/:id   (PATCH 带 If-Match)
POST  /api/positions/:id/freeze            {mode:'auto'|'manual', simulateFontFail?}
GET   /api/documents ; /api/documents/:id
GET   /api/documents/:id/pdf               (响应头 x-receipt-id)
GET   /api/documents/:id/receipts
GET/POST /api/shares ; POST /api/shares/:id (撤销)
GET   /api/events
# 公开（无密钥）
GET   /s/:token                  预览页（到期/撤销服务器侧 410/404 阻挡页）
GET   /p/:token/meta             每次查库
GET   /p/:token/pdf              代理下载（仅 proxy 模式，no-store）
GET   /dl/:hmac                  签名直链（离线可验签，短有效期）
```

## 8. 验收

`npm test`（`test/acceptance.js`）以真实 HTTP + 真实 Chromium 覆盖：

0. 正常一页：PDF 实际 1 页、0 溢出、0 缺字、最小字号、联系方式、工件落盘；
1. **源作品在渲染中变私密**：已冻结文档照常且保留快照项目；新冻结排除该私密源；
2. **字体下载失败**：`FONT_UNAVAILABLE` 阻断，不产出 PDF，报告含 `missing-glyph`；
3. **两个岗位并行编辑**：同岗位并发第二保存 409 带服务器版本；不同岗位互不阻塞；
4. **导出回执丢失**：服务端持久化、可重取、sha256 与响应头一致；
5. **撤销后旧链接访问**：代理即时 410、伪造 404；签名直链在线 410、但离线验签有效期内仍通过（验证“不能声称即时撤销”）、过期 410、篡改 403；
6. 自动压缩 1→2→3 → `NEED_MANUAL_TRIM`；手动档一次；删减后通过；全程 9pt 底线与联系方式不裁切；
7. **历史固定来源**：源改字/新增项目后，旧快照不变；新版本反映新文字但不自动纳入新增项目；
8. 渲染中断重启后恢复为 `INTERRUPTED`。

## 9. 本地运行

```bash
npm install
# 真实 Chromium 由 puppeteer 下载；如为 arm64 环境需安装对应平台 Chrome，
# 并用 CHROME_PATH 或 server/chrome-wrapper.sh 指定（含依赖库 LD_LIBRARY_PATH）。
ADMIN_KEY=你的密钥 npm start          # 默认 http://127.0.0.1:3000
npm test                              # 验收（临时数据目录与端口，互不影响）
```

环境变量：`PORT`、`ADMIN_KEY`、`RESUME_DATA_DIR`（数据目录）、`CHROME_PATH`、`RENDER_DELAY_MS`（测试用）。
