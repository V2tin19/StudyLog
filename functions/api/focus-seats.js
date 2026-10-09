/**
 * /api/focus-seats —— 专属席位与留档令牌
 * 
 * 提供 5 个固定席位，可认领、留档、释放与转交。
 * 存储于 D1 site_meta 表（key='focus_seats_data'）。
 */

import { json, dbMissing, honeyPotHit } from './_shared.js';

const NO_STORE = { 'cache-control': 'no-store' };
const SEAT_COUNT = 5;

function defaultSeats() {
  const seats = [];
  for (let i = 1; i <= SEAT_COUNT; i++) {
    seats.push({
      id: i,
      name: `席位 #${i}`,
      holder: '',
      claimed: false,
      claimedAt: '',
      token: '',
      stats: {
        totalMinutes: 0,
        totalSessions: 0
      },
      records: []
    });
  }
  return seats;
}

function randomKey(len = 7) {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let res = '';
  for (let i = 0; i < len; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

async function getSeatsFromDb(env) {
  let row = null;
  try {
    row = await env.DB
      .prepare("SELECT value FROM site_meta WHERE key = 'focus_seats_data'")
      .first();
  } catch (e) {
    try {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')").run();
      row = await env.DB
        .prepare("SELECT value FROM site_meta WHERE key = 'focus_seats_data'")
        .first();
    } catch (e2) {}
  }

  let list = [];
  try { list = JSON.parse((row && row.value) || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || list.length === 0) {
    list = defaultSeats();
  }
  return list;
}

async function saveSeatsToDb(env, seats) {
  const payload = JSON.stringify(seats);
  try {
    await env.DB.prepare(
      `INSERT INTO site_meta (key, value) VALUES ('focus_seats_data', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    ).bind(payload, payload).run();
  } catch (e) {
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS site_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')").run();
    await env.DB.prepare(
      `INSERT INTO site_meta (key, value) VALUES ('focus_seats_data', ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    ).bind(payload, payload).run();
  }
}

export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();

  const url = new URL(request.url);
  const myToken = url.searchParams.get('token') || '';

  const seats = await getSeatsFromDb(env);

  // 公开接口脱敏返回（保护朋友的私有密钥）
  const publicSeats = seats.map(s => {
    const isOwner = myToken && s.token && myToken === s.token;
    return {
      id: s.id,
      name: s.name,
      holder: s.holder,
      claimed: !!s.claimed,
      claimedAt: s.claimedAt,
      stats: s.stats || { totalMinutes: 0, totalSessions: 0 },
      records: s.records || [],
      isOwner: isOwner
    };
  });

  return json({ ok: true, seats: publicSeats }, 200, NO_STORE);
}

export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();

  let body;
  try { body = await request.json(); } catch { body = {}; }
  if (honeyPotHit(body)) return json({ ok: true }, 200, NO_STORE);

  const action = body.action || '';
  const seatId = parseInt(body.seatId, 10);
  const token = String(body.token || '').trim();

  if (!seatId || seatId < 1 || seatId > SEAT_COUNT) {
    return json({ ok: false, error: '席位编号无效' }, 400, NO_STORE);
  }

  const seats = await getSeatsFromDb(env);
  const seat = seats.find(s => s.id === seatId);
  if (!seat) return json({ ok: false, error: '席位未找到' }, 404, NO_STORE);

  // 1. 认领席位
  if (action === 'claim') {
    if (seat.claimed && seat.token) {
      return json({ ok: false, error: '该席位已被认领' }, 400, NO_STORE);
    }
    const holder = String(body.holder || '').trim().slice(0, 20) || randomKey(7);
    const assignedToken = token || randomKey(7);

    seat.claimed = true;
    seat.holder = holder;
    seat.token = assignedToken;
    seat.claimedAt = new Date().toISOString();
    seat.stats = seat.stats || { totalMinutes: 0, totalSessions: 0 };
    seat.records = seat.records || [];

    await saveSeatsToDb(env, seats);
    return json({ ok: true, seatId, holder, token: assignedToken }, 200, NO_STORE);
  }

  // 2. 释放席位
  if (action === 'release') {
    if (!seat.claimed) {
      return json({ ok: true, message: '席位本为空闲' }, 200, NO_STORE);
    }
    if (!token || token !== seat.token) {
      return json({ ok: false, error: '令牌不匹配，无法释放此席位' }, 403, NO_STORE);
    }

    seat.claimed = false;
    seat.holder = '';
    seat.token = '';
    seat.claimedAt = '';
    // 保留历史累计或清空
    await saveSeatsToDb(env, seats);
    return json({ ok: true, message: '席位已释放' }, 200, NO_STORE);
  }

  // 3. 转交席位
  if (action === 'transfer') {
    if (!token || token !== seat.token) {
      return json({ ok: false, error: '令牌不匹配，无法转交此席位' }, 403, NO_STORE);
    }
    const newHolder = String(body.newHolder || '').trim().slice(0, 20) || randomKey(7);
    const newToken = String(body.newToken || '').trim() || randomKey(7);

    seat.holder = newHolder;
    seat.token = newToken;

    await saveSeatsToDb(env, seats);
    return json({ ok: true, seatId, holder: newHolder, token: newToken }, 200, NO_STORE);
  }

  // 4. 留档写入（专注结束自动记入席位）
  if (action === 'record') {
    if (!token || token !== seat.token) {
      return json({ ok: false, error: '席位令牌验证失败' }, 403, NO_STORE);
    }

    const rec = body.record || {};
    const durMin = Math.max(1, parseInt(rec.durationMinutes, 10) || 1);
    const subject = String(rec.subject || '自习').slice(0, 30);
    const notes = String(rec.notes || '').slice(0, 500);

    const recordItem = {
      id: rec.id || randomKey(7),
      startTime: rec.startTime || Date.now(),
      endTime: rec.endTime || Date.now(),
      durationMinutes: durMin,
      subject: subject,
      notes: notes,
      createdAt: new Date().toISOString()
    };

    seat.stats = seat.stats || { totalMinutes: 0, totalSessions: 0 };
    seat.stats.totalSessions = (seat.stats.totalSessions || 0) + 1;
    seat.stats.totalMinutes = (seat.stats.totalMinutes || 0) + durMin;

    seat.records = seat.records || [];
    seat.records.unshift(recordItem);
    if (seat.records.length > 50) seat.records = seat.records.slice(0, 50);

    await saveSeatsToDb(env, seats);
    return json({ ok: true, seatId, stats: seat.stats, recordsCount: seat.records.length }, 200, NO_STORE);
  }

  return json({ ok: false, error: '未知动作' }, 400, NO_STORE);
}
