# 岗位简历工作流（Position-targeted Resume Workflow）

为个人站新增的“按岗位定制一页简历”全栈工作流：Web 端勾选教育/技能/项目 → API **冻结内容与模板** →
数据库保存岗位版本、访问授权与渲染任务 → 后台用真实浏览器生成 PDF，并在**渲染之后**检查
溢出、字体缺字与联系方式可读性（不是按字符数估算）。

## 运行

```bash
cd server
npm install
npx playwright install chromium          # 首次需要
# 无 root 的精简 Debian：系统库已用 apt-get download 解包到 .local-libs，run.sh 会自动注入
./run.sh                                  # 或 npm start（需自行保证 chromium 依赖可用）
# 打开 http://localhost:4178/resume.html ，Token 默认 dev-owner-token-2026（用环境变量 OWNER_TOKEN 覆盖）
npm test                                  # 16 项端到端验收（需先启动服务器）
```

关键环境变量：`PORT`、`OWNER_TOKEN`、`SERVER_SECRET`（缺省时自动生成并持久化到 `data/secret.key`；
轮换它会让所有离线签名链接立即失效）、`FONT_FETCH_TIMEOUT_MS`、`RENDER_CONCURRENCY`。

## 架构与数据流

```
resume.html + js/resume.js
        │  Bearer Token（owner）
        ▼
src/http.js ── REST API、静态白名单、受控代理 /s/:token、离线签名 /signed/pdf、机主 /dl/:ticket
        │
        ├── src/content.js     按 source_ids 冻结快照（可见性校验 + 固定来源 + 固定模板版本）
        ├── src/db.js          better-sqlite3：sources / resumes / resume_versions /
        │                      render_tasks / shares / share_access / download_tickets
        ├── src/worker.js      后台任务队列（并发 2），出 PDF 前再次复核来源可见性
        └── src/render/
              fonts.js         打包字体 + 远程字体下载（超时即 FONT_LOAD_FAILED）+ fontkit cmap 缺字检测
              template.js      唯一冻结模板 onepage-v1，排版变量全部来自 level
              checker.js       浏览器内：逐元素溢出 / 逐字符光栅化缺字 / 联系方式字号·对比比·机读性
              renderer.js      4 级自动压缩 → 真实 PDF → 数 PDF 实际页数（必须恰为 1）
```

## 冻结模型（历史简历使用固定来源）

- 每个岗位（resume）有多个不可变版本（resume_versions）；创建/另存时把所选来源的标题、正文、标签
  **深拷贝进 snapshot**，并记录 `template_id@template_version`。
- 之后来源改标题、改内容、新增项目，都**不会**影响历史版本；渲染只读 snapshot。
- 可见性是安全维度：冻结时与**出 PDF 前**各校验一次；任一来源被转私密/删除，渲染失败
  `SOURCE_NOT_VISIBLE`，受控代理链接立即 410（离线签名模式的边界见下）。
- 两个岗位并行编辑同一简历用 `expected_version` 乐观锁，过期提交返回 409，不互相覆盖。

## 一页硬约束（渲染后检查，非字符数估计）

| 约束 | 下限 |
|---|---|
| 姓名 | ≥ 15pt |
| 目标岗位 / 公司 / 区块标题 | ≥ 10.5pt |
| 联系方式（邮箱/电话） | ≥ 9pt |
| 正文 | ≥ 9pt |
| 行距 / 页边距 / 区块间距 | ≥ 1.28 / ≥ 9mm / ≥ 4pt |
| 正文对比比 | ≥ WCAG AA 4.5 |

- **不可裁切字段**：姓名、邮箱、电话、目标岗位、公司。任何情况下系统都不删除、缩写或截断它们。
- **自动压缩版式 vs 提示删减**：`strategy=auto` 依次尝试 4 级（仅调字号/行距/留白/间距，绝不删内容）；
  到达最小字号与最小留白后仍超一页，任务置为 `need_trim`，返回具体删减建议，等待用户改选。
  `strategy=manual` 不压缩，放不下直接 `OVERFLOW_MANUAL`。
- 检查项：① 逐元素 `getBoundingClientRect` 是否越界/被裁切、容器总高；② 生成**真实 PDF 后数页数**，
  必须恰为 1；③ fontkit 逐码点核对 cmap **且**浏览器内逐字符 canvas 光栅化（alpha 全 0 即 .notdef 缺字）；
  ④ 联系方式最小字号、对比比、未被遮挡/裁切，邮箱必须 `mailto:`、电话必须 `tel:` 且文本一致。

## 分享、撤销与缓存边界

| 模式 | 链接 | 校验 | 撤销 | 缓存 |
|---|---|---|---|---|
| **受控代理**（默认） | `/s/:token[/dl]` | **每次访问回服务器**校验撤销/到期/来源可见性 | **即时** 410 | `Cache-Control: no-store` |
| **离线签名短链** | `/signed/pdf?v=&exp=&sig=` | HMAC + 到期，**有效期内可离线验证，不查库** | **有效期内不能即时撤销**；紧急撤回需轮换 `SERVER_SECRET`（全体签名链作废） | 仅短缓存 `private, max-age<=ttl(≤900s), must-revalidate` |

- 签名模式默认 15 分钟（可 60s–24h）；UI 与接口都会明确标注“不能即时撤销”。
- **已下载到本地的 PDF 不承诺远程收回**——服务器只能停止继续分发（代理 410 / 签名到期 / 票据失效）。
- 机主下载走一次性票据 `/dl/:ticket`：60 秒有效、用后即焚、`no-store`。

## API 摘要（`/api`，除健康检查外都要 `Authorization: Bearer <OWNER_TOKEN>`）

- `GET  /sources` · `PATCH /sources/:id {visible}`
- `POST /resumes` · `GET /resumes` · `GET /resumes/:id`
- `POST /resumes/:id/versions {expected_version,...}` → 409 版本冲突
- `GET  /versions/:id` · `GET /versions/:id/tasks`
- `POST /versions/:id/render {strategy,level,idempotency_key}` → 202 任务
- `GET  /tasks/:id`（含 checks 与 receipt）· `GET /tasks/by-key/:idempotency_key`
- `POST /versions/:id/share {mode:'proxy'|'signed',ttl_seconds}`
- `GET  /shares` · `POST /shares/:token/revoke` · `GET /shares/:token/access`
- `POST /versions/:id/download-ticket`
- 公开：`GET /s/:token[/dl]`、`GET /signed/pdf`、`GET /dl/:ticket`

导出回执丢失：渲染请求带 `idempotency_key`，网络重试或 `GET /tasks/by-key/:key` 都能幂等取回同一任务/回执。

## 验收覆盖（`test/acceptance.test.js`，串行 16 项）

私密来源拒绝冻结、渲染排队中转私密、字体下载失败不出 PDF、两个岗位并行编辑 409、
导出回执幂等找回、代理撤销/到期 410、签名篡改 403/过期 410/有效期内撤销无效（边界自证）、
一页溢出 need_trim + 建议且不裁字段、PDF 真实 1 页与最小字号、emoji 缺字 GLYPH_MISSING、
草稿/已生成/已分享三态、一次性下载票、分享后作品转私密旧链 410、未授权与静态白名单。
