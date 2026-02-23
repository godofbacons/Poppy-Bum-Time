/**
 * Playtime Co. — Party Server
 * WebSocket-based multiplayer relay for Fly.io
 *
 * Protocol (all messages are JSON strings):
 *
 *  CLIENT → SERVER
 *   { type:'create', name:'PlayerName' }
 *   { type:'join',   name:'PlayerName', code:'ABCD' }
 *   { type:'state',  x, y, z, yaw, pitch, chap, anim }
 *   { type:'chat',   text:'hello' }
 *   { type:'event',  ev:'damage'|'death'|'grab', data:{} }
 *
 *  SERVER → CLIENT
 *   { type:'welcome',  id, code, players:[{id,name,color},...] }
 *   { type:'joined',   id, name, color }    — broadcast to party
 *   { type:'left',     id }                 — broadcast to party
 *   { type:'state',    id, x,y,z,yaw,pitch,chap,anim }
 *   { type:'chat',     id, name, text }
 *   { type:'event',    id, ev, data }
 *   { type:'error',    msg }
 */

'use strict';
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// ── Utilities ──────────────────────────────────────────────────────
const ADJECTIVES = ['Shadow','Neon','Iron','Void','Storm','Pixel','Chaos','Rust'];
const NOUNS      = ['Bunny','Wuggy','Moth','Glitch','Specter','Wraith','Drone','Echo'];
const COLORS     = ['#ff4444','#44aaff','#44ff88','#ffcc00','#ff88cc','#88ffff','#ff8844','#cc88ff'];

function genCode(len = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function genName() {
  return ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] +
         NOUNS[Math.floor(Math.random() * NOUNS.length)];
}
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(party, obj, excludeId = null) {
  party.members.forEach((m, id) => {
    if (id !== excludeId) send(m.ws, obj);
  });
}

// ── State ──────────────────────────────────────────────────────────
const parties = new Map();   // code → { code, members: Map<id,player> }
const clients = new Map();   // ws  → { id, name, color, partyCode }

let nextId = 1;

// ── HTTP server (for Fly.io health checks) ──────────────────────────
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    parties: parties.size,
    players: clients.size,
  }));
});

// ── WebSocket server ────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[+] Connected: ${ip}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    const info = clients.get(ws);

    // ── CREATE PARTY ──────────────────────────────────────────────
    if (msg.type === 'create') {
      if (info) return send(ws, { type:'error', msg:'Already in a party.' });

      const id     = String(nextId++);
      const name   = (msg.name || genName()).slice(0, 20);
      const color  = COLORS[(nextId - 1) % COLORS.length];
      let   code   = genCode();
      while (parties.has(code)) code = genCode();  // collision-safe

      const party = { code, members: new Map() };
      const player = { id, name, color, ws, partyCode: code, lastState: null };

      party.members.set(id, player);
      parties.set(code, party);
      clients.set(ws, player);

      console.log(`  Party ${code} created by ${name} (${id})`);

      send(ws, {
        type: 'welcome',
        id, code,
        players: [], // only member so far
        color,
      });
    }

    // ── JOIN PARTY ────────────────────────────────────────────────
    else if (msg.type === 'join') {
      if (info) return send(ws, { type:'error', msg:'Already in a party.' });

      const code = (msg.code || '').toUpperCase().trim();
      const party = parties.get(code);
      if (!party) return send(ws, { type:'error', msg:`Party "${code}" not found.` });
      if (party.members.size >= 8) return send(ws, { type:'error', msg:'Party is full (max 8).' });

      const id    = String(nextId++);
      const name  = (msg.name || genName()).slice(0, 20);
      const color = COLORS[(nextId - 1) % COLORS.length];
      const player = { id, name, color, ws, partyCode: code, lastState: null };

      // Tell the joiner about everyone already there
      const existing = [];
      party.members.forEach((m) => {
        existing.push({ id: m.id, name: m.name, color: m.color, state: m.lastState });
      });

      party.members.set(id, player);
      clients.set(ws, player);

      console.log(`  ${name} (${id}) joined party ${code}`);

      send(ws, { type:'welcome', id, code, players: existing, color });

      // Announce to existing members
      broadcast(party, { type:'joined', id, name, color }, id);
    }

    // ── POSITION STATE ────────────────────────────────────────────
    else if (msg.type === 'state') {
      if (!info) return;
      const party = parties.get(info.partyCode);
      if (!party) return;

      const state = {
        x:    +msg.x    || 0,
        y:    +msg.y    || 0,
        z:    +msg.z    || 0,
        yaw:  +msg.yaw  || 0,
        pitch:+msg.pitch|| 0,
        chap: +msg.chap || 1,
        anim: msg.anim  || 'idle',
      };
      info.lastState = state;

      broadcast(party, { type:'state', id: info.id, ...state }, info.id);
    }

    // ── CHAT ──────────────────────────────────────────────────────
    else if (msg.type === 'chat') {
      if (!info) return;
      const party = parties.get(info.partyCode);
      if (!party) return;
      const text = String(msg.text || '').slice(0, 120);
      broadcast(party, { type:'chat', id: info.id, name: info.name, text });
      send(ws, { type:'chat', id: info.id, name: info.name, text }); // echo back
    }

    // ── GAME EVENT ───────────────────────────────────────────────
    else if (msg.type === 'event') {
      if (!info) return;
      const party = parties.get(info.partyCode);
      if (!party) return;
      broadcast(party, { type:'event', id: info.id, ev: msg.ev, data: msg.data || {} }, info.id);
    }
  });

  ws.on('close', () => {
    const info = clients.get(ws);
    if (!info) return;

    const party = parties.get(info.partyCode);
    if (party) {
      party.members.delete(info.id);
      broadcast(party, { type:'left', id: info.id });
      console.log(`  ${info.name} left party ${info.partyCode}`);
      // Clean up empty parties
      if (party.members.size === 0) {
        parties.delete(info.partyCode);
        console.log(`  Party ${info.partyCode} dissolved`);
      }
    }
    clients.delete(ws);
  });

  ws.on('error', () => ws.terminate());
});

httpServer.listen(PORT, () => {
  console.log(`Playtime Co. Party Server running on :${PORT}`);
});

// Heartbeat — drop dead connections every 30s
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.ping();
  });
}, 30_000);
