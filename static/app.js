// ─── 設定（localStorage に永続保存） ───────────────────────────────────────
const STORE_KEYS = {
  apiKey:    'nr_anthropic_key',
  openaiKey: 'nr_openai_key',
  tts:       'nr_tts_provider',
  hour:      'nr_schedule_hour',
};

function loadSettings() {
  return {
    apiKey:    localStorage.getItem(STORE_KEYS.apiKey)    || '',
    openaiKey: localStorage.getItem(STORE_KEYS.openaiKey) || '',
    tts:       localStorage.getItem(STORE_KEYS.tts)       || 'gtts',
    hour:      parseInt(localStorage.getItem(STORE_KEYS.hour) || '6', 10),
  };
}

function persistSettings(s) {
  localStorage.setItem(STORE_KEYS.apiKey,    s.apiKey);
  localStorage.setItem(STORE_KEYS.openaiKey, s.openaiKey);
  localStorage.setItem(STORE_KEYS.tts,       s.tts);
  localStorage.setItem(STORE_KEYS.hour,      String(s.hour));
}

// ─── API 呼び出し ──────────────────────────────────────────────────────────
function apiHeaders() {
  const s = loadSettings();
  const h = { 'Content-Type': 'application/json' };
  if (s.apiKey)    h['X-API-Key']       = s.apiKey;
  if (s.openaiKey) h['X-OpenAI-Key']    = s.openaiKey;
  if (s.tts)       h['X-TTS-Provider']  = s.tts;
  return h;
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(path, { headers: apiHeaders(), ...opts });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// ─── 状態 ─────────────────────────────────────────────────────────────────
let pollTimer = null;
let chatPollTimer = null;
let activeTab = 'home';
let todayStr = new Date().toLocaleDateString('sv');  // YYYY-MM-DD

// ─── 起動 ─────────────────────────────────────────────────────────────────
async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/static/sw.js').catch(() => {});
  }

  const s = loadSettings();

  if (!s.apiKey) {
    showScreen('onboarding');
    return;
  }

  showScreen('main');
  populateSettings(s);
  await checkAndLoadToday();
}

// ─── 画面切り替え ─────────────────────────────────────────────────────────
function showScreen(name) {
  document.getElementById('screen-onboarding').style.display = name === 'onboarding' ? '' : 'none';
  document.getElementById('screen-main').style.display       = name === 'main'       ? '' : 'none';
}

// ─── タブ切り替え ─────────────────────────────────────────────────────────
function switchTab(tab) {
  activeTab = tab;
  ['home', 'chat', 'archive', 'settings'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === tab ? '' : 'none';
    document.querySelector(`.tab-btn[data-tab="${t}"]`)
            .classList.toggle('active', t === tab);
  });

  if (tab === 'archive') loadArchive();
}

// ─── オンボーディング ─────────────────────────────────────────────────────
function onboardingSubmit() {
  const key = document.getElementById('onboarding-key').value.trim();
  if (!key) { showToast('APIキーを入力してください'); return; }
  persistSettings({ ...loadSettings(), apiKey: key });
  showScreen('main');
  populateSettings(loadSettings());
  checkAndLoadToday();
}

// ─── 今日の放送 ───────────────────────────────────────────────────────────
async function checkAndLoadToday() {
  showHomeState('generating');

  // まず既存のデータを確認
  try {
    const data = await apiFetch(`/api/broadcasts/${todayStr}`);
    showPlayer(data);
    return;
  } catch (e) {
    if (!e.message.startsWith('404')) {
      showHomeState('error', e.message);
      return;
    }
  }

  // ない場合はスケジュール時刻を過ぎていれば自動生成
  const s = loadSettings();
  const nowHour = new Date().getHours();
  if (nowHour >= s.hour) {
    await startDailyGeneration();
  } else {
    showHomeState('empty');
  }
}

async function startDailyGeneration() {
  showHomeState('generating');
  stopPoll();

  try {
    await apiFetch('/api/generate', { method: 'POST' });
    pollTimer = setInterval(pollDaily, 4000);
  } catch (e) {
    showHomeState('error', e.message);
  }
}

async function pollDaily() {
  try {
    const s = await apiFetch(`/api/status/${todayStr}`);
    if (s.status === 'done') {
      stopPoll();
      const data = await apiFetch(`/api/broadcasts/${todayStr}`);
      showPlayer(data);
    } else if (s.status === 'error') {
      stopPoll();
      showHomeState('error', '生成に失敗しました。再試行してください。');
    }
  } catch (e) {
    stopPoll();
    showHomeState('error', e.message);
  }
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function showHomeState(state, msg = '') {
  ['generating', 'error', 'player', 'empty'].forEach(s => {
    document.getElementById(`home-${s}`).style.display = s === state ? '' : 'none';
  });
  if (state === 'error' && msg) {
    document.getElementById('home-error-msg').textContent = msg;
  }
}

function showPlayer(data) {
  showHomeState('player');

  const d = new Date(data.date + 'T00:00:00');
  document.getElementById('player-date').textContent = d.toLocaleDateString('ja-JP', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
  });
  document.getElementById('player-count').textContent = `${data.news_count}件のニュース`;
  document.getElementById('home-script').textContent = data.script || '';

  const audio = document.getElementById('main-audio');
  if (data.audio_url) {
    audio.src = data.audio_url;
    audio.load();
    bindAudioEvents(audio, 'main-seek', 'main-current', 'main-duration', 'play-btn');
  }

  const list = document.getElementById('home-news-list');
  list.innerHTML = '';
  (data.news_items || []).forEach(item => {
    const li = document.createElement('li');
    li.className = 'news-item';
    li.innerHTML = `
      <div class="news-item-meta">
        <span class="news-cat">${item.category}</span>
        <span class="news-src">${item.source}</span>
      </div>
      <div class="news-title"><a href="${item.url}" target="_blank" rel="noopener">${item.title}</a></div>
      <div class="news-summary">${item.summary}</div>
    `;
    list.appendChild(li);
  });
}

// ─── アーカイブ ───────────────────────────────────────────────────────────
async function loadArchive() {
  const list = document.getElementById('archive-list');
  list.innerHTML = '<li class="list-loading">読み込み中...</li>';

  try {
    const broadcasts = await apiFetch('/api/broadcasts');
    if (!broadcasts.length) {
      list.innerHTML = '<li class="list-loading">過去の放送はありません</li>';
      return;
    }
    list.innerHTML = '';
    broadcasts.forEach(b => {
      const d = new Date(b.date + 'T00:00:00');
      const formatted = d.toLocaleDateString('ja-JP', {
        year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
      });
      const li = document.createElement('li');
      li.className = 'archive-item';
      li.innerHTML = `
        <div>
          <div class="archive-date">${formatted}</div>
          <div class="archive-meta">${b.news_count}件 · ${b.has_audio ? '音声あり' : 'テキストのみ'}</div>
        </div>
        <span class="archive-play">${b.has_audio ? '▶' : '📄'}</span>
      `;
      li.onclick = () => {
        switchTab('home');
        loadDateBroadcast(b.date);
      };
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li class="list-loading">読み込み失敗: ${e.message}</li>`;
  }
}

async function loadDateBroadcast(dateStr) {
  showHomeState('generating');
  try {
    const data = await apiFetch(`/api/broadcasts/${dateStr}`);
    showPlayer(data);
  } catch (e) {
    showHomeState('error', e.message);
  }
}

// ─── チャット ─────────────────────────────────────────────────────────────
function fillExample(btn) {
  document.getElementById('chat-input').value = btn.textContent;
  autoResize(document.getElementById('chat-input'));
}

function chatKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  const sendBtn = document.querySelector('.send-btn');
  input.value = '';
  autoResize(input);
  sendBtn.disabled = true;

  const messages = document.getElementById('chat-messages');

  // ヒントを消す
  const hint = messages.querySelector('.chat-hint');
  if (hint) hint.remove();

  // ユーザーバブル
  const userBubble = document.createElement('div');
  userBubble.className = 'bubble-user';
  userBubble.textContent = text;
  messages.appendChild(userBubble);

  // タイピングインジケーター
  const typing = document.createElement('div');
  typing.className = 'bubble-typing';
  typing.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
  messages.appendChild(typing);
  messages.scrollTop = messages.scrollHeight;

  try {
    const res = await apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt: text }),
    });

    chatPollTimer = setInterval(() => pollChat(res.job_id, typing, messages, sendBtn), 4000);
  } catch (e) {
    typing.remove();
    appendErrorBubble(messages, e.message);
    sendBtn.disabled = false;
  }
}

async function pollChat(jobId, typingEl, messages, sendBtn) {
  try {
    const job = await apiFetch(`/api/chat/${jobId}`);

    if (job.status === 'done') {
      clearInterval(chatPollTimer);
      typingEl.remove();
      appendAIBubble(messages, job);
      sendBtn.disabled = false;
      messages.scrollTop = messages.scrollHeight;
    } else if (job.status === 'error') {
      clearInterval(chatPollTimer);
      typingEl.remove();
      appendErrorBubble(messages, job.error || '生成に失敗しました');
      sendBtn.disabled = false;
    }
  } catch (e) {
    clearInterval(chatPollTimer);
    typingEl.remove();
    appendErrorBubble(messages, e.message);
    sendBtn.disabled = false;
  }
}

function appendAIBubble(container, job) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble-ai';

  const audioId = `chat-audio-${Date.now()}`;
  const seekId  = `chat-seek-${Date.now()}`;
  const curId   = `chat-cur-${Date.now()}`;
  const durId   = `chat-dur-${Date.now()}`;
  const btnId   = `chat-btn-${Date.now()}`;

  bubble.innerHTML = `
    <div class="bubble-ai-inner">カスタムニュースを生成しました</div>
    ${job.audio_url ? `
    <div class="chat-player">
      <audio id="${audioId}" src="${job.audio_url}" preload="none"></audio>
      <div class="chat-player-controls">
        <button class="play-btn-sm" id="${btnId}" onclick="togglePlay('${audioId}','${btnId}')">▶</button>
        <div class="progress-wrap">
          <input type="range" id="${seekId}" class="seek-bar" value="0" min="0" step="0.1"
                 oninput="seekAudio('${audioId}','${seekId}')">
          <div class="time-row">
            <span id="${curId}">0:00</span>
            <span id="${durId}">–:––</span>
          </div>
        </div>
      </div>
    </div>` : '<div class="bubble-ai-inner">音声の生成に失敗しました</div>'}
  `;

  container.appendChild(bubble);

  if (job.audio_url) {
    setTimeout(() => {
      bindAudioEvents(
        document.getElementById(audioId),
        seekId, curId, durId, btnId
      );
    }, 50);
  }
}

function appendErrorBubble(container, msg) {
  const bubble = document.createElement('div');
  bubble.className = 'bubble-ai';
  bubble.innerHTML = `<div class="bubble-ai-inner">⚠️ ${msg}</div>`;
  container.appendChild(bubble);
}

// ─── 設定 ─────────────────────────────────────────────────────────────────
function populateSettings(s) {
  document.getElementById('setting-anthropic-key').value = s.apiKey;
  document.getElementById('setting-openai-key').value    = s.openaiKey;
  document.getElementById('setting-hour').value          = String(s.hour);
  document.getElementById(s.tts === 'openai' ? 'tts-openai' : 'tts-gtts').checked = true;
}

function saveSettings() {
  const s = {
    apiKey:    document.getElementById('setting-anthropic-key').value.trim(),
    openaiKey: document.getElementById('setting-openai-key').value.trim(),
    tts:       document.querySelector('input[name="tts"]:checked')?.value || 'gtts',
    hour:      parseInt(document.getElementById('setting-hour').value, 10),
  };
  if (!s.apiKey) { showToast('Anthropic APIキーを入力してください'); return; }
  persistSettings(s);
  showToast('設定を保存しました ✓');
}

// ─── 音声プレイヤー ───────────────────────────────────────────────────────
function bindAudioEvents(audio, seekId, curId, durId, btnId) {
  const seek = document.getElementById(seekId);
  const cur  = document.getElementById(curId);
  const dur  = document.getElementById(durId);
  const btn  = document.getElementById(btnId);
  if (!audio || !seek) return;

  audio.addEventListener('loadedmetadata', () => {
    seek.max = audio.duration;
    dur.textContent = formatTime(audio.duration);
  });

  audio.addEventListener('timeupdate', () => {
    seek.value = audio.currentTime;
    cur.textContent = formatTime(audio.currentTime);
    // シークバーの進捗を色で表示
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    seek.style.background = `linear-gradient(to right, var(--accent) ${pct}%, var(--border) ${pct}%)`;
  });

  audio.addEventListener('ended', () => {
    if (btn) btn.textContent = '▶';
  });
}

function togglePlay(audioId, btnId) {
  const audio = document.getElementById(audioId);
  const btn   = document.getElementById(btnId);
  if (!audio) return;

  if (audio.paused) {
    // 他の再生中の音声を停止
    document.querySelectorAll('audio').forEach(a => {
      if (a !== audio && !a.paused) { a.pause(); }
    });
    audio.play();
    if (btn) btn.textContent = '⏸';
  } else {
    audio.pause();
    if (btn) btn.textContent = '▶';
  }
}

function seekAudio(audioId, seekId) {
  const audio = document.getElementById(audioId);
  const seek  = document.getElementById(seekId);
  if (audio && seek) audio.currentTime = parseFloat(seek.value);
}

function setSpeed(audioId, rate, btn) {
  const audio = document.getElementById(audioId);
  if (audio) audio.playbackRate = rate;
  btn.closest('.speed-row').querySelectorAll('.speed-btn')
     .forEach(b => b.classList.toggle('active', b === btn));
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── UI ユーティリティ ────────────────────────────────────────────────────
function toggleVis(inputId) {
  const el = document.getElementById(inputId);
  el.type = el.type === 'password' ? 'text' : 'password';
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

function showToast(msg, duration = 2500) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ─── 起動 ─────────────────────────────────────────────────────────────────
init();
