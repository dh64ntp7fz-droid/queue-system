# 湘阁里辣 · 等位拿号叫号系统 V1.0

> 基于包间预订系统 V2.0 架构开发，技术栈、账号、数据库、通知体系完全复用。

---

## 一、系统概述

### 1.1 功能定位
- **线上扫码取号**（A号段）：顾客手机扫码自助取号，接收叫号通知
- **前台现场取号**（B号段）：前台工作人员代客取号，自动打印排队小票
- **叫号管理**：叫号 → 短信+企微通知 → 3分钟超时自动过号 → 标记入座
- **实时同步**：SSE推送，多终端页面数据自动刷新
- **数据归档**：7天以上数据自动迁移至历史表，支持CSV导出

### 1.2 技术栈
| 层级 | 技术 | 说明 |
|------|------|------|
| 前端 | HTML + CSS + JS（原生） | 与预订系统UI完全一致 |
| 后端 | Node.js + Express | 端口 3457 |
| 数据库 | Supabase | 复用预订系统同一项目 |
| 部署 | Render | 自动保活（每10分钟ping） |
| 实时 | SSE (EventSource) | 多终端自动同步 |
| 通知 | 腾讯云SMS + 企微Webhook | 复用预订系统模板和配置 |

---

## 二、数据库设计

### 2.1 新增表：queue（排队主表）

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 唯一ID，格式 `q_xxxxxxxxxxxx` |
| `store_id` | TEXT NOT NULL | 门店ID，对应 stores 表 |
| `queue_number` | TEXT NOT NULL | 号数，如 A001、B015 |
| `type` | CHAR(1) | A=线上扫码，B=现场取号 |
| `daily_seq` | INTEGER | 当日自动递增序号 |
| `name` | TEXT NOT NULL | 顾客姓名/姓氏 |
| `phone` | TEXT | 手机号码 |
| `people` | INTEGER | 用餐人数 |
| `note` | TEXT | 备注/特殊需求 |
| `status` | TEXT | waiting/called/seated/skipped/cancelled |
| `called_at` | TIMESTAMPTZ | 最近叫号时间 |
| `called_count` | INTEGER | 叫号次数 |
| `seated_at` | TIMESTAMPTZ | 入座时间 |
| `created_by` | TEXT | 操作人（用户名或 "scan"） |
| `created_at` | TIMESTAMPTZ | 创建时间 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |
| `archived_at` | TIMESTAMPTZ | 归档时间 |

### 2.2 历史归档表：queue_history

字段与 queue 一致，用于存储超过7天的历史数据。

### 2.3 状态流转

```
waiting（等位中）
   ↓ 叫号
called（已叫号）
   ↓ 入座              ↓ 3分钟超时
seated（已入座）       skipped（已过号）

任意状态 → cancelled（已取消）
```

### 2.4 复用表（无需新建）

- `stores` — 门店信息
- `users` — 用户账号
- `tokens` — 登录令牌
- `meta` — 门店配置（企微、电话、导航、停车）

---

## 三、API 接口文档

### 3.1 认证接口（复用）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/login` | 公开 | 登录，返回 token |
| GET | `/api/me` | 登录 | 获取当前用户信息 |
| GET | `/api/stores` | 公开 | 获取门店列表 |

### 3.2 排队 CRUD

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/store/:storeId/queue?date=YYYY-MM-DD` | 公开 | 查询排队列表 |
| POST | `/api/store/:storeId/queue` | 登录 | 创建排队（前台取号） |
| POST | `/api/store/:storeId/scan-queue` | 公开 | 线上扫码取号 |
| POST | `/api/store/:storeId/queue/:id/call` | 登录 | 叫号 |
| POST | `/api/store/:storeId/queue/:id/seat` | 登录 | 标记入座 |
| POST | `/api/store/:storeId/queue/:id/skip` | 登录 | 标记过号 |
| POST | `/api/store/:storeId/queue/:id/cancel` | 登录 | 取消排队 |

### 3.3 历史 & 导出

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/store/:storeId/queue/history` | 登录 | 历史记录 |
| GET | `/api/store/:storeId/queue/export` | 登录 | 单店CSV导出 |
| GET | `/api/admin/queue/export` | 管理员 | 全店CSV导出 |

### 3.4 管理员

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/admin/queue/unified?date=YYYY-MM-DD` | 管理员 | 全店统一视图 |

### 3.5 顾客扫码

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/store/:storeId/info` | 公开 | 门店信息 |
| GET | `/api/queue/status/:queueNumber` | 公开 | 查询排队状态 |

### 3.6 实时推送

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| GET | `/api/events` | 公开 | SSE事件流 |

SSE 事件类型：`queue_update`（action: created/called/seated/skipped/cancelled）

---

## 四、蓝牙打印小票

### 4.1 小票模板（58mm热敏纸）

```
┌─────────────────────┐
│     湘阁里辣        │
│   大朗环球店        │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│       A001          │
│    线上扫码         │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│ 顾客: 张先生        │
│ 人数: 3人           │
│ 手机: 138****1234   │
│ 备注: 无            │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│ 取号: 06-15 18:30   │
│ 请您耐心等待        │
│ 过号需重新取号      │
├─ ─ ─ ─ ─ ─ ─ ─ ─ ─┤
│   感谢您的光临      │
└─────────────────────┘
```

### 4.2 使用方式

系统支持三种打印方式：

**方式一：Web Bluetooth API（推荐）**
1. Windows 电脑开启蓝牙，配对热敏打印机
2. 浏览器打开系统页面（需 Chrome/Edge）
3. 创建排队后自动触发蓝牙连接弹窗
4. 选择打印机设备，点击配对
5. 后续每次取号自动打印

**方式二：浏览器打印窗口**
1. 将热敏打印机设为 Windows 默认打印机
2. 系统自动弹出打印窗口 → 自动打印
3. 无需额外配置，兼容性最好

**方式三：手动重打**
- 每个排队卡片都有「🖨 重打」按钮
- 点击即可重新弹出打印窗口

### 4.3 热敏打印机推荐型号
- 芯烨 Xprinter XP-58IIH（USB+蓝牙）
- 佳博 GP-58MB（蓝牙版）
- 容大 RP58（蓝牙版）

### 4.4 蓝牙配对步骤（Windows）
1. 开启打印机电源
2. Windows 设置 → 蓝牙和其他设备 → 添加设备
3. 选择打印机 → 配对（PIN码通常为 0000 或 1234）
4. 配对成功后，设为默认打印机
5. 在浏览器中测试打印

---

## 五、本地调试 & 线上部署

### 5.1 环境变量

创建 `.env` 文件（本地调试用）：

```bash
PORT=3457
SUPABASE_URL=https://ieidvazvzulsrfopjvyf.supabase.co
SUPABASE_KEY=你的Supabase服务密钥
SMS_SECRET_ID=腾讯云短信SecretId
SMS_SECRET_KEY=腾讯云短信SecretKey
SMS_SDK_APP_ID=短信应用ID
SMS_SIGN_NAME=湘阁里辣
SMS_TEMPLATE_ID=短信模板ID
WECOM_WEBHOOK_URL=企微机器人Webhook地址
```

### 5.2 数据库初始化

在 [Supabase SQL Editor](https://supabase.com/dashboard/project/ieidvazvzulsrfopjvyf/sql) 中执行：

```bash
# 复制 supabase_queue_setup.sql 全部内容，粘贴执行
```

### 5.3 本地调试

```bash
cd /Users/johnny/queue-system
npm install
node server.js
# 顾客扫码取号: http://localhost:3457
# 管理面板:      http://localhost:3457/admin
```

### 5.4 Render 部署

```bash
# 推送代码到 GitHub
cd /Users/johnny/queue-system
git push
# Render 自动部署（已关联 GitHub 仓库）
```

| 入口 | 地址 |
|------|------|
| 🏠 顾客扫码取号 | https://queue-system-zimj.onrender.com/ |
| 🔐 管理面板 | https://queue-system-zimj.onrender.com/admin |

> ⚠️ Render 免费服务 15 分钟无访问会自动休眠，已配置每 10 分钟自动保活 ping。

---

## 六、系统操作手册

### 6.1 前台操作

#### 登录
- 打开系统页面，使用门店账号登录（同预订系统账号）

#### 现场取号
1. 点击顶部「＋ 现场取号」按钮
2. 填写：用餐人数、顾客姓名、手机号（选填）、备注（选填）
3. 号段默认 B 开头（现场），也可手动选 A
4. 点击「确认取号」
5. 系统自动：
   - 生成排队号（如 B001）
   - 弹出打印窗口打印小票
   - 卡片出现在「现场取号」区域

#### 叫号
1. 在等位卡片上点击「📣 叫号」
2. 系统自动：
   - 向顾客手机发送叫号短信
   - 向门店企微群推送叫号提醒
   - 卡片状态变为「已叫号」并显示3分钟倒计时

#### 入座 / 过号
- 顾客到前台 → 点击「✅ 入座」
- 超过3分钟未到 → 系统自动标记「已过号」或手动点击「过号」

### 6.2 管理员操作

- 管理员账号登录后自动显示全部门店数据
- 顶部可选择「全部门店」或切换单个门店
- 支持全店数据导出
- 日期选择器可查看历史某天的排队记录

### 6.3 顾客扫码取号

1. 顾客扫描门店二维码（URL格式：`https://系统地址/public/scan.html?store=门店ID`）
2. 填写：用餐人数、姓氏、手机号
3. 点击「立即取号」
4. 显示排队号和前面等待桌数
5. 收到确认短信
6. 叫号时收到短信通知

#### 扫码页 URL 示例
- 大朗环球店: `.../public/scan.html?store=dalang`
- 长安锦厦店: `.../public/scan.html?store=jinxia`
- 凤岗天安店: `.../public/scan.html?store=tiangan`

（将 URL 生成二维码贴在店门口即可）

---

## 七、项目文件结构

```
queue-system/
├── server.js                  # Express 后端（主文件）
├── package.json               # 依赖配置
├── render.yaml                # Render 部署配置
├── .gitignore
├── supabase_queue_setup.sql   # 数据库建表脚本
├── README.md                  # 本文档
└── public/
    ├── index.html             # 🔐 管理面板（/admin）
    ├── scan.html              # 🏠 顾客扫码取号页（/）
    ├── s.html                 # 排队凭证页
    └── logo.png               # 透明logo
```

---

## 八、与预订系统的关系

| 项目 | 预订系统 | 排队系统 |
|------|---------|---------|
| Supabase项目 | 同一个 | 同一个 |
| 端口 | 3456 | 3457 |
| 用户账号 | 共用 users/tokens 表 | 共用 |
| 门店配置 | 共用 stores/meta 表 | 共用 |
| 短信模板 | 共用腾讯云配置 | 共用 |
| 企微通知 | 共用 Webhook | 共用（内容格式不同） |
| 数据表 | bookings/history | queue/queue_history ⭐新增 |

**数据完全隔离**：排队系统和预订系统的数据表各自独立，互不干扰。

---

## 九、常见问题

**Q: 号数跳号了怎么办？**
A: 号数是按当日自动递增的，不会重复。如果人工取消了某号，后续号不会回填，这是正常现象。

**Q: 如何修改叫号超时时间？**
A: 修改 `server.js` 中 `setInterval` 里的 `3 * 60 * 1000`（毫秒）。

**Q: 打印不出来？**
A: 检查打印机是否开机、蓝牙是否配对、是否为默认打印机。可使用「重打小票」按钮手动重试。

**Q: 超过7天的数据去哪了？**
A: 自动归档到 `queue_history` 表，可从「历史记录」标签页查看。
