// Quiz da Live: servidor local.
// Lê o chat de uma live do TikTok e entrega cada comentário para a página do jogo.
// Só a biblioteca "tiktok-live-connector" é externa. O resto usa módulos do próprio Node.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Quando o jogo roda como programa .exe (Node "single executable"), a pasta public vem embutida no próprio arquivo.
let sea = null;
try { sea = typeof process.getBuiltinModule === 'function' ? process.getBuiltinModule('node:sea') : null; } catch { sea = null; }
const IS_EXE = !!(sea && typeof sea.isSea === 'function' && sea.isSea());
function embedded(name) {
  try { return Buffer.from(sea.getAsset(`public/${name}`)); } catch { return null; }
}

// No .exe a janela fecha sozinha quando o programa termina. Espera uma tecla para dar tempo de ler a mensagem.
function exitWithPause(code) {
  if (!IS_EXE || !process.stdin) process.exit(code);
  console.error('Pressione Enter para fechar esta janela.');
  process.stdin.resume();
  process.stdin.once('data', () => process.exit(code));
}

// ---------- argumentos: npm start -- @usuario --port 3000 --demo ----------
const args = process.argv.slice(2);
let argUser = null;
let argDemo = false;
let argPort = null;
let argOpen = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--demo') argDemo = true;
  else if (a === '--open') argOpen = true;
  else if (a === '--port') argPort = Number(args[++i]);
  else if (!a.startsWith('--')) argUser = a;
}
if (IS_EXE && args.length === 0) argOpen = true; // clicou duas vezes no .exe: abre o navegador sozinho
const PORT = argPort || Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ---------- estado e envio para as páginas abertas (SSE) ----------
const clients = new Set();
let status = { state: 'idle', message: 'Desconectado', username: null, demo: false };

let stage = { scene: null, tick: null, count: null, overlay: null, votes: [] };

function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(event, data) {
  for (const res of clients) sendEvent(res, event, data);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  console.log(`[status] ${status.state}: ${status.message}`);
  broadcast('status', status);
}
function emitChat(id, name, text, demo = false, avatar = null) {
  broadcast('chat', { id: String(id), name: String(name || id), text: String(text).slice(0, 200), ts: Date.now(), demo, av: avatar });
}

// Foto de perfil: a biblioteca entrega listas de endereços em formatos diferentes. Pega o primeiro https que o navegador sabe abrir.
let avatarWarned = false;
function pickAvatar(user, data) {
  const found = [];
  const walk = (v, depth = 0) => {
    if (depth > 3 || v == null) return;
    if (typeof v === 'string') found.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') { walk(v.url, depth + 1); walk(v.urls, depth + 1); walk(v.urlList, depth + 1); }
  };
  walk(user.profilePicture); walk(user.avatarThumb); walk(user.avatar); walk(user.profilePictureUrl); walk(data.profilePictureUrl);
  const ok = found.filter((u) => /^https:\/\//i.test(u) && !/\.heic(\?|$)/i.test(u));
  const best = ok.find((u) => /\.(jpe?g|webp|png)(\?|$)/i.test(u)) || ok[0] || null;
  if (!best && !avatarWarned) { avatarWarned = true; console.log('[chat] aviso: o evento veio sem foto de perfil. Os círculos vão mostrar a inicial do nome.'); }
  return best ? best.slice(0, 400) : null;
}

// ---------- TikTok ----------
let conn = null;
let lib = null;

function cleanUsername(raw) {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '');
}

async function disconnectTikTok() {
  const c = conn;
  conn = null;
  if (c) {
    try { await c.disconnect(); } catch { /* já estava desconectado */ }
  }
}

async function connectTikTok(rawUser) {
  await stopDemo(false);
  await disconnectTikTok();
  const username = cleanUsername(rawUser);
  if (!/^[A-Za-z0-9._]{2,40}$/.test(username)) {
    setStatus({ state: 'error', message: 'Usuário inválido. Use só letras, números, ponto e sublinhado.', username: null, demo: false });
    return;
  }
  setStatus({ state: 'connecting', message: `Conectando ao chat de @${username}...`, username, demo: false });

  try {
    if (!lib) {
      const mod = await import('tiktok-live-connector');
      lib = mod.TikTokLiveConnection ? mod : (mod.default || mod);
    }
  } catch {
    setStatus({ state: 'error', message: 'Falta instalar a biblioteca do TikTok. Rode "npm install" na pasta do jogo e reinicie.', username: null });
    return;
  }

  const { TikTokLiveConnection, WebcastEvent, ControlEvent } = lib;
  let c;
  try {
    // A biblioteca exige o segundo parâmetro (opções), mesmo vazio.
    c = new TikTokLiveConnection(username, {});
  } catch (err) {
    setStatus({ state: 'error', username: null, message: `Não foi possível iniciar a conexão: ${(err && err.message) || err}` });
    return;
  }
  conn = c;

  c.on(WebcastEvent.CHAT, (data) => {
    data = data || {};
    const user = data.user || {};
    const id = user.uniqueId || user.nickname || data.uniqueId || data.nickname || data.userId || user.userId;
    const text = data.comment ?? data.content ?? data.text ?? (data.common && data.common.displayText);
    if (!id || typeof text !== 'string' || !text) {
      console.log('[chat] evento ignorado (campos não reconhecidos):', JSON.stringify(data).slice(0, 300));
      return;
    }
    console.log(`[chat] ${id}: ${text}`);
    emitChat(id, user.nickname || data.nickname || id, text, false, pickAvatar(user, data));
  });
  c.on(ControlEvent.DISCONNECTED, ({ code, reason } = {}) => {
    if (conn !== c) return;
    conn = null;
    setStatus({ state: 'idle', message: `Desconectado do TikTok${code ? ` (${code})` : ''}${reason ? `: ${reason}` : ''}`, username: null });
  });
  c.on(ControlEvent.ERROR, ({ info, exception } = {}) => {
    console.error('[tiktok] erro:', info, exception && exception.message);
  });
  c.on(WebcastEvent.STREAM_END, () => {
    if (conn !== c) return;
    setStatus({ message: 'A live foi encerrada.' });
  });

  try {
    await c.connect();
    if (conn !== c) return;
    setStatus({ state: 'connected', message: `Conectado ao chat de @${username}`, username });
  } catch (err) {
    if (conn === c) conn = null;
    const offline = (err && err.name === 'UserOfflineError') || /offline|not live|isn't live/i.test(String(err && err.message));
    setStatus({
      state: 'error',
      username: null,
      message: offline ? `@${username} não está ao vivo agora. Inicie a live e tente de novo.` : `Não foi possível conectar: ${(err && err.message) || err}`
    });
  }
}

// ---------- modo demonstração (espectadores simulados) ----------
const FIRST = ['ana', 'joao', 'mari', 'lucas', 'bia', 'pedro', 'gabi', 'rafa', 'duda', 'caio', 'lari', 'theo', 'nina', 'davi', 'leo', 'sofia', 'igor', 'clara', 'enzo', 'vivi'];
const SUFFIX = ['.silva', '_oficial', '22', '.dev', '_br', '07', '.souza', 'zinho', '_live', '99'];
const BOTS = Array.from({ length: 34 }, (_, i) => ({
  id: `${FIRST[i % FIRST.length]}${SUFFIX[(i * 3) % SUFFIX.length]}`,
  skill: 0.2 + Math.random() * 0.7
})).map((b) => ({ ...b, name: b.id.replace(/[._]/g, ' ') }));
const CHATTER = ['kkkkk', 'boa!', 'qual é a certa?', 'eu sei essa', 'oi pessoal', 'primeira vez aqui', 'dificil hein', 'salve', 'pergunta boa'];
const LETTERS = ['A', 'B', 'C', 'D'];

let demoTimer = null;
let demoHint = null;
let demoLevel = 1;
let demoAnswered = new Set();

function demoStep() {
  if (!status.demo) return; // demonstração encerrada: não continua
  const bot = BOTS[Math.floor(Math.random() * BOTS.length)];
  if (demoHint && !demoAnswered.has(bot.id) && Math.random() < 0.9) {
    demoAnswered.add(bot.id);
    let letter = demoHint;
    if (Math.random() > bot.skill * (demoLevel === 3 ? 0.55 : demoLevel === 2 ? 0.8 : 1)) {
      const others = LETTERS.filter((l) => l !== demoHint);
      letter = others[Math.floor(Math.random() * others.length)];
    }
    emitChat(bot.id, bot.name, Math.random() < 0.2 ? letter.toLowerCase() : letter, true);
  } else if (Math.random() < 0.5) {
    emitChat(bot.id, bot.name, CHATTER[Math.floor(Math.random() * CHATTER.length)], true);
  }
  demoTimer = setTimeout(demoStep, 150 + Math.random() * 450);
}
async function startDemo() {
  clearTimeout(demoTimer);
  demoAnswered = new Set();
  await disconnectTikTok();
  clearTimeout(demoTimer);
  setStatus({ state: 'demo', message: 'Modo demonstração: espectadores simulados no chat', username: null, demo: true });
  demoTimer = setTimeout(demoStep, 400);
}
async function stopDemo(announce = true) {
  clearTimeout(demoTimer);
  demoTimer = null;
  demoHint = null;
  if (announce && status.demo) setStatus({ state: 'idle', message: 'Demonstração encerrada', demo: false });
  else status = { ...status, demo: false };
}

// Abre o jogo no navegador padrão (usado pelo atalho "Iniciar Quiz").
function openBrowser(url) {
  try {
    const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* se não abrir sozinho, o usuário abre o endereço na mão */ }
}

// ---------- HTTP ----------
function readBody(req, max = 4096) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > max) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}
function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function originOk(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
}

const server = http.createServer(async (req, res) => {
  if (!originOk(req)) { res.writeHead(403); res.end('Acesso negado'); return; }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('retry: 2000\n\n');
    sendEvent(res, 'status', status);
    // Quem abre a janela do palco depois já recebe o que está na tela agora.
    for (const k of ['scene', 'tick', 'count', 'overlay']) if (stage[k]) sendEvent(res, 'stage', stage[k]);
    if (stage.votes.length) sendEvent(res, 'stage', { t: 'votes', list: stage.votes });
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const body = await readBody(req, url.pathname === '/api/stage' ? 262144 : 4096);
    if (url.pathname === '/api/stage') {
      // O painel envia o palco; a janela /?palco (inclusive no OBS) só recebe e mostra.
      let msg;
      if (body.t === 'scene') {
        msg = { t: 'scene', cls: String(body.cls || ''), html: String(body.html || '') };
        stage.scene = msg; stage.tick = null; stage.count = null; stage.votes = [];
      } else if (body.t === 'votes') {
        const list = (Array.isArray(body.list) ? body.list : []).slice(0, 100).map((v) => ({
          i: Math.min(3, Math.max(0, Number(v && v.i) | 0)),
          name: String((v && v.name) || '?').slice(0, 40),
          av: v && typeof v.av === 'string' && /^https:\/\//i.test(v.av) ? v.av.slice(0, 400) : null
        }));
        msg = { t: 'votes', list };
        stage.votes = stage.votes.concat(list).slice(-400);
      } else if (body.t === 'tick') {
        msg = { t: 'tick', off: String(body.off), num: String(body.num), urgent: !!body.urgent };
        stage.tick = msg;
      } else if (body.t === 'count') {
        msg = { t: 'count', n: Number(body.n) || 0 };
        stage.count = msg;
      } else if (body.t === 'overlay') {
        msg = { t: 'overlay', hidden: !!body.hidden, html: String(body.html || '') };
        stage.overlay = msg;
      } else return json(res, 400, { error: 'tipo desconhecido' });
      broadcast('stage', msg);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/connect') { connectTikTok(body.username); return json(res, 202, { ok: true }); }
    if (url.pathname === '/api/disconnect') {
      await stopDemo(false);
      await disconnectTikTok();
      setStatus({ state: 'idle', message: 'Desconectado', username: null, demo: false });
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/demo') {
      if (body.on) await startDemo(); else await stopDemo(true);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/hint') {
      if (status.demo && LETTERS.includes(body.correct)) { demoHint = body.correct; demoLevel = [1, 2, 3].includes(body.d) ? body.d : 1; demoAnswered = new Set(); }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'rota desconhecida' });
  }

  if (req.method === 'GET') {
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (IS_EXE) {
      const name = path.posix.normalize(rel).replace(/^\/+/, '');
      const data = name.includes('..') ? null : embedded(name);
      if (!data) { res.writeHead(404); res.end('Não encontrado'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('Acesso negado'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Não encontrado'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(405); res.end();
});

setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 20000).unref();

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nA porta ${PORT} já está em uso. Provavelmente o jogo já está aberto em outra janela.`);
    console.error('Feche a outra janela do jogo e tente de novo, ou use outra porta (npm start -- --port 3001).\n');
  } else console.error('\nErro no servidor:', (err && err.message) || err);
  exitWithPause(1);
});

server.listen(PORT, HOST, () => {
  console.log(`\nQuiz da Live rodando em http://localhost:${PORT}\n`);
  console.log('Deixe esta janela aberta enquanto estiver jogando. Para encerrar, feche esta janela.\n');
  if (argOpen) openBrowser(`http://localhost:${PORT}`);
  if (argDemo) startDemo();
  else if (argUser) connectTikTok(argUser);
});

function shutdown() {
  console.log('\nEncerrando...');
  stopDemo(false).then(disconnectTikTok).finally(() => process.exit(0));
}
// Um erro inesperado na conexão do TikTok não derruba mais o jogo: ele aparece na página.
process.on('unhandledRejection', (err) => {
  console.error('[erro]', (err && err.message) || err);
  conn = null;
  setStatus({ state: 'error', username: null, message: `Erro na conexão com o TikTok: ${(err && err.message) || err}` });
});
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  console.error('\n[erro fatal]', (err && err.stack) || err);
  exitWithPause(1);
});
