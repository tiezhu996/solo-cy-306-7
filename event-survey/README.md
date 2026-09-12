# 活动问卷反馈系统（event-survey）

组织者为活动创建反馈问卷（单选 / 多选 / 文本题，可设必填），活动**发布后**问卷才开放；
只有**已报名**的参与者可以提交，且**每人只能提交一次**——未报名、重复提交、未发布都会被拒绝。
组织者可在结果看板查看**提交人数**、**各选项人数分布**和**全部文本答案**。

零外部依赖：后端使用 Node.js 内置 `http` 模块，数据以 JSON 文件持久化（写入即落盘，可回读）；
前端为原生 HTML/CSS/JS 单页应用，由同一服务托管。Node.js ≥ 18 即可运行。

## 快速启动

```bash
npm run seed     # 可选：写入演示账号和一个草稿示例活动
npm start        # 默认 http://localhost:3000
```

启动后浏览器访问 http://localhost:3000 。

可通过环境变量自定义：

```bash
PORT=8080 HOST=127.0.0.1 DATA_DIR=/var/lib/event-survey npm start
```

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| PORT | HTTP 端口 | 3000 |
| HOST | 监听地址 | 0.0.0.0 |
| DATA_DIR | JSON 数据文件目录 | 项目下 `data/` |
| TOKEN_SECRET | 令牌 HMAC 签名盐（生产请覆盖） | 内置开发默认值 |

## 演示账号（执行 npm run seed 后）

| 用户名 | 密码 | 角色 | 用途 |
| --- | --- | --- | --- |
| organizer | Org@1234 | 组织者 | 建问卷、发布、查看结果 |
| alice | User@1234 | 参与者 | 报名并提交问卷 |
| bob | User@1234 | 参与者 | 默认未报名，用于验证「未报名拒绝」 |

预置活动 `2026 秋季技术沙龙` 为**草稿**状态，登录 organizer 后可在「我的活动 → 编辑问卷 → 保存并发布」。

## 页面流程

**组织者**
1. 注册/登录组织者账号 → 「＋ 新建活动问卷」
2. 在编辑器中添加单选、多选、文本题，勾选必填，维护选项
3. 保存为草稿（可反复改）→「保存并发布」；发布后问卷题目锁定
4. 在「结果看板」查看报名人数、提交人数、提交率、每题选项人数分布条形图与文本答案列表

**参与者**
1. 注册/登录参与者账号 → 在「活动列表」查看已发布活动
2. 活动详情页点「报名该活动」→「去填写问卷」
3. 必填项未答或选项非法时前端/后端都会拒绝；提交成功后显示「已提交」，再次进入只能查看不能重交
4. 「我的报名」集中查看所有活动的报名与提交状态

## 核心业务规则

| 场景 | 结果 |
| --- | --- |
| 活动为草稿时访问问卷/报名/提交 | 拒绝（问卷发布后才开放） |
| 未报名用户提交问卷 | `403 NOT_REGISTERED` |
| 同一用户第二次提交 | `409 ALREADY_SUBMITTED` |
| 必答题未作答 / 选择不存在的选项 | `400 ANSWER_REQUIRED / INVALID_OPTION` |
| 多选题答案不是数组（如误传字符串） | `400 INVALID_ANSWER_FORMAT`（空数组对选填题按未作答处理） |
| 参与者调用组织者接口（建活动/发布/看结果） | `403 FORBIDDEN` |
| 活动发布后修改问卷题目 | `409 EVENT_ALREADY_PUBLISHED`（题目锁定） |

## API 清单

统一响应格式：`{ "code": 0, "message": "ok", "data": ... }`；鉴权使用
`Authorization: Bearer <token>`。

### 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | /api/auth/register | 注册并登录，body：`{username, password, nickname, role}`，role 为 `organizer`/`participant` |
| POST | /api/auth/login | 登录，返回 `{token, user}` |
| POST | /api/auth/logout | 登出，服务端令牌失效 |
| GET | /api/auth/me | 当前登录用户 |

### 活动与问卷

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | /api/events | 公开 | 已发布活动列表 |
| GET | /api/events/mine | 组织者 | 我创建的活动（含草稿） |
| POST | /api/events | 组织者 | 创建活动（草稿）+ 问卷题目 |
| GET | /api/events/:id | 登录 | 活动详情与问卷题目（草稿仅创建者可见） |
| PUT | /api/events/:id | 组织者（本人，仅草稿） | 编辑活动/问卷 |
| POST | /api/events/:id/publish | 组织者（本人） | 发布活动，问卷开放、题目锁定 |

题目对象：`{ type: "single" | "multi" | "text", title, required, options: ["选项A","选项B"] }`
（文本题不传 options）。

### 报名与提交

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | /api/events/:id/register | 参与者 | 报名；未发布拒绝，重复报名 `409` |
| GET | /api/registrations/mine | 参与者 | 我的报名及提交状态 |
| GET | /api/events/:id/my-submission | 参与者 | 报名/问卷开放/已提交状态 |
| POST | /api/events/:id/submissions | 已报名参与者 | 提交问卷，body：`{ answers: { 题目id: 答案 } }`，每人一次 |
| GET | /api/events/:id/results | 组织者（本人） | 结果看板数据 |

答案格式：单选题传选项 id（字符串）；多选题传选项 id 数组；文本题传字符串。

结果看板 `data` 结构：

```json
{
  "registeredCount": 2,
  "submissionCount": 2,
  "event": { "id": "evt_...", "title": "...", "status": "published", "...": "..." },
  "questions": [
    { "questionId": "que_...", "type": "single", "answeredCount": 2,
      "options": [ { "optionId": "opt_...", "label": "满意", "count": 2 } ] },
    { "questionId": "que_...", "type": "multi", "answeredCount": 2,
      "options": [ { "optionId": "opt_...", "label": "前端", "count": 2 } ] },
    { "questionId": "que_...", "type": "text", "answeredCount": 1,
      "textAnswers": [ { "userId": "usr_...", "nickname": "爱丽丝", "value": "...", "submittedAt": "..." } ] }
  ]
}
```

## 测试

```bash
npm test          # 冒烟测试 + 可重复测试套件（任一失败即非零退出）
npm run test:smoke # 仅冒烟测试（test/smoke.js，60 项断言）
npm run test:suite # 仅可重复测试套件（test/suite.js，8 组 104 项断言）
ONLY=T7 npm run test:suite   # 按组名过滤，只跑某一组
```

- `test/smoke.js`：端到端冒烟，覆盖一条完整业务主线（建问卷 → 草稿拒绝 →
  发布 → 未报名拒绝 → 报名 → 必填/非法选项 → 提交 → 重复拒绝 → 统计 → 落盘重启回读）。
- `test/suite.js`：**可重复**的独立测试套件，每组用例使用随机账号、独立临时
  数据目录、动态空闲端口和全新服务实例，互不影响；结束自动清理（失败时保留
  临时目录便于排查），进程退出码独立反映通过/失败，可连续稳定运行。覆盖：
  - **T1 多人同时提交**：8 人并发提交，结果聚合（单选/多选分布、文本回收、磁盘记录）正确
  - **T2 重复提交**：串行重复 + 同用户 6 个并发竞争请求，恰好只成功一次
  - **T3 拒绝路径**：未报名 403、未登录/伪造令牌 401、错误角色 403，且拒绝不入库
  - **T4 草稿/发布切换**：草稿可见性与锁定、越权操作拒绝、重复发布拒绝、发布后流程打通
  - **T5 必填与非法选项**：null/空数组/非数组/空白/超长/不存在选项，以及问卷建模校验
  - **T6 登出失效**：登出后原令牌立即 401、重登不影响、篡改签名 401
  - **T7 重启回读**：状态/计数/分布/文本/一次性约束跨进程保持，草稿可继续编辑
  - **T8 异常中断**：垃圾 `.tmp` 残留不影响启动与写入；3 轮提交洪峰中 SIGKILL，
    验证主数据文件永不半写、**已 ack 的提交必已落盘**、重启后计数自洽无重复

## 目录结构

```
event-survey/
├── package.json
├── README.md
├── data/                        # JSON 持久化（运行后生成，已 gitignore）
│   ├── users.json
│   ├── events.json              # 活动 + 问卷题目
│   ├── registrations.json       # 报名记录
│   ├── submissions.json         # 问卷提交
│   └── tokens.json              # 有效登录令牌
├── src/
│   ├── server.js                # HTTP 入口：路由分发、统一错误处理、静态托管
│   ├── config.js                # 环境变量配置
│   ├── store.js                 # JSON 文件存储（内存缓存 + 原子写落盘）
│   ├── auth.js                  # HMAC 令牌签发/校验、密码哈希
│   ├── http-util.js             # JSON 收发、鉴权、错误对象、SPA 托管
│   ├── util.js
│   ├── seed.js                  # 演示数据
│   ├── routes.js                # 全部 API 路由
│   └── services/
│       ├── user-service.js
│       ├── event-service.js     # 活动/问卷 CRUD、题目校验、发布、锁定
│       ├── registration-service.js
│       └── submission-service.js# 提交规则（开放/报名/一次性/必填）+ 结果统计
├── public/
│   ├── index.html               # 单页应用
│   ├── styles.css
│   └── app.js                   # hash 路由 + 所有页面（列表/编辑器/问卷/结果看板）
└── test/
    ├── smoke.js                 # 端到端冒烟测试
    └── suite.js                 # 可重复测试套件（8 组，独立判定）
```

## 说明与边界

- 单进程演示架构：JSON 存储适合单机/小流量场景；每次写入整集合原子落盘（临时文件 + rename）。
  如需水平扩展可将 `store.js` 替换为数据库实现，服务层接口不变。
- 密码使用 salt + 多轮 SHA-256 存储（非明文）；令牌为 HMAC-SHA256 签名、带过期时间，登出即失效。
  生产部署请设置随机 `TOKEN_SECRET` 并置于 HTTPS 之后。

## License

MIT
