const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3457;

// ── Supabase 配置（复用预订系统同一项目） ──
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ieidvazvzulsrfopjvyf.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL || 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=d35ec9fd-b3e2-4132-848c-0fbc7ab38107';

// SMS 配置（复用预订系统短信模板）
const SMS_SECRET_ID = process.env.SMS_SECRET_ID || '';
const SMS_SECRET_KEY = process.env.SMS_SECRET_KEY || '';
const SMS_SDK_APP_ID = process.env.SMS_SDK_APP_ID || '';
const SMS_SIGN_NAME = process.env.SMS_SIGN_NAME || '湘阁里辣';
const SMS_TEMPLATE_ID = process.env.SMS_TEMPLATE_ID || '';

let clients = [];

// ── 密码哈希 ──
function hashPassword(pw) {
  return crypto.createHash('sha256').update('xglr_' + pw).digest('hex');
}
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}
function getTimeString() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' });
}

// 根据人数自动分配号段: 1→A, 2-4→B, 5+→C
function getQueueType(people) {
  const p = parseInt(people) || 1;
  if (p <= 2) return 'A';       // 1-2人 → A
  if (p <= 4) return 'B';       // 3-4人 → B
  return 'C';                   // 5人+ → C
}

// 类型标签
function getTypeLabel(type) {
  return { A: '1-2人', B: '3-4人', C: '5人以上' }[type] || type;
}

// 类型名称
function getTypeName(type) {
  return { A: 'A区(1-2人)', B: 'B区(3-4人)', C: 'C区(5人以上)' }[type] || type;
}

app.use(cors());
app.use(express.json());
// 静态文件：主管理页面重定向到 public/
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// ── SSE 通知 ──
function notifyAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => { try { c.res.write(msg); return true; } catch { return false; } });
}

// ── 验证中间件 ──
function requireAuth(req, res) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) { res.status(401).json({ error: '请先登录' }); return null; }
  return token;
}

async function checkAuth(token) {
  const { data } = await supabase.from('tokens').select('username,store,role').eq('token', token).single();
  return data || null;
}

async function checkAdmin(token) {
  const user = await checkAuth(token);
  if (!user || user.role !== 'admin') return null;
  return user;
}

// ── 获取门店配置 ──
async function getStoreMeta(storeId) {
  const { data } = await supabase.from('meta').select('key,value').or(`key.eq.wecom_webhook_${storeId},key.eq.store_phone_${storeId},key.eq.store_nav_url_${storeId},key.eq.store_parking_${storeId}`);
  const meta = {};
  if (data) for (const m of data) meta[m.key] = m.value;
  return {
    wecom_webhook: meta['wecom_webhook_' + storeId] || WECOM_WEBHOOK_URL,
    phone: meta['store_phone_' + storeId] || '',
    nav_url: meta['store_nav_url_' + storeId] || '',
    parking: meta['store_parking_' + storeId] || ''
  };
}

// ── 获取今日最大序号（防重复） ──
async function getTodayMaxSeq(storeId, type) {
  const today = getDateString();
  const { data } = await supabase.from('queue')
    .select('daily_seq')
    .eq('store_id', storeId)
    .eq('type', type)
    .gte('created_at', today + 'T00:00:00+08:00')
    .lte('created_at', today + 'T23:59:59+08:00')
    .order('daily_seq', { ascending: false })
    .limit(1);
  return data && data.length > 0 ? data[0].daily_seq : 0;
}

// ============================================================
// 登录 API（复用现有用户表）
// ============================================================
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });

  const { data: user } = await supabase.from('users').select('*').eq('username', username).single();
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = newToken();
  await supabase.from('tokens').insert({ token, username: user.username, store: user.store, role: user.role });

  // 获取门店名称
  const { data: store } = await supabase.from('stores').select('name').eq('id', user.store).single();
  res.json({ token, username: user.username, store: user.store, storeName: store?.name || '', role: user.role });
});

app.get('/api/me', async (req, res) => {
  const user = await checkAuth(requireAuth(req, res));
  if (!user) return res.status(401).json({ error: '未登录' });
  const { data: store } = await supabase.from('stores').select('id,name').eq('id', user.store).single();
  res.json({ username: user.username, store: user.store, storeName: store?.name || '', role: user.role });
});

// ============================================================
// 公共 API
// ============================================================
app.get('/api/stores', async (req, res) => {
  const { data } = await supabase.from('stores').select('id,name');
  res.json(data || []);
});

// ============================================================
// 排队 CRUD API
// ============================================================

// 获取排队列表（支持日期筛选）
app.get('/api/store/:storeId/queue', async (req, res) => {
  const storeId = req.params.storeId;
  const { date } = req.query;
  let query = supabase.from('queue').select('*').eq('store_id', storeId).order('daily_seq', { ascending: true });

  if (date) {
    query = query.gte('created_at', date + 'T00:00:00+08:00').lte('created_at', date + 'T23:59:59+08:00');
  } else {
    const today = getDateString();
    query = query.gte('created_at', today + 'T00:00:00+08:00');
  }

  const { data } = await query;
  res.json(data || []);
});

// 创建排队（前台现场取号，根据人数自动分配号段）
app.post('/api/store/:storeId/queue', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const user = await checkAuth(token);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const storeId = req.params.storeId;
  const { name, phone, people, note } = req.body;

  if (!people) {
    return res.status(400).json({ error: '请填写用餐人数' });
  }
  const finalName = name || '顾客';

  const queueType = getQueueType(people); // 根据人数自动分配 A/B/C
  const maxSeq = await getTodayMaxSeq(storeId, queueType);
  const seq = maxSeq + 1;
  const queueNumber = queueType + String(seq); // A1/B2/C3 格式

  const now = new Date().toISOString();
  const id = 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const record = {
    id, store_id: storeId, queue_number: queueNumber, type: queueType,
    daily_seq: seq, name: finalName, phone: phone || '', people: parseInt(people),
    note: note || '', status: 'waiting',
    created_by: user.username, created_at: now, updated_at: now
  };

  const { error } = await supabase.from('queue').insert(record);
  if (error) {
    console.error('创建排队失败:', error.message);
    return res.status(500).json({ error: '创建失败: ' + error.message });
  }

  notifyAll('queue_update', { action: 'created', record, storeId });
  res.json(record);
});

// 线上扫码取号（根据人数自动分配号段，无需登录）
app.post('/api/store/:storeId/scan-queue', async (req, res) => {
  const storeId = req.params.storeId;
  const { name, phone, people, note } = req.body;

  if (!people) {
    return res.status(400).json({ error: '请填写用餐人数' });
  }
  if (!phone) {
    return res.status(400).json({ error: '请填写手机号码以便接收叫号通知' });
  }
  const finalName = name || '顾客';

  const queueType = getQueueType(people); // 根据人数自动分配 A/B/C
  const maxSeq = await getTodayMaxSeq(storeId, queueType);
  const seq = maxSeq + 1;
  const queueNumber = queueType + String(seq); // A1/B2/C3 格式

  const now = new Date().toISOString();
  const id = 'q_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  const record = {
    id, store_id: storeId, queue_number: queueNumber, type: queueType,
    daily_seq: seq, name: finalName, phone: phone || '', people: parseInt(people),
    note: note || '', status: 'waiting',
    created_by: 'scan', created_at: now, updated_at: now
  };

  const { error } = await supabase.from('queue').insert(record);
  if (error) return res.status(500).json({ error: '取号失败' });

  // 计算当前排队人数
  const { count } = await supabase.from('queue')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .eq('status', 'waiting');

  notifyAll('queue_update', { action: 'created', record, storeId });

  // 发送取号成功短信
  sendQueueConfirmSms(record, storeId, (count || 1));

  res.json({ ...record, queue_ahead: (count || 1) - 1 });
});

// 叫号
app.post('/api/store/:storeId/queue/:id/call', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const user = await checkAuth(token);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const { id } = req.params;
  const { data: record } = await supabase.from('queue').select('*').eq('id', id).single();
  if (!record) return res.status(404).json({ error: '排队记录不存在' });

  const now = new Date().toISOString();
  const updates = {
    status: 'called',
    called_at: now,
    called_count: (record.called_count || 0) + 1,
    updated_at: now
  };

  await supabase.from('queue').update(updates).eq('id', id);

  const updated = { ...record, ...updates };
  notifyAll('queue_update', { action: 'called', record: updated, storeId: req.params.storeId });

  // 发送通知
  const meta = await getStoreMeta(req.params.storeId);
  const { data: store } = await supabase.from('stores').select('name').eq('id', req.params.storeId).single();
  sendQueueCallSms(updated, store?.name || '');
  sendQueueCallWecom(updated, store?.name || '', meta.wecom_webhook, meta.phone, meta.nav_url, meta.parking);

  res.json(updated);
});

// 标记入座
app.post('/api/store/:storeId/queue/:id/seat', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const user = await checkAuth(token);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const { id } = req.params;
  const { data: record } = await supabase.from('queue').select('*').eq('id', id).single();
  if (!record) return res.status(404).json({ error: '排队记录不存在' });

  const now = new Date().toISOString();
  const updates = { status: 'seated', seated_at: now, updated_at: now };
  await supabase.from('queue').update(updates).eq('id', id);

  const updated = { ...record, ...updates };
  notifyAll('queue_update', { action: 'seated', record: updated, storeId: req.params.storeId });
  res.json(updated);
});

// 取消排队
app.post('/api/store/:storeId/queue/:id/cancel', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const user = await checkAuth(token);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const { id } = req.params;
  const { data: record } = await supabase.from('queue').select('*').eq('id', id).single();
  if (!record) return res.status(404).json({ error: '排队记录不存在' });

  const now = new Date().toISOString();
  const updates = { status: 'cancelled', updated_at: now };
  await supabase.from('queue').update(updates).eq('id', id);

  const updated = { ...record, ...updates };
  notifyAll('queue_update', { action: 'cancelled', record: updated, storeId: req.params.storeId });
  res.json(updated);
});

// 自动标记过号（3分钟超时）
app.post('/api/store/:storeId/queue/:id/skip', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const user = await checkAuth(token);
  if (!user) return res.status(401).json({ error: '请先登录' });

  const { id } = req.params;
  const { data: record } = await supabase.from('queue').select('*').eq('id', id).single();
  if (!record) return res.status(404).json({ error: '排队记录不存在' });

  const now = new Date().toISOString();
  const updates = { status: 'skipped', updated_at: now };
  await supabase.from('queue').update(updates).eq('id', id);

  const updated = { ...record, ...updates };
  notifyAll('queue_update', { action: 'skipped', record: updated, storeId: req.params.storeId });
  res.json(updated);
});

// ============================================================
// 历史记录 & 导出
// ============================================================

app.get('/api/store/:storeId/queue/history', async (req, res) => {
  const storeId = req.params.storeId;
  const today = getDateString();

  // 今日之前的排队记录（已完成的）
  const { data } = await supabase.from('queue')
    .select('*')
    .eq('store_id', storeId)
    .lt('created_at', today + 'T00:00:00+08:00')
    .order('created_at', { ascending: false })
    .limit(200);

  // 也查历史表
  const { data: histData } = await supabase.from('queue_history')
    .select('*')
    .eq('store_id', storeId)
    .order('archived_at', { ascending: false })
    .limit(200);

  res.json({ recent: data || [], archived: histData || [] });
});

// 单店导出
app.get('/api/store/:storeId/queue/export', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const storeId = req.params.storeId;

  const { data: all } = await supabase.from('queue')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  const { data: hist } = await supabase.from('queue_history')
    .select('*')
    .eq('store_id', storeId)
    .order('archived_at', { ascending: false });

  const { data: store } = await supabase.from('stores').select('name').eq('id', storeId).single();

  const statusMap = { waiting: '等位中', called: '已叫号', seated: '已入座', skipped: '已过号', cancelled: '已取消' };
  const headers = ['日期', '时间', '号数', '类型', '姓名', '手机', '人数', '备注', '状态', '取号方式', '取号时间'];

  const rows = [...(all || []), ...(hist || [])].map(q => {
    const d = new Date(q.created_at);
    const ds = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const ts = d.toLocaleTimeString('zh-CN', { hour12: false });
    const typeLabel = getTypeName(q.type);
    const source = q.created_by === 'scan' ? '顾客扫码' : (q.created_by || '前台');
    return [ds, ts, q.queue_number, typeLabel, q.name, q.phone || '', String(q.people), q.note || '', statusMap[q.status] || q.status, source, q.created_at]
      .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
  });

  const csv = '\ufeff' + [headers.join(','), ...rows].join('\n');
  const fname = (store?.name || storeId) + '_排队记录_' + getDateString() + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + encodeURIComponent(fname) + '"');
  res.send(csv);
});

// 全店导出（管理员）
app.get('/api/admin/queue/export', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const admin = await checkAdmin(token);
  if (!admin) return res.status(403).json({ error: '需要管理员权限' });

  const { data: all } = await supabase.from('queue').select('*').order('created_at', { ascending: false });
  const { data: hist } = await supabase.from('queue_history').select('*').order('archived_at', { ascending: false });
  const { data: stores } = await supabase.from('stores').select('id,name');

  const storeMap = {};
  if (stores) for (const s of stores) storeMap[s.id] = s.name;

  const statusMap = { waiting: '等位中', called: '已叫号', seated: '已入座', skipped: '已过号', cancelled: '已取消' };
  const headers = ['门店', '日期', '时间', '号数', '类型', '姓名', '手机', '人数', '备注', '状态', '取号方式', '取号时间'];

  const rows = [...(all || []), ...(hist || [])].map(q => {
    const d = new Date(q.created_at);
    const ds = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
    const ts = d.toLocaleTimeString('zh-CN', { hour12: false });
    const typeLabel = getTypeName(q.type);
    const source = q.created_by === 'scan' ? '顾客扫码' : (q.created_by || '前台');
    return [storeMap[q.store_id] || q.store_id, ds, ts, q.queue_number, typeLabel, q.name, q.phone || '', String(q.people), q.note || '', statusMap[q.status] || q.status, source, q.created_at]
      .map(v => '"' + String(v).replace(/"/g, '""') + '"').join(',');
  });

  rows.sort((a, b) => a[0].localeCompare(b[0]) || b[1].localeCompare(a[1]));

  const csv = '\ufeff' + [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="全店排队记录_' + getDateString() + '.csv"');
  res.send(csv);
});

// ============================================================
// 管理员查看所有门店排队
// ============================================================
app.get('/api/admin/queue/unified', async (req, res) => {
  const token = requireAuth(req, res);
  if (!token) return;
  const admin = await checkAdmin(token);
  if (!admin) return res.status(403).json({ error: '需要管理员权限' });

  const { date } = req.query;
  const today = date || getDateString();

  const { data: stores } = await supabase.from('stores').select('id,name');
  if (!stores) return res.json([]);

  const storeIds = stores.map(s => s.id);

  const { data: queueData } = await supabase.from('queue')
    .select('*')
    .in('store_id', storeIds)
    .gte('created_at', today + 'T00:00:00+08:00')
    .lte('created_at', today + 'T23:59:59+08:00')
    .order('daily_seq', { ascending: true });

  const result = stores.map(s => ({
    id: s.id,
    name: s.name,
    queue: (queueData || []).filter(q => q.store_id === s.id)
  }));

  res.json(result);
});

// ============================================================
// 顾客扫码页 API（无需登录）
// ============================================================

// 获取门店信息（扫码页用）
app.get('/api/store/:storeId/info', async (req, res) => {
  const storeId = req.params.storeId;
  const { data: store } = await supabase.from('stores').select('id,name').eq('id', storeId).single();
  if (!store) return res.status(404).json({ error: '门店不存在' });
  const meta = await getStoreMeta(storeId);
  res.json({ ...store, ...meta });
});

// 查询排队状态（顾客用，通过排队ID）
app.get('/api/queue/status/:queueId', async (req, res) => {
  const { queueId } = req.params;
  const { data: record } = await supabase.from('queue')
    .select('*')
    .eq('id', queueId)
    .single();

  if (!record) return res.status(404).json({ error: '排队号不存在' });

  // 计算前面还有几桌
  const { count } = await supabase.from('queue')
    .select('*', { count: 'exact', head: true })
    .eq('store_id', record.store_id)
    .eq('status', 'waiting')
    .lt('daily_seq', record.daily_seq);

  res.json({ ...record, queue_ahead: count || 0 });
});

// ============================================================
// SSE 实时同步
// ============================================================
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  res.write('event: connected\ndata: {"status":"ok"}\n\n');
  const client = { id: Date.now(), res };
  clients.push(client);
  const hb = setInterval(() => { try { res.write(': \n\n'); } catch {} }, 30000);
  req.on('close', () => { clearInterval(hb); clients = clients.filter(c => c.id !== client.id); });
});

// ============================================================
// 定时任务：自动标记过号 & 数据归档
// ============================================================

// 每30秒检查：called 超过3分钟未入座 → 自动标记过号
setInterval(async () => {
  try {
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data } = await supabase.from('queue')
      .select('id,queue_number,store_id,name')
      .eq('status', 'called')
      .lt('called_at', threeMinAgo);

    if (data && data.length > 0) {
      for (const q of data) {
        await supabase.from('queue').update({
          status: 'skipped',
          updated_at: new Date().toISOString()
        }).eq('id', q.id);

        notifyAll('queue_update', {
          action: 'skipped',
          record: { id: q.id, queue_number: q.queue_number, status: 'skipped' },
          storeId: q.store_id,
          reason: '3分钟超时未入座'
        });
      }
      console.log(`⏰ 自动过号: ${data.length} 条`);
    }
  } catch (e) { /* 静默 */ }
}, 30000);

// 每小时执行一次数据归档（7天前数据→queue_history）
setInterval(async () => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: old } = await supabase.from('queue')
      .select('id')
      .lt('created_at', sevenDaysAgo)
      .not('status', 'eq', 'waiting') // 跳过仍在等位的
      .limit(500);

    if (old && old.length > 0) {
      for (const q of old) {
        // 先查完整记录
        const { data: full } = await supabase.from('queue').select('*').eq('id', q.id).single();
        if (full) {
          await supabase.from('queue_history').insert({
            ...full, archived_at: new Date().toISOString()
          });
          await supabase.from('queue').delete().eq('id', q.id);
        }
      }
      console.log(`📦 数据归档: ${old.length} 条`);
    }
  } catch (e) { /* 静默 */ }
}, 3600000);

// ============================================================
// 通知函数
// ============================================================

// 取号确认短信
async function sendQueueConfirmSms(record, storeId, queueAhead) {
  if (!record.phone || !SMS_SECRET_ID || !SMS_TEMPLATE_ID) return;

  const { data: store } = await supabase.from('stores').select('name').eq('id', storeId).single();
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const time = getTimeString();

  // 使用预订系统的短信模板，参数：姓名、号数、日期、时间、前面人数、电话
  const params = [record.name, record.queue_number, String(month), String(day), time, String(queueAhead), record.phone];

  await sendSms(record.phone, params);
}

// 叫号短信
async function sendQueueCallSms(record, storeName) {
  if (!record.phone || !SMS_SECRET_ID || !SMS_TEMPLATE_ID) return;

  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const time = getTimeString();

  const params = [record.name, record.queue_number, String(month), String(day), time, String(record.people), record.phone];
  await sendSms(record.phone, params);
}

async function sendSms(phone, params) {
  if (!SMS_SECRET_ID || !SMS_SECRET_KEY || !SMS_SDK_APP_ID || !SMS_TEMPLATE_ID) return;

  const payload = JSON.stringify({
    SmsSdkAppId: parseInt(SMS_SDK_APP_ID), SignName: SMS_SIGN_NAME,
    TemplateId: SMS_TEMPLATE_ID, TemplateParamSet: params,
    PhoneNumberSet: ['+86' + phone], SessionContext: ''
  });

  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date().toISOString().slice(0, 10);
  const service = 'sms', host = 'sms.tencentcloudapi.com';
  const action = 'SendSms', version = '2021-01-11', algorithm = 'TC3-HMAC-SHA256';

  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const hashedPayload = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${hashedPayload}`;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const credentialScope = `${dateStr}/${service}/tc3_request`;
  const stringToSign = `${algorithm}\n${now}\n${credentialScope}\n${hashedCanonical}`;

  const kDate = crypto.createHmac('sha256', ('TC3' + SMS_SECRET_KEY).toString('utf8')).update(dateStr).digest();
  const kService = crypto.createHmac('sha256', kDate).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('tc3_request').digest();
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = `${algorithm} Credential=${SMS_SECRET_ID}/${credentialScope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`;

  return new Promise((resolve) => {
    const req = https.request({
      hostname: host, port: 443, path: '/', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        Host: host, 'X-TC-Action': action, 'X-TC-Version': version, 'X-TC-Region': 'ap-guangzhou',
        'X-TC-Timestamp': String(now), Authorization: authorization
      }
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => {
      console.log(`📲 SMS: ${phone} → ${res.statusCode}`);
      resolve();
    });});
    req.on('error', (e) => { console.error(`📲 SMS失败:`, e.message); resolve(); });
    req.write(payload); req.end();
  });
}

// 叫号企微通知
async function sendQueueCallWecom(record, storeName, webhookUrl, storePhone, navUrl, parking) {
  const wu = webhookUrl || WECOM_WEBHOOK_URL;
  if (!wu) return;

  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const time = getTimeString();
  const phoneDisplay = record.phone ? record.phone.slice(0, 3) + '****' + record.phone.slice(-4) : '无';
  const typeLabel = getTypeName(record.type);

  const navLine = navUrl ? '\n• [点击导航](' + navUrl + ')' : '';
  const phoneLine = storePhone ? '\n• 服务电话:' + storePhone : '';

  const content = `📣 **叫号提醒**\n\n【${storeName}】\n\n🔔 **${record.queue_number}号**(${typeLabel})，请到前台就餐!\n\n• 顾客:${record.name}\n• 人数:${record.people}人\n• 手机:${phoneDisplay}\n• 取号渠道:${record.created_by === 'scan' ? '顾客扫码' : '前台取号'}\n• 备注:${record.note || '无'}${phoneLine}${navLine}\n\n⚠️ 请尽快前往前台，超过3分钟将自动过号!`;

  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: `## <font color="warning">📣 叫号提醒</font>\n${content}` }
  });

  return new Promise((resolve) => {
    try {
      const u = new URL(wu);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => { console.log(`📱 WeCom queue call → ${res.statusCode}`); resolve(); });
      req.on('error', (e) => { console.error(`📱 WeCom失败:`, e.message); resolve(); });
      req.write(body); req.end();
    } catch(e) { console.error(`📱 WeCom错误:`, e.message); resolve(); }
  });
}

// ============================================================
// 启动
// ============================================================
if (!supabase) {
  console.error('❌ SUPABASE_KEY 未配置!');
  console.error('请设置环境变量后重启:');
  console.error('  export SUPABASE_KEY="你的Supabase服务密钥"');
  console.error('或创建 .env 文件（参考 README.md）');
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🍜 等位叫号系统已启动: http://localhost:${PORT}`);
  console.log(`📋 默认账号: xgll2122 / 2122`);
  console.log(`🗄️ 数据存储: Supabase (${SUPABASE_URL})`);
  console.log(`📱 扫码取号: http://localhost:${PORT}/public/scan.html`);
});
