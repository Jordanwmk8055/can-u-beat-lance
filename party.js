'use strict';

/* ============================================================
   Team battle: online multiplayer over PeerJS (WebRTC).

   The host's browser runs the room. Every player plays their own
   board exactly like solo; the network only carries the lobby,
   "I popped a shape" (which the host forwards to a random player
   on the other team as an extra shape), score updates and results.
   PeerJS's free public server only introduces browsers to each
   other; game traffic goes browser to browser.

   Loaded after game.js and uses its globals (state, ui, beginRound…).
   ============================================================ */

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PEERJS_SRI = 'sha384-nlUQ8ZqCbvStErob+biJNzSgltf6urV3VGqhfIfzhmg9RXmpeRm76ELw0pYnKlTR';

const PARTY = {
  roomPrefix: 'aim-trainer-teams-v1-', // keeps our 4-letter codes apart from other PeerJS apps
  maxPlayers: 8,
  heartbeatMs: 2000,
  timeoutMs: 9000, // drop anyone we haven't heard from in this long
  connectTimeoutMs: 12000,
  scoreEveryMs: 400, // how often a player reports their score while it changes
  scoresBroadcastMs: 500, // how often the host shares everyone's scores
  resultsGraceMs: 6000, // after the first player finishes, how long to wait for the rest
};

const TEAMS = [
  { name: 'Blue', color: '#3d8bff' },
  { name: 'Red', color: '#ff4545' },
];

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O
const NAME_KEY = 'aim.name';
const NAME_MAX = 16;

const pui = {
  open: $('team-battle'),
  overlay: $('party'),
  entry: $('party-entry'),
  lobby: $('party-lobby'),
  name: $('party-name'),
  create: $('party-create'),
  joinForm: $('party-join-form'),
  code: $('party-code'),
  joinBtn: $('party-join-btn'),
  status: $('party-status'),
  back: $('party-back'),
  codeBig: $('party-code-big'),
  link: $('party-link'),
  copy: $('party-copy'),
  teams: $('party-teams'),
  hostControls: $('party-host-controls'),
  lengths: $('party-lengths'),
  start: $('party-start'),
  startNote: $('party-start-note'),
  wait: $('party-wait'),
  leave: $('party-leave'),
  results: $('party-results'),
  again: $('party-again'),
  toLobby: $('party-to-lobby'),
  overWait: $('party-over-wait'),
  overLeave: $('party-over-leave'),
};

/* ---------- State ---------- */

// What every player knows about the room (the host included).
const party = {
  role: null, // null | 'host' | 'client'
  peer: null,
  myId: '',
  code: '',
  roster: [], // [{ id, name, team, host, connected }]
  length: CONFIG.defaultLength,
  scores: new Map(), // player id → latest score this round
  results: null, // [{ id, name, team, score, left }] once the round is over
  hostConn: null, // client only
  hostSeen: 0, // client only
  heartbeatTimer: 0,
  scoreTimer: 0,
  pendingScore: 0,
  attempt: 0, // bumped to cancel a create / join that's still connecting
};

// The host's side of the room: the source of truth everyone else is sent.
const room = freshRoom();

function freshRoom() {
  return {
    conns: new Map(), // player id → DataConnection
    lastSeen: new Map(),
    roster: [],
    phase: 'lobby', // lobby → playing → results
    length: CONFIG.defaultLength,
    scores: new Map(),
    finals: new Map(), // player id → final score
    scoresTimer: 0,
    finishTimer: 0,
    graceTimer: 0,
  };
}

function resetRoom() {
  clearInterval(room.scoresTimer);
  clearTimeout(room.finishTimer);
  clearTimeout(room.graceTimer);
  Object.assign(room, freshRoom());
}

/* ---------- Small helpers ---------- */

const isTeam = (t) => t === 0 || t === 1;
const isMessage = (v) => typeof v === 'object' && v !== null && typeof v.t === 'string';
const cleanName = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '');
const randomCode = () => Array.from({ length: 4 }, () => pick([...CODE_LETTERS])).join('');
const inviteLink = () => `${location.origin}${location.pathname}?room=${party.code}`;
const scoreOf = (id) => party.scores.get(id) ?? CONFIG.startingPoints;

function el(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function teamTotals(players, score) {
  const totals = [0, 0];
  for (const p of players) totals[p.team] += score(p);
  return totals;
}

function describePeerError(err) {
  const type = err && err.type;
  if (type === 'browser-incompatible') return 'This browser can’t do peer-to-peer connections.';
  if (type === 'peer-unavailable') return 'No room found with that code.';
  if (type === 'webrtc') return 'Couldn’t connect directly to that room. A firewall may be blocking it.';
  if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
    return 'Couldn’t reach the matchmaking server. Check your connection.';
  }
  return `Network error (${type || 'unknown'}).`;
}

// Anything from another browser is untrusted: keep only well-formed players.
function cleanRoster(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.id === 'string' && isTeam(p.team))
    .slice(0, PARTY.maxPlayers)
    .map((p) => ({ id: p.id, name: cleanName(p.name) || 'Player', team: p.team, host: p.host === true, connected: p.connected !== false }));
}

function cleanResults(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((p) => p && typeof p.id === 'string' && isTeam(p.team) && Number.isFinite(p.score))
    .map((p) => ({ id: p.id, name: cleanName(p.name) || 'Player', team: p.team, score: p.score, left: p.left === true }));
}

/* ---------- Loading PeerJS (only when someone opens Team battle) ---------- */

let peerJsLoading = null;

function loadPeerJs() {
  if (window.Peer) return Promise.resolve();
  if (!peerJsLoading) {
    peerJsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = PEERJS_URL;
      script.integrity = PEERJS_SRI; // refuse the file if the CDN ever serves something else
      script.crossOrigin = 'anonymous';
      script.onload = () => (window.Peer ? resolve() : reject(new Error('The multiplayer library didn’t load properly.')));
      script.onerror = () => {
        peerJsLoading = null;
        script.remove();
        reject(new Error('Couldn’t load the multiplayer library. Check your connection.'));
      };
      document.head.append(script);
    });
  }
  return peerJsLoading;
}

/* ---------- Messaging ---------- */

// The host is a player too: its own messages skip the network. Local delivery
// still goes through JSON so the host sees exactly what everyone else gets.
function toHost(msg) {
  if (party.role === 'host') onHostMessage(party.myId, msg);
  else if (party.hostConn && party.hostConn.open) party.hostConn.send(msg);
}

function toPlayer(id, msg) {
  if (id === party.myId) {
    onPartyMessage(JSON.parse(JSON.stringify(msg)));
    return;
  }
  const conn = room.conns.get(id);
  if (conn && conn.open) conn.send(msg);
}

function toAll(msg) {
  for (const p of room.roster) if (p.connected) toPlayer(p.id, msg);
}

/* ---------- Host: running the room ---------- */

function openHostPeer(tries = 5) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const code = randomCode();
      const peer = new window.Peer(PARTY.roomPrefix + code);
      let opened = false;
      peer.on('open', (id) => {
        opened = true;
        resolve({ peer, code, id });
      });
      peer.on('error', (err) => {
        if (opened) {
          console.warn('[host]', err);
          return;
        }
        peer.destroy();
        if (err.type === 'unavailable-id' && left > 0) attempt(left - 1); // code taken: try another
        else reject(new Error(describePeerError(err)));
      });
    };
    attempt(tries);
  });
}

async function createRoom() {
  const name = readName();
  const attempt = ++party.attempt;
  setBusy('Creating a room…');
  try {
    await loadPeerJs();
    if (attempt !== party.attempt) return;
    const { peer, code, id } = await openHostPeer();
    if (attempt !== party.attempt) {
      peer.destroy();
      return;
    }
    resetRoom();
    room.length = settings.length;
    room.roster = [{ id, name, team: 0, host: true, connected: true }];
    Object.assign(party, { role: 'host', peer, myId: id, code });
    peer.on('connection', acceptConnection);
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect(); // stay findable for new players
    });
    startHeartbeat();
    setBusy('');
    showLobby();
    broadcastLobby();
  } catch (err) {
    if (attempt === party.attempt) {
      setBusy('');
      setStatus(err.message, true);
    }
  }
}

function acceptConnection(conn) {
  room.lastSeen.set(conn.peer, Date.now());
  conn.on('data', (msg) => {
    room.lastSeen.set(conn.peer, Date.now());
    if (!isMessage(msg) || msg.t === 'ping') return;
    if (msg.t === 'hello') admit(conn, msg);
    else if (room.conns.get(conn.peer) === conn) onHostMessage(conn.peer, msg);
  });
  conn.on('close', () => dropPlayer(conn.peer, conn));
  conn.on('error', (err) => console.warn('[host conn]', err));
  // Close connections that never introduce themselves.
  setTimeout(() => {
    if (room.conns.get(conn.peer) !== conn) conn.close();
  }, PARTY.timeoutMs);
}

function admit(conn, msg) {
  if (room.conns.has(conn.peer)) return;
  if (room.phase === 'playing') return refuse(conn, 'That battle has already started. Try again when it ends.');
  if (room.roster.length >= PARTY.maxPlayers) return refuse(conn, 'That room is full.');
  room.conns.set(conn.peer, conn);
  room.roster.push({ id: conn.peer, name: cleanName(msg.name) || 'Player', team: smallerTeam(), host: false, connected: true });
  broadcastLobby();
}

function refuse(conn, reason) {
  conn.send({ t: 'refused', reason });
  setTimeout(() => conn.close(), 500);
}

// New players join whichever team is smaller.
function smallerTeam() {
  const sizes = [0, 0];
  for (const p of room.roster) if (p.connected) sizes[p.team]++;
  return sizes[1] < sizes[0] ? 1 : 0;
}

function teamsReady() {
  const live = room.roster.filter((p) => p.connected);
  return live.some((p) => p.team === 0) && live.some((p) => p.team === 1);
}

function dropPlayer(id, conn) {
  if (party.role !== 'host' || room.conns.get(id) !== conn) return;
  room.conns.delete(id);
  room.lastSeen.delete(id);
  try {
    conn.close();
  } catch {
    /* already closed */
  }
  const p = room.roster.find((q) => q.id === id);
  if (p && room.phase === 'playing') p.connected = false; // keep their score for the results
  else room.roster = room.roster.filter((q) => q.id !== id);
  broadcastLobby();
  if (room.phase === 'playing') maybeFinishRound();
}

function onHostMessage(id, msg) {
  const p = room.roster.find((q) => q.id === id);
  if (!p) return;
  if (msg.t === 'team' && isTeam(msg.team) && room.phase !== 'playing') {
    p.team = msg.team;
    broadcastLobby();
  } else if (msg.t === 'pop' && room.phase === 'playing') {
    sendAttack(p);
  } else if (msg.t === 'score' && room.phase === 'playing' && Number.isFinite(msg.score)) {
    room.scores.set(id, msg.score);
  } else if (msg.t === 'final' && room.phase === 'playing' && Number.isFinite(msg.score)) {
    room.scores.set(id, msg.score);
    room.finals.set(id, msg.score);
    maybeFinishRound();
  }
}

// One pop = one shape for a random player on the other team who's still playing.
function sendAttack(from) {
  const targets = room.roster.filter((p) => p.team !== from.team && p.connected && !room.finals.has(p.id));
  if (targets.length === 0) return;
  toPlayer(pick(targets).id, { t: 'incoming', from: from.name, team: from.team });
}

function broadcastLobby() {
  toAll({ t: 'lobby', code: party.code, length: room.length, roster: room.roster });
}

function hostStart() {
  if (party.role !== 'host' || room.phase === 'playing' || !teamsReady()) return;
  room.roster = room.roster.filter((p) => p.connected);
  room.phase = 'playing';
  room.length = settings.length;
  room.scores = new Map(room.roster.map((p) => [p.id, CONFIG.startingPoints]));
  room.finals = new Map();
  toAll({ t: 'start', length: room.length, roster: room.roster });
  clearInterval(room.scoresTimer);
  room.scoresTimer = setInterval(() => toAll({ t: 'scores', s: [...room.scores] }), PARTY.scoresBroadcastMs);
  // Backstop in case someone never reports a final score (3s countdown + the round + grace).
  clearTimeout(room.finishTimer);
  room.finishTimer = setTimeout(finishRound, (3 + room.length) * 1000 + PARTY.resultsGraceMs);
}

function maybeFinishRound() {
  if (room.phase !== 'playing') return;
  const waiting = room.roster.some((p) => p.connected && !room.finals.has(p.id));
  if (!waiting) finishRound();
  else if (room.finals.size > 0 && !room.graceTimer) room.graceTimer = setTimeout(finishRound, PARTY.resultsGraceMs);
}

function finishRound() {
  if (room.phase !== 'playing') return;
  clearInterval(room.scoresTimer);
  clearTimeout(room.finishTimer);
  clearTimeout(room.graceTimer);
  room.graceTimer = 0;
  room.phase = 'results';
  const players = room.roster.map((p) => ({
    id: p.id,
    name: p.name,
    team: p.team,
    score: room.finals.get(p.id) ?? room.scores.get(p.id) ?? CONFIG.startingPoints,
    left: !p.connected,
  }));
  toAll({ t: 'scores', s: [...room.scores] });
  toAll({ t: 'results', players });
}

function hostToLobby() {
  if (party.role !== 'host' || room.phase === 'playing') return;
  room.phase = 'lobby';
  room.roster = room.roster.filter((p) => p.connected);
  broadcastLobby();
  toAll({ t: 'toLobby' });
}

/* ---------- Client: joining a room ---------- */

async function joinRoom(rawCode) {
  const code = rawCode.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) {
    setStatus('Room codes are 4 letters.', true);
    return;
  }
  const name = readName();
  const attempt = ++party.attempt;
  setBusy(`Joining room ${code}…`);
  try {
    await loadPeerJs();
    if (attempt !== party.attempt) return;
    await connectToHost(code, name, attempt);
  } catch (err) {
    if (attempt === party.attempt) {
      setBusy('');
      setStatus(err.message, true);
    }
  }
}

function connectToHost(code, name, attempt) {
  return new Promise((resolve, reject) => {
    const peer = new window.Peer();
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('Couldn’t reach that room (timed out).'), PARTY.connectTimeoutMs);

    peer.on('error', (err) => {
      if (!settled) fail(describePeerError(err));
      else console.warn('[client]', err);
    });
    peer.on('open', (id) => {
      const conn = peer.connect(PARTY.roomPrefix + code, { reliable: true, serialization: 'json' });
      conn.on('open', () => conn.send({ t: 'hello', name }));
      conn.on('data', (msg) => {
        if (!isMessage(msg)) return;
        if (!settled) {
          if (attempt !== party.attempt) return fail('Cancelled.');
          if (msg.t === 'refused') return fail(cleanReason(msg.reason));
          if (msg.t !== 'lobby') return;
          // The host's first lobby message means we're in.
          settled = true;
          clearTimeout(timer);
          Object.assign(party, { role: 'client', peer, myId: id, code, hostConn: conn, hostSeen: Date.now() });
          startHeartbeat();
          setBusy('');
          showLobby();
          resolve();
        }
        party.hostSeen = Date.now();
        if (msg.t !== 'ping') onPartyMessage(msg);
      });
      conn.on('close', () => {
        if (settled) lostHost('The host left the room.');
        else fail('Couldn’t join that room.');
      });
    });
  });
}

const cleanReason = (v) => (typeof v === 'string' && v ? v.slice(0, 120) : 'That room turned you away.');

function lostHost(reason) {
  if (party.role !== 'client') return;
  leaveParty();
  goToMenu();
  openParty(reason);
}

/* ---------- Everyone: messages from the host ---------- */

function onPartyMessage(msg) {
  if (msg.t === 'lobby') {
    party.roster = cleanRoster(msg.roster);
    if (CONFIG.lengthOptions.includes(msg.length)) party.length = msg.length;
    if (typeof msg.code === 'string') party.code = msg.code;
    renderLobby();
    renderTeamBar();
    renderOverActions();
  } else if (msg.t === 'start') {
    party.roster = cleanRoster(msg.roster);
    party.length = CONFIG.lengthOptions.includes(msg.length) ? msg.length : CONFIG.defaultLength;
    party.scores = new Map();
    party.results = null;
    pui.overlay.classList.add('hidden');
    renderTeamBar();
    renderResults();
    beginRound('party', party.length);
  } else if (msg.t === 'incoming') {
    const team = isTeam(msg.team) ? msg.team : 0;
    spawnIncoming(cleanName(msg.from) || 'the other team', TEAMS[team].color);
  } else if (msg.t === 'scores' && Array.isArray(msg.s)) {
    party.scores = new Map(msg.s.filter((e) => Array.isArray(e) && typeof e[0] === 'string' && Number.isFinite(e[1])));
    renderTeamBar();
  } else if (msg.t === 'results') {
    party.results = cleanResults(msg.players);
    renderResults();
  } else if (msg.t === 'toLobby') {
    showLobby();
  } else if (msg.t === 'closed') {
    lostHost('The host closed the room.');
  }
}

/* ---------- Both roles: heartbeat and leaving ---------- */

function startHeartbeat() {
  clearInterval(party.heartbeatTimer);
  party.heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (party.role === 'host') {
      for (const [id, conn] of [...room.conns]) {
        if (now - (room.lastSeen.get(id) ?? 0) > PARTY.timeoutMs) dropPlayer(id, conn);
        else if (conn.open) conn.send({ t: 'ping' });
      }
    } else if (party.role === 'client') {
      if (party.hostConn && party.hostConn.open) party.hostConn.send({ t: 'ping' });
      if (now - party.hostSeen > PARTY.timeoutMs) lostHost('Lost connection to the host.');
    }
  }, PARTY.heartbeatMs);
}

function leaveParty() {
  if (!party.role) return;
  const { peer, role } = party;
  if (role === 'host') toAll({ t: 'closed' });
  clearInterval(party.heartbeatTimer);
  clearTimeout(party.scoreTimer);
  resetRoom();
  Object.assign(party, {
    role: null,
    peer: null,
    myId: '',
    code: '',
    roster: [],
    scores: new Map(),
    results: null,
    hostConn: null,
    heartbeatTimer: 0,
    scoreTimer: 0,
  });
  ui.teambar.hidden = true;
  // Give the host's "room closed" message a moment to go out before hanging up.
  if (peer) setTimeout(() => peer.destroy(), role === 'host' ? 300 : 0);
}

/* ---------- Hooks game.js calls ---------- */

Object.assign(net, {
  busy: () => party.role !== null || !pui.overlay.classList.contains('hidden'),
  pop: () => toHost({ t: 'pop' }),
  score: (score) => {
    // Report at most every scoreEveryMs, always ending on the latest score.
    party.pendingScore = score;
    if (party.scoreTimer) return;
    party.scoreTimer = setTimeout(() => {
      party.scoreTimer = 0;
      toHost({ t: 'score', score: party.pendingScore });
    }, PARTY.scoreEveryMs);
  },
  roundOver: (summary) => {
    toHost({ t: 'final', score: summary.score });
    renderResults();
  },
  leave: () => {
    leaveParty();
    goToMenu();
  },
});

/* ---------- Screens ---------- */

function readName() {
  const name = cleanName(pui.name.value) || `Player ${Math.floor(Math.random() * 90) + 10}`;
  pui.name.value = name;
  store.set(NAME_KEY, name);
  return name;
}

function setStatus(text, isError = false) {
  pui.status.textContent = text;
  pui.status.classList.toggle('error', isError);
}

function setBusy(text) {
  pui.create.disabled = Boolean(text);
  pui.joinBtn.disabled = Boolean(text);
  setStatus(text);
}

// The "create or join" screen.
function openParty(message = '') {
  ui.menu.classList.add('hidden');
  pui.overlay.classList.remove('hidden');
  pui.entry.hidden = false;
  pui.lobby.hidden = true;
  if (!pui.name.value) pui.name.value = store.get(NAME_KEY, '');
  setBusy('');
  setStatus(message, Boolean(message));
}

function closeParty() {
  party.attempt++; // abandon any create / join still connecting
  pui.overlay.classList.add('hidden');
  ui.menu.classList.remove('hidden');
}

function showLobby() {
  goToMenu(); // clears any finished round
  ui.menu.classList.add('hidden');
  pui.overlay.classList.remove('hidden');
  pui.entry.hidden = true;
  pui.lobby.hidden = false;
  renderLobby();
}

function renderLobby() {
  if (!party.role) return;
  pui.codeBig.textContent = party.code;
  pui.link.textContent = inviteLink();
  const me = party.roster.find((p) => p.id === party.myId);

  pui.teams.replaceChildren(
    ...TEAMS.map((team, t) => {
      const members = party.roster.filter((p) => p.team === t);
      const box = el('div', 'team');
      box.style.setProperty('--team', team.color);
      const head = el('h3');
      head.append(el('span', '', team.name), el('span', 'team-count', String(members.length)));
      const list = el('ul');
      if (members.length === 0) list.append(el('li', 'empty', 'Nobody yet'));
      for (const p of members) {
        const li = el('li', p.id === party.myId ? 'me' : '', p.name);
        if (p.host) li.append(el('span', 'tag', 'host'));
        if (p.id === party.myId) li.append(el('span', 'tag', 'you'));
        list.append(li);
      }
      box.append(head, list);
      if (me && me.team !== t) {
        const join = el('button', 'btn btn-ghost btn-small', `Join ${team.name}`);
        join.type = 'button';
        join.addEventListener('click', () => toHost({ t: 'team', team: t }));
        box.append(join);
      }
      return box;
    }),
  );

  const isHost = party.role === 'host';
  pui.hostControls.hidden = !isHost;
  pui.wait.hidden = isHost;
  if (isHost) {
    renderLengthPicker(pui.lengths, 'party-length');
    const ready = teamsReady();
    pui.start.disabled = !ready;
    pui.startNote.textContent = ready ? '' : 'Each team needs at least one player.';
  } else {
    const host = party.roster.find((p) => p.host);
    pui.wait.textContent = `${party.length}s round · waiting for ${host ? host.name : 'the host'} to start`;
  }
}

// The live "Blue 2,340 vs 1,200 Red" strip under the HUD.
function renderTeamBar() {
  if (!party.role) return;
  const totals = teamTotals(party.roster, (p) => scoreOf(p.id));
  const me = party.roster.find((p) => p.id === party.myId);
  const side = (t) => {
    const span = el('span', 'tb-team');
    span.style.setProperty('--team', TEAMS[t].color);
    const label = me && me.team === t ? `${TEAMS[t].name} (you)` : TEAMS[t].name;
    span.append(el('span', 'tb-name', label), el('b', '', fmt(totals[t])));
    return span;
  };
  ui.teambar.replaceChildren(side(0), el('span', 'tb-vs', 'vs'), side(1));
}

// The team battle part of the results card.
function renderResults() {
  const box = pui.results;
  if (!party.results) {
    box.replaceChildren(el('p', 'party-wait', 'Waiting for everyone to finish…'));
    renderOverActions();
    return;
  }
  const players = party.results;
  const totals = teamTotals(players, (p) => p.score);
  const winner = totals[0] === totals[1] ? -1 : totals[0] > totals[1] ? 0 : 1;
  const me = players.find((p) => p.id === party.myId);

  const headline = el('div', 'winner', winner === -1 ? 'It’s a tie' : `${TEAMS[winner].name} wins`);
  if (winner !== -1) headline.style.color = TEAMS[winner].color;
  let sub = '';
  if (me && winner !== -1) sub = me.team === winner ? 'Your team won!' : 'Your team lost.';

  const columns = el('div', 'teams team-results');
  TEAMS.forEach((team, t) => {
    const col = el('div', 'team');
    col.style.setProperty('--team', team.color);
    const head = el('h3');
    head.append(el('span', '', team.name), el('span', 'team-total', fmt(totals[t])));
    const list = el('ol');
    for (const p of players.filter((q) => q.team === t).sort((a, b) => b.score - a.score)) {
      const li = el('li', p.id === party.myId ? 'me' : '');
      li.append(el('span', 'tr-name', p.left ? `${p.name} (left)` : p.name), el('span', 'tr-score', fmt(p.score)));
      list.append(li);
    }
    col.append(head, list);
    columns.append(col);
  });

  box.replaceChildren(headline, el('div', 'winner-sub', sub), columns);
  renderOverActions();
}

function renderOverActions() {
  const isHost = party.role === 'host';
  const ready = isHost && party.results !== null && teamsReady();
  pui.again.hidden = !isHost;
  pui.toLobby.hidden = !isHost;
  pui.again.disabled = !ready;
  pui.toLobby.disabled = !isHost || party.results === null;
  if (!party.results) pui.overWait.textContent = '';
  else if (!isHost) pui.overWait.textContent = 'Waiting for the host…';
  else pui.overWait.textContent = ready ? '' : 'Each team needs at least one player. Go back to the lobby.';
}

/* ---------- Wiring ---------- */

pui.open.addEventListener('click', () => openParty());
pui.back.addEventListener('click', closeParty);
pui.create.addEventListener('click', createRoom);
pui.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinRoom(pui.code.value);
});
pui.code.addEventListener('input', () => {
  pui.code.value = pui.code.value.toUpperCase().replace(/[^A-Z]/g, '');
});
pui.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteLink());
    pui.copy.textContent = 'Copied!';
  } catch {
    pui.copy.textContent = 'Couldn’t copy. Use the link above.';
  }
  setTimeout(() => (pui.copy.textContent = 'Copy invite link'), 1800);
});
pui.lengths.addEventListener('change', (e) => {
  if (!(e.target instanceof HTMLInputElement) || party.role !== 'host') return;
  setLength(Number(e.target.value));
  room.length = settings.length;
  broadcastLobby();
  releaseMouseFocus(e.target);
});
pui.start.addEventListener('click', hostStart);
pui.leave.addEventListener('click', () => {
  leaveParty();
  openParty();
});
pui.again.addEventListener('click', hostStart);
pui.toLobby.addEventListener('click', hostToLobby);
pui.overLeave.addEventListener('click', () => {
  leaveParty();
  goToMenu();
});
window.addEventListener('pagehide', leaveParty);

// Invite links look like …/?room=ABCD: open the join screen with the code filled in.
const invitedCode = new URLSearchParams(location.search).get('room');
if (invitedCode && /^[A-Za-z]{4}$/.test(invitedCode)) {
  openParty();
  pui.code.value = invitedCode.toUpperCase();
  (pui.name.value ? pui.joinBtn : pui.name).focus();
}
