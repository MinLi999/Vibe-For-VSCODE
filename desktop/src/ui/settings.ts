/**
 * Settings window renderer (viewer layer): renders state, forwards user intents over the
 * bridge, never talks to the network or filesystem itself. No framework — each tab is
 * re-rendered from SettingsState after every mutation; events go through delegation.
 */
import type { SettingsState, StateEvent, VibefoxBridge } from '../ipc';
import type { DictionaryEntry } from '../../../client/src/models/UserDictionary';

declare global {
  interface Window {
    vibefox: VibefoxBridge;
  }
}

const api = window.vibefox;
let state: SettingsState;
let activeTab = 'home';
let editingWord: string | null = null;
let dictFilter = '';
let historyFilter = '';

// ---------- small utilities ----------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing #${id}`);
  }
  return node as T;
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';
}

let toastTimer: number | undefined;
function toast(message: string): void {
  const node = el<HTMLDivElement>('toast');
  node.textContent = message;
  node.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove('show'), 2200);
}

function fmtDate(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Hand-typing runs ~40 chars/min for mixed zh/en; speech lands ~200. The delta is "time saved". */
function savedMinutes(chars: number): number {
  return Math.max(0, Math.round(chars / 40 - chars / 200));
}

function todayChars(): number {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return state.stats.days[key]?.chars ?? 0;
}

// ---------- tab: home ----------

function renderHome(): void {
  const saved = savedMinutes(state.stats.totalChars);
  const entries = state.history.filter((h) => historyFilter === '' || h.text.toLowerCase().includes(historyFilter.toLowerCase()));
  el('tab-home').innerHTML = `
    <div class="cards">
      <div class="card"><div class="num">${todayChars().toLocaleString()}</div><div class="lbl">今日字数</div></div>
      <div class="card"><div class="num">${state.stats.totalChars.toLocaleString()}</div><div class="lbl">累计字数</div></div>
      <div class="card"><div class="num">${state.stats.totalSessions.toLocaleString()}</div><div class="lbl">录音次数</div></div>
      <div class="card"><div class="num">${saved >= 60 ? `${Math.floor(saved / 60)} 时 ${saved % 60} 分` : `${saved} 分钟`}</div><div class="lbl">估算节省时间(按手打 40 字/分)</div></div>
    </div>
    <div class="panel">
      <div class="row">
        <button class="btn primary" data-action="toggle-record">${state.phase === 'recording' ? '■ 停止录音并转写' : '● 开始录音'}</button>
        <span class="muted">全局热键 <kbd>${esc(state.config.hotkey)}</kbd> 在任何应用中可用,转写结果粘贴到当前光标处。</span>
      </div>
    </div>
    <div class="panel">
      <h3>转写历史<span class="hint">仅保存在本机,点击任意一条复制全文</span></h3>
      <div class="row">
        <input type="text" id="history-filter" placeholder="搜索历史…" value="${esc(historyFilter)}" style="flex:1" />
        <button class="btn danger" data-action="clear-history" ${state.history.length === 0 ? 'disabled' : ''}>清空</button>
      </div>
      ${entries.length === 0 ? '<p class="muted">(暂无记录)</p>' : entries
        .map(
          (h, i) => `
        <div class="list-item" data-action="copy-history" data-index="${i}">
          <span class="when">${fmtDate(h.at)}</span>
          <span class="txt">${esc(h.text)}</span>
        </div>`,
        )
        .join('')}
    </div>`;
  const filter = document.getElementById('history-filter') as HTMLInputElement | null;
  filter?.addEventListener('input', () => {
    historyFilter = filter.value;
    renderHome();
    (document.getElementById('history-filter') as HTMLInputElement | null)?.focus();
  });
}

// ---------- tab: dictionary ----------

function sourceBadge(entry: DictionaryEntry): string {
  if (entry.source === 'learned') {
    return '<span class="badge">✨ 学习</span>';
  }
  if (entry.source === 'contacts') {
    return '<span class="badge">👤 通讯录</span>';
  }
  return '';
}

function renderDict(): void {
  const entries = state.dictionary.entries.filter(
    (e) =>
      dictFilter === '' ||
      e.word.toLowerCase().includes(dictFilter.toLowerCase()) ||
      e.aliases.some((a) => a.toLowerCase().includes(dictFilter.toLowerCase())),
  );
  el('tab-dict').innerHTML = `
    <div class="panel">
      <h3>${editingWord === null ? '添加词条' : `编辑「${esc(editingWord)}」`}<span class="hint">人名、产品名、代码标识符——凡是常被听错的词都值得加</span></h3>
      <div class="row">
        <input type="text" id="dict-word" placeholder="正确写法,如 useEffect" style="flex:1" />
        <input type="text" id="dict-aliases" placeholder="常被误识成…(可选,逗号分隔)" style="flex:1" />
        <button class="btn primary" data-action="save-entry">${editingWord === null ? '添加' : '保存'}</button>
        ${editingWord === null ? '' : '<button class="btn" data-action="cancel-edit">取消</button>'}
      </div>
      <p class="muted">词库总量不限(上限 10,000 条);每次转写自动挑选最相关的 ≤40 个词做识别偏置,常用词自动优先。</p>
    </div>
    <div class="panel">
      <h3>词条<span class="hint">共 ${state.dictionary.entries.length} 条</span></h3>
      <div class="row">
        <input type="text" id="dict-filter" placeholder="搜索词条…" value="${esc(dictFilter)}" style="flex:1" />
        <button class="btn" data-action="export-dict">导出 JSON</button>
        <button class="btn" data-action="show-import">导入…</button>
      </div>
      <div id="import-area" hidden>
        <div class="row">
          <textarea id="import-json" placeholder='粘贴导出的 JSON,或 {"entries":[{"word":"..."}]}' style="flex:1;min-height:70px"></textarea>
        </div>
        <div class="row"><button class="btn primary" data-action="import-dict">导入并合并</button></div>
      </div>
      ${entries.length === 0 ? '<p class="muted">(空——从上方添加第一个词)</p>' : `
      <table><thead><tr><th>词</th><th>常被误识成</th><th>命中</th><th></th></tr></thead><tbody>
        ${entries
          .map(
            (e) => `
        <tr>
          <td>${esc(e.word)}${sourceBadge(e)}</td>
          <td class="alias">${esc(e.aliases.join('、'))}</td>
          <td class="muted">${e.hits}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn" data-action="edit-entry" data-word="${esc(e.word)}">编辑</button>
            <button class="btn danger" data-action="remove-entry" data-word="${esc(e.word)}">删除</button>
          </td>
        </tr>`,
          )
          .join('')}
      </tbody></table>`}
    </div>
    <div class="panel">
      <h3>替换规则<span class="hint">转写完成后在本机执行的确定性替换,不限数量、不耗额度</span></h3>
      <div class="row">
        <input type="text" id="rep-from" placeholder="把这个…(如:艾特符号)" style="flex:1" />
        <input type="text" id="rep-to" placeholder="替换成这个…(如:@)" style="flex:1" />
        <label><input type="checkbox" id="rep-case" /> 区分大小写</label>
        <button class="btn primary" data-action="add-replacement">添加</button>
      </div>
      ${state.dictionary.replacements.length === 0 ? '<p class="muted">(空)适合:邮箱地址、符号口令、强制大小写的术语。</p>' : `
      <table><thead><tr><th>原文</th><th>替换为</th><th></th></tr></thead><tbody>
        ${state.dictionary.replacements
          .map(
            (r) => `
        <tr>
          <td>${esc(r.from)}${r.caseSensitive ? '<span class="badge">Aa</span>' : ''}</td>
          <td>${esc(r.to)}</td>
          <td style="text-align:right"><button class="btn danger" data-action="remove-replacement" data-from="${esc(r.from)}">删除</button></td>
        </tr>`,
          )
          .join('')}
      </tbody></table>`}
    </div>`;
  const filter = document.getElementById('dict-filter') as HTMLInputElement | null;
  filter?.addEventListener('input', () => {
    dictFilter = filter.value;
    renderDict();
    const again = document.getElementById('dict-filter') as HTMLInputElement | null;
    again?.focus();
    again?.setSelectionRange(again.value.length, again.value.length);
  });
  if (editingWord !== null) {
    const entry = state.dictionary.entries.find((e) => e.word === editingWord);
    if (entry !== undefined) {
      (el<HTMLInputElement>('dict-word')).value = entry.word;
      (el<HTMLInputElement>('dict-aliases')).value = entry.aliases.join(', ');
    }
  }
}

// ---------- tab: style ----------

const REWRITE_CARDS: [string, string, string][] = [
  ['off', '原样转写', '一字不动,听到什么出什么'],
  ['clean', '智能清理(推荐)', '去嗯啊语气词、修标点、按词库校正拼写,不改语序'],
  ['rewrite', '深度润色', '折叠改口、轻度重组、口述列表自动排版成编号列表'],
];

function renderStyle(): void {
  const c = state.config;
  el('tab-style').innerHTML = `
    <div class="panel">
      <h3>改写模式</h3>
      <div class="radio-cards">
        ${REWRITE_CARDS.map(
          ([value, title, desc]) => `
        <div class="radio-card ${c.rewriteMode === value ? 'selected' : ''}" data-action="set-rewrite" data-value="${value}">
          <div class="t">${title}</div><div class="d">${desc}</div>
        </div>`,
        ).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>语言与地区</h3>
      <div class="row"><label class="field">转写语言</label>
        <select data-config="language">
          <option value="auto" ${c.language === 'auto' ? 'selected' : ''}>自动检测(推荐,中英混说最佳)</option>
          <option value="zh" ${c.language === 'zh' ? 'selected' : ''}>强制中文</option>
          <option value="en" ${c.language === 'en' ? 'selected' : ''}>强制英文</option>
        </select></div>
      <div class="row"><label class="field">中文变体</label>
        <select data-config="chineseVariant">
          <option value="simplified-cn" ${c.chineseVariant === 'simplified-cn' ? 'selected' : ''}>简体 · 大陆</option>
          <option value="simplified-sg-my" ${c.chineseVariant === 'simplified-sg-my' ? 'selected' : ''}>简体 · 新马</option>
          <option value="traditional-tw" ${c.chineseVariant === 'traditional-tw' ? 'selected' : ''}>繁體 · 台灣</option>
          <option value="traditional-hk-mo" ${c.chineseVariant === 'traditional-hk-mo' ? 'selected' : ''}>繁體 · 港澳</option>
        </select></div>
      <div class="row"><label class="field">转写区域</label>
        <select data-config="dashscopeRegion">
          <option value="auto" ${c.dashscopeRegion === 'auto' ? 'selected' : ''}>自动(按大洲就近)</option>
          <option value="apac" ${c.dashscopeRegion === 'apac' ? 'selected' : ''}>新加坡区</option>
          <option value="us" ${c.dashscopeRegion === 'us' ? 'selected' : ''}>美国区</option>
        </select></div>
    </div>
    <div class="panel">
      <h3>流式转写<span class="hint">实验性 · 需质量档 License Key</span></h3>
      <div class="row">
        <label><input type="checkbox" data-config="streamingMode" ${c.streamingMode ? 'checked' : ''} /> 边说边转写,整句定稿即粘贴;任何失败自动回落普通模式</label>
      </div>
    </div>`;
}

// ---------- tab: settings ----------

let capturedHotkey: string | null = null;

function renderSettings(): void {
  const c = state.config;
  el('tab-settings').innerHTML = `
    <div class="panel">
      <h3>热键</h3>
      <div class="row">
        <label class="field">录音热键</label>
        <input type="text" id="hotkey-input" readonly value="${esc(c.hotkey)}" placeholder="点击后按下组合键" style="width:220px" />
        <button class="btn primary" data-action="apply-hotkey" disabled id="hotkey-apply">应用</button>
        <span class="muted" id="hotkey-msg">点击输入框,按下想用的组合键</span>
      </div>
    </div>
    <div class="panel">
      <h3>账户与服务</h3>
      <div class="row">
        <label class="field">License Key</label>
        <span class="${state.licenseKeyPresent ? 'status-ok' : 'status-warn'}">${state.licenseKeyPresent ? '已设置 ✓(存于系统钥匙串)' : '未设置'}</span>
      </div>
      <div class="row">
        <input type="password" id="license-input" placeholder="粘贴 License Key…" style="flex:1" />
        <button class="btn primary" data-action="set-license">保存</button>
        <button class="btn danger" data-action="clear-license" ${state.licenseKeyPresent ? '' : 'disabled'}>清除</button>
      </div>
      <div class="row">
        <label class="field">服务地址</label>
        <input type="text" id="endpoint-input" value="${esc(c.endpoint)}" style="flex:1" />
        <button class="btn" data-action="save-endpoint">保存</button>
        <button class="btn" data-action="reset-endpoint" ${c.endpoint === state.officialEndpoint ? 'disabled' : ''}>恢复官方地址</button>
      </div>
      <p class="muted">自托管:部署 server/ 到自己的 Cloudflare Worker 后把地址填到这里(见 docs/SELF_HOSTING.md);转写引擎密钥只存在 Worker 端。</p>
    </div>
    <div class="panel">
      <h3>录音</h3>
      <div class="row">
        <label class="field">单次录音上限(秒)</label>
        <input type="number" id="max-seconds" min="3" max="600" value="${c.maxRecordSeconds}" style="width:100px" />
        <button class="btn" data-action="save-max-seconds">保存</button>
      </div>
      <div class="row"><label><input type="checkbox" data-config="vadEnabled" ${c.vadEnabled ? 'checked' : ''} /> 静音自动分段(长口述边说边出字,推荐开启)</label></div>
      <div class="row"><label><input type="checkbox" data-config="restoreClipboard" ${c.restoreClipboard ? 'checked' : ''} /> 粘贴后约 1 秒恢复原剪贴板内容</label></div>
      <div class="row">
        <label class="field">麦克风测试</label>
        <button class="btn" data-action="mic-test" id="mic-test-btn">开始测试</button>
        <div class="meter"><div id="mic-meter"></div></div>
      </div>
    </div>
    <div class="panel">
      <h3>权限</h3>
      <div class="row">
        <label class="field">辅助功能</label>
        <span class="${state.accessibilityTrusted ? 'status-ok' : 'status-warn'}">${state.accessibilityTrusted ? '已授权 ✓' : '未授权 — 自动粘贴不可用'}</span>
        ${state.accessibilityTrusted ? '' : '<button class="btn" data-action="request-accessibility">去授权…</button>'}
      </div>
      ${state.accessibilityTrusted ? '' : '<p class="muted">授权后需退出并重新打开 VibeFox 才生效;在那之前转写结果会留在剪贴板,手动 ⌘V 粘贴。</p>'}
    </div>
    <div class="panel">
      <h3>其他</h3>
      <div class="row">
        <button class="btn" data-action="open-config">打开配置文件</button>
        <button class="btn" data-action="rerun-onboarding">重新运行新手引导</button>
        <span class="muted">VibeFox ${esc(state.appVersion)} · AGPL-3.0 开源</span>
      </div>
      <p class="muted">隐私:转写历史、词库、统计只存在本机;每次转写仅上传音频与 ≤40 个偏置词;历史绝不上云。</p>
    </div>`;
  wireHotkeyCapture();
}

function acceleratorFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) {
    mods.push('Command');
  }
  if (e.ctrlKey) {
    mods.push('Control');
  }
  if (e.altKey) {
    mods.push('Alt');
  }
  if (e.shiftKey) {
    mods.push('Shift');
  }
  const key = e.key;
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(key) || mods.length === 0) {
    return null; // Need at least one modifier plus a real key.
  }
  let normalized: string;
  if (/^[a-z]$/i.test(key)) {
    normalized = key.toUpperCase();
  } else if (/^F\d{1,2}$/.test(key)) {
    normalized = key;
  } else if (key === ' ') {
    normalized = 'Space';
  } else if (/^[0-9]$/.test(key)) {
    normalized = key;
  } else {
    return null;
  }
  return [...mods, normalized].join('+');
}

function wireHotkeyCapture(): void {
  const input = document.getElementById('hotkey-input') as HTMLInputElement | null;
  const apply = document.getElementById('hotkey-apply') as HTMLButtonElement | null;
  const msg = document.getElementById('hotkey-msg');
  if (input === null || apply === null || msg === null) {
    return;
  }
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    const accelerator = acceleratorFromEvent(e);
    if (accelerator === null) {
      msg.textContent = '需要至少一个修饰键(⌘/⌃/⌥/⇧)加一个普通键';
      return;
    }
    capturedHotkey = accelerator;
    input.value = accelerator;
    apply.disabled = false;
    msg.textContent = '点「应用」生效';
  });
}

// ---------- microphone level meter (shared by settings tab + onboarding) ----------

let micStream: MediaStream | null = null;
let micRaf = 0;

async function startMicMeter(meterId: string): Promise<boolean> {
  stopMicMeter(meterId);
  const granted = await api.requestMicrophone();
  if (!granted) {
    return false;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return false;
  }
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(micStream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tick = (): void => {
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) {
      peak = Math.max(peak, Math.abs(v - 128));
    }
    const meter = document.getElementById(meterId);
    if (meter !== null) {
      meter.style.width = `${Math.min(100, Math.round((peak / 128) * 260))}%`;
    }
    micRaf = requestAnimationFrame(tick);
  };
  tick();
  return true;
}

function stopMicMeter(meterId: string): void {
  cancelAnimationFrame(micRaf);
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
  const meter = document.getElementById(meterId);
  if (meter !== null) {
    meter.style.width = '0';
  }
}

// ---------- onboarding wizard ----------

const PRACTICE_SAMPLES = [
  ['练习 1 · 纯中文', '帮我把这个函数重构一下,把重复的逻辑抽出来。'],
  ['练习 2 · 中英混杂', '用 useEffect 监听 window resize,然后调用 debounce 处理。'],
  ['练习 3 · 口述列表(试试深度润色档)', '我要做三件事,第一,修复登录 bug,第二,更新文档,第三,发布新版本。'],
] as const;

let onboardingStep = 0;
let hotkeyTried = false;
let accessibilityPoll: number | undefined;

function onboardingActive(): boolean {
  return !el('onboarding').hidden;
}

function renderOnboarding(): void {
  const overlay = el('onboarding');
  const dots = (n: number): string =>
    `<div class="dots">${Array.from({ length: 6 }, (_, i) => (i === n ? '●' : '○')).join(' ')}</div>`;
  const nav = (opts: { next?: string; skip?: boolean; back?: boolean; done?: boolean } = {}): string => `
    <div class="nav">
      ${opts.back === false ? '' : onboardingStep > 0 ? '<button class="btn" data-action="ob-back">上一步</button>' : ''}
      ${opts.done === true ? '<button class="btn primary" data-action="ob-finish">开始使用 🎉</button>' : `<button class="btn primary" data-action="ob-next">${opts.next ?? '下一步'}</button>`}
      ${opts.skip === true ? '<button class="btn" data-action="ob-next">跳过</button>' : ''}
    </div>`;

  const steps: (() => string)[] = [
    () => `
      <h1>🦊 欢迎使用 VibeFox</h1>
      <p class="lead">按一下热键开始说话,再按一下 —— 清理、排版好的文字就出现在任何应用的光标处。<br/>中文优先、中英混杂随便说,代码词汇不打折。</p>
      <div class="body">
        <div class="sample"><b>1</b>下面几步会依次准备好:麦克风、自动粘贴权限、热键,最后现场试一次。</div>
        <div class="sample"><b>2</b>全程约一分钟,以后可在「设置 → 重新运行新手引导」里重来。</div>
      </div>
      ${nav({ next: '开始设置' })}`,
    () => `
      <h1>🎙️ 麦克风</h1>
      <p class="lead">点击下方按钮授权麦克风,对着电脑说句话,看到绿条跳动即为正常。</p>
      <div class="body">
        <div class="row">
          <button class="btn primary" data-action="ob-mic">授权并测试</button>
          <div class="meter"><div id="ob-mic-meter"></div></div>
        </div>
        <p class="muted" id="ob-mic-msg"></p>
      </div>
      ${nav({ skip: true })}`,
    () => `
      <h1>⌨️ 自动粘贴权限</h1>
      <p class="lead">VibeFox 通过模拟 ⌘V 把文字粘进当前应用,macOS 要求先授予「辅助功能」权限。</p>
      <div class="body">
        <div class="row">
          <span id="ob-ax-status" class="${state.accessibilityTrusted ? 'status-ok' : 'status-warn'}">${state.accessibilityTrusted ? '已授权 ✓' : '未授权'}</span>
          <button class="btn primary" data-action="ob-ax" ${state.accessibilityTrusted ? 'disabled' : ''}>打开系统设置授权</button>
        </div>
        <p class="muted">勾选 VibeFox 后,<b>需要退出并重新打开 VibeFox 才生效</b>(本引导结束后会提醒你)。没有该权限时,转写结果会留在剪贴板,手动 ⌘V 也能用。</p>
      </div>
      ${nav({ skip: true })}`,
    () => `
      <h1>🔥 试试热键</h1>
      <p class="lead">现在按下 <kbd>${esc(state.config.hotkey)}</kbd> 开始录音,随便说一句,再按一次停止。</p>
      <div class="body" style="text-align:center">
        <p id="ob-hotkey-status" class="${hotkeyTried ? 'status-ok' : 'muted'}" style="font-size:15px">
          ${hotkeyTried ? '✓ 热键工作正常!' : state.phase === 'recording' ? '🔴 正在录音…再按一次热键停止' : '等待你按下热键…'}
        </p>
        <p class="muted">热键无反应?可能被其他应用占用,稍后可在「设置」页换一个组合键。</p>
      </div>
      ${nav({ skip: true })}`,
    () => `
      <h1>✍️ 现场练习</h1>
      <p class="lead">把光标放进下面的输入框,按热键 <kbd>${esc(state.config.hotkey)}</kbd> 照着念一条:</p>
      <div class="body">
        ${PRACTICE_SAMPLES.map(([t, s]) => `<div class="sample"><b>${t}</b>${s}</div>`).join('')}
        <textarea id="ob-practice" placeholder="光标放这里,按热键开始说话…"></textarea>
        ${state.accessibilityTrusted ? '' : '<p class="muted">尚未授权辅助功能:转写结果在剪贴板里,请手动 ⌘V 粘到上面框里。</p>'}
      </div>
      ${nav({ skip: true, next: '完成练习' })}`,
    () => `
      <h1>🎉 就绪!</h1>
      <p class="lead">VibeFox 已常驻菜单栏(🦊 图标),在任何应用里按 <kbd>${esc(state.config.hotkey)}</kbd> 即可语音输入。</p>
      <div class="body">
        <div class="sample"><b>词库</b>把常被听错的人名、产品名、代码标识符加进「词库」页,识别立刻变准。</div>
        <div class="sample"><b>排版</b>「风格」页选「深度润色」,口述"第一…第二…"会自动排成编号列表。</div>
        ${state.accessibilityTrusted ? '' : '<div class="sample"><b>提醒</b>你刚授权了辅助功能的话,记得退出并重开 VibeFox 让自动粘贴生效。</div>'}
      </div>
      ${nav({ done: true, back: false })}`,
  ];

  const render = steps[onboardingStep];
  overlay.innerHTML = `<div class="step">${render === undefined ? '' : render()}${dots(onboardingStep)}</div>`;

  // Step-specific side effects: poll accessibility while its step is visible.
  window.clearInterval(accessibilityPoll);
  if (onboardingStep === 2 && !state.accessibilityTrusted) {
    accessibilityPoll = window.setInterval(() => {
      void api.getState().then((s) => {
        if (s.accessibilityTrusted && onboardingActive() && onboardingStep === 2) {
          state = s;
          renderOnboarding();
        }
      });
    }, 1500);
  }
}

function showOnboarding(): void {
  onboardingStep = 0;
  hotkeyTried = false;
  el('onboarding').hidden = false;
  renderOnboarding();
}

function hideOnboarding(): void {
  window.clearInterval(accessibilityPoll);
  stopMicMeter('ob-mic-meter');
  el('onboarding').hidden = true;
}

// ---------- rendering root ----------

function renderPhase(): void {
  const phase = el('phase');
  phase.className = `phase ${state.phase === 'recording' ? 'recording' : ''}`;
  phase.textContent = state.phase === 'recording' ? '🔴 录音中' : state.phase === 'processing' ? '⏳ 转写中…' : '';
}

function renderAll(): void {
  document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === activeTab);
  });
  document.querySelectorAll<HTMLElement>('section.tab').forEach((s) => {
    s.classList.toggle('active', s.id === `tab-${activeTab}`);
  });
  renderPhase();
  renderHome();
  renderDict();
  renderStyle();
  renderSettings();
}

async function refresh(): Promise<void> {
  state = await api.getState();
  renderAll();
}

function setState(next: SettingsState): void {
  state = next;
  renderAll();
}

// ---------- actions ----------

async function handleAction(action: string, target: HTMLElement): Promise<void> {
  switch (action) {
    case 'toggle-record':
      await api.toggleRecording();
      return;
    case 'copy-history': {
      const index = Number(target.dataset.index ?? '-1');
      const filtered = state.history.filter((h) => historyFilter === '' || h.text.toLowerCase().includes(historyFilter.toLowerCase()));
      const entry = filtered[index];
      if (entry !== undefined) {
        await api.copyText(entry.text);
        toast('已复制到剪贴板');
      }
      return;
    }
    case 'clear-history':
      setState(await api.historyClear());
      toast('历史已清空');
      return;
    case 'save-entry': {
      const word = inputValue('dict-word').trim();
      const aliases = inputValue('dict-aliases').split(/[,,、]/).map((a) => a.trim()).filter((a) => a.length > 0);
      if (word.length === 0) {
        toast('先填写正确写法');
        return;
      }
      if (editingWord === null) {
        setState(await api.dictAddEntry(word, aliases));
        toast(`已添加「${word}」`);
      } else {
        setState(await api.dictUpdateEntry(editingWord, word, aliases));
        editingWord = null;
        renderDict();
        toast('已保存');
      }
      return;
    }
    case 'edit-entry':
      editingWord = target.dataset.word ?? null;
      renderDict();
      el<HTMLInputElement>('dict-word').focus();
      return;
    case 'cancel-edit':
      editingWord = null;
      renderDict();
      return;
    case 'remove-entry':
      setState(await api.dictRemoveEntry(target.dataset.word ?? ''));
      return;
    case 'add-replacement': {
      const from = inputValue('rep-from').trim();
      const to = inputValue('rep-to');
      if (from.length === 0) {
        toast('先填写要替换的原文');
        return;
      }
      const caseSensitive = (document.getElementById('rep-case') as HTMLInputElement | null)?.checked === true;
      setState(await api.dictAddReplacement(from, to, caseSensitive));
      return;
    }
    case 'remove-replacement':
      setState(await api.dictRemoveReplacement(target.dataset.from ?? ''));
      return;
    case 'export-dict': {
      const json = await api.dictExport();
      await api.copyText(json);
      toast('词库 JSON 已复制到剪贴板');
      return;
    }
    case 'show-import': {
      const area = el('import-area');
      area.hidden = !area.hidden;
      return;
    }
    case 'import-dict': {
      const result = await api.dictImport(inputValue('import-json'));
      if (result.ok) {
        toast(`导入完成,新增 ${result.added} 条`);
        await refresh();
      } else {
        toast(`导入失败:${result.error ?? 'JSON 格式不正确'}`);
      }
      return;
    }
    case 'set-rewrite':
      setState(await api.updateConfig({ rewriteMode: (target.dataset.value ?? 'clean') as SettingsState['config']['rewriteMode'] }));
      return;
    case 'apply-hotkey': {
      if (capturedHotkey === null) {
        return;
      }
      const check = await api.checkHotkey(capturedHotkey);
      if (!check.ok) {
        toast(`热键不可用:${check.reason ?? '被占用或系统保留'}`);
        return;
      }
      setState(await api.updateConfig({ hotkey: capturedHotkey }));
      capturedHotkey = null;
      toast('热键已更新');
      return;
    }
    case 'set-license': {
      const key = inputValue('license-input').trim();
      if (key.length === 0) {
        toast('先粘贴 License Key');
        return;
      }
      setState(await api.setLicenseKey(key));
      toast('License Key 已保存到钥匙串');
      return;
    }
    case 'clear-license':
      setState(await api.clearLicenseKey());
      return;
    case 'save-endpoint':
      setState(await api.updateConfig({ endpoint: inputValue('endpoint-input').trim() }));
      toast('服务地址已保存');
      return;
    case 'reset-endpoint':
      setState(await api.updateConfig({ endpoint: state.officialEndpoint }));
      toast('已恢复官方地址');
      return;
    case 'save-max-seconds': {
      const seconds = Number(inputValue('max-seconds'));
      setState(await api.updateConfig({ maxRecordSeconds: Number.isFinite(seconds) ? seconds : 120 }));
      toast('已保存');
      return;
    }
    case 'mic-test': {
      const btn = el<HTMLButtonElement>('mic-test-btn');
      if (micStream === null) {
        const ok = await startMicMeter('mic-meter');
        btn.textContent = ok ? '停止测试' : '开始测试';
        if (!ok) {
          toast('未获得麦克风权限 — 系统设置 → 隐私与安全性 → 麦克风');
        }
      } else {
        stopMicMeter('mic-meter');
        btn.textContent = '开始测试';
      }
      return;
    }
    case 'request-accessibility':
      await api.requestAccessibility();
      return;
    case 'open-config':
      await api.openConfigFile();
      return;
    case 'rerun-onboarding':
      showOnboarding();
      return;
    // -- onboarding --
    case 'ob-next':
      stopMicMeter('ob-mic-meter');
      onboardingStep = Math.min(onboardingStep + 1, 5);
      renderOnboarding();
      return;
    case 'ob-back':
      stopMicMeter('ob-mic-meter');
      onboardingStep = Math.max(onboardingStep - 1, 0);
      renderOnboarding();
      return;
    case 'ob-mic': {
      const ok = await startMicMeter('ob-mic-meter');
      const msg = document.getElementById('ob-mic-msg');
      if (msg !== null) {
        msg.textContent = ok ? '说句话看看绿条 —— 有跳动就正常。' : '未获得权限:系统设置 → 隐私与安全性 → 麦克风 → 勾选 VibeFox。';
      }
      return;
    }
    case 'ob-ax':
      await api.requestAccessibility();
      return;
    case 'ob-finish':
      hideOnboarding();
      setState(await api.completeOnboarding());
      return;
    default:
      return;
  }
}

// ---------- wiring ----------

document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (target !== null) {
    const action = target.dataset.action ?? '';
    void handleAction(action, target).catch((err) => toast(err instanceof Error ? err.message : String(err)));
    return;
  }
  const tab = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (tab !== null) {
    activeTab = tab.dataset.tab ?? 'home';
    renderAll();
  }
});

// Selects/checkboxes marked data-config persist straight into DesktopConfig.
document.addEventListener('change', (e) => {
  const node = e.target as HTMLInputElement | HTMLSelectElement;
  const key = node.dataset.config;
  if (key === undefined) {
    return;
  }
  const value: unknown = node instanceof HTMLInputElement && node.type === 'checkbox' ? node.checked : node.value;
  void api.updateConfig({ [key]: value } as Partial<SettingsState['config']>).then(setState);
});

api.onStateEvent((event: StateEvent) => {
  if (event.kind === 'phase') {
    state.phase = event.phase;
    renderPhase();
    if (onboardingActive() && onboardingStep === 3) {
      if (event.phase === 'recording') {
        hotkeyTried = true;
      }
      renderOnboarding();
    }
    if (event.phase === 'idle') {
      void refresh(); // Pick up new history/stats after a session ends.
    }
    return;
  }
  if (event.kind === 'delivered') {
    // Practice step without accessibility: the synthetic ⌘V can't land, so insert directly.
    if (onboardingActive() && onboardingStep === 4 && !state.accessibilityTrusted) {
      const box = document.getElementById('ob-practice') as HTMLTextAreaElement | null;
      if (box !== null) {
        box.value = (box.value.length > 0 ? box.value + ' ' : '') + event.text;
      }
    }
    return;
  }
  void refresh();
});

void refresh().then(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get('onboarding') === '1' || !state.config.onboardingDone) {
    showOnboarding();
  }
});
