(() => {
  const EXT_KEY = 'yiyi_local_illust';
  const DEFAULTS = {
    enabled: false,
    backendPolicy: 'mac', // 'mac' | 'auto' | 'windows'
    localUrl: 'http://127.0.0.1:7860',
    remoteUrl: '',
    macUrl: '/yiyi-mac',
    token: '',
    engine: 'anima',
    ratingMode: 'unrestricted',
    promptMode: 'auto_or_tag',
    ratio: '832x1216',
    hiresFix: false,
    skipFirstMessage: true,
    silentOffline: true,
    autoWorldLore: true,
    stylePrefix: '',
    fabPos: null,
  };

  let activeStudioUrl = null;
  let activeEndpointMode = 'offline'; // 'local' | 'remote' | 'offline'
  let activeBusy = false;
  const pendingAutoIds = new Set();
  const runningFloorIds = new Set();

  function getCtx() {
    return window.SillyTavern?.getContext?.() || null;
  }

  function getSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    ctx.extensionSettings[EXT_KEY] = Object.assign(
      {},
      DEFAULTS,
      ctx.extensionSettings[EXT_KEY] || {},
    );
    return ctx.extensionSettings[EXT_KEY];
  }

  function saveSettings() {
    const ctx = getCtx();
    ctx?.saveSettingsDebounced?.();
  }

  function getActiveCharName() {
    const ctx = getCtx();
    if (!ctx) return '';
    return ctx.characters?.[ctx.characterId]?.name || ctx.name2 || '';
  }

  function cleanFloorForDistill(raw, keepInlineTag = false) {
    if (!raw) return '';
    const savedTags = [];
    let s = String(raw);
    if (keepInlineTag) {
      for (const pat of [/\[IMG\s*:[\s\S]*?\]/gi, /<img_prompt>[\s\S]*?<\/img_prompt>/gi, /<!--\s*IMG\s*:[\s\S]*?-->/gi]) {
        s = s.replace(pat, (m) => {
          const tok = ` __YIYI_IMG_TAG_${savedTags.length}__ `;
          savedTags.push(m);
          return tok;
        });
      }
    }
    s = s
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/<(?:style|script|details)[^>]*>[\s\S]*?<\/(?:style|script|details)>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (keepInlineTag && savedTags.length) {
      savedTags.forEach((orig, idx) => {
        s = s.replace(`__YIYI_IMG_TAG_${idx}__`, orig);
      });
    }
    return s.trim();
  }

  function splitLoreKeys(raw) {
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    return arr
      .map((x) => String(x || '').trim())
      .filter((x) => (/[\u4e00-\u9fa5]/.test(x) ? x.length >= 2 : x.length >= 3));
  }

  function normText(v) {
    return String(v == null ? '' : v).trim().normalize('NFKC').toLowerCase();
  }

  function matchTermScore(term, curLower, prevLower) {
    const tl = normText(term);
    if (!tl) return 0;
    const minLen = /[\u4e00-\u9fa5]/.test(tl) ? 2 : 3;
    if (tl.length < minLen) return 0;
    if (curLower.includes(tl)) return 3;
    if (prevLower.includes(tl)) return 1;
    return 0;
  }

  function collectVariableVisualHints(obj, out, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 2 || out.length >= 6) return;
    const visKeyRe = /(外貌|长相|特征|衣着|服[装饰]|穿[着戴]|发型|瞳色|身[材高]|肤色|配饰|地点|位置|场景|appearance|cloth|outfit|hair|eye|location)/i;
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= 6) break;
      if (typeof v === 'string' || typeof v === 'number') {
        const vs = String(v).trim();
        if (vs && vs.length <= 140 && visKeyRe.test(k)) {
          out.push(`${k}: ${cleanFloorForDistill(vs, false)}`);
        }
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        collectVariableVisualHints(v, out, depth + 1);
      }
    }
  }

  function collectXiaobaiXMemory(ctx, mesId, curLower, prevLower) {
    const items = [];
    try {
      const lwb = ctx?.chatMetadata?.extensions?.LittleWhiteBox;
      if (!lwb || typeof lwb !== 'object') return items;

      const json = lwb.storySummary?.json;
      const atoms = Array.isArray(lwb.stateAtoms) ? lwb.stateAtoms : [];
      const activeNames = new Set();

      if (json && typeof json === 'object') {
        const aliases = Array.isArray(json.characterAliases) ? json.characterAliases : [];
        const aliasMap = new Map();
        for (const a of aliases) {
          const canonical = String(a?.to || '').trim();
          const alt = String(a?.from || '').trim();
          if (!canonical || !alt) continue;
          if (!aliasMap.has(canonical)) aliasMap.set(canonical, []);
          aliasMap.get(canonical).push(alt);
        }

        const charPeople = [];
        for (const person of json.characters?.main || []) {
          if (person?._addedAt !== undefined && Number(person._addedAt) > mesId) continue;
          const pName = String(typeof person === 'string' ? person : person?.name || '').trim();
          if (!pName) continue;
          const allNames = [pName, ...(aliasMap.get(pName) || [])];
          let charScore = 0;
          for (const n of allNames) {
            charScore = Math.max(charScore, matchTermScore(n, curLower, prevLower));
          }
          charPeople.push({ name: pName, allNames, score: charScore });
          if (charScore > 0) {
            allNames.forEach((n) => activeNames.add(normText(n)));
          }
        }

        // If prose uses pronouns only ("她/他"), peek at latest stateAtoms <= mesId to infer active characters
        if (activeNames.size === 0 && atoms.length > 0 && charPeople.length > 0) {
          const recentAtoms = atoms
            .filter((a) => a && Number(a.floor) <= mesId)
            .sort((a, b) => Number(b.floor || 0) - Number(a.floor || 0))
            .slice(0, 3);
          const atomBlob = recentAtoms
            .map((a) => `${a.semantic || ''} ${a.where || ''} ${(a.edges || []).map((e) => `${e?.s || ''} ${e?.t || ''}`).join(' ')}`)
            .join(' ')
            .toLowerCase();
          for (const cp of charPeople) {
            if (cp.allNames.some((n) => n && atomBlob.includes(normText(n)))) {
              cp.allNames.forEach((n) => activeNames.add(normText(n)));
            }
          }
        }

        const eventsList = Array.isArray(json.events)
          ? json.events.filter((ev) => ev && (ev._addedAt === undefined || Number(ev._addedAt) <= mesId))
          : [];
        if (activeNames.size === 0 && eventsList.length > 0 && charPeople.length > 0) {
          const recentEvBlob = eventsList
            .slice(-2)
            .map((ev) => `${(ev.participants || []).join(' ')} ${ev.title || ''} ${ev.summary || ''}`)
            .join(' ')
            .toLowerCase();
          for (const cp of charPeople) {
            if (cp.allNames.some((n) => n && recentEvBlob.includes(normText(n)))) {
              cp.allNames.forEach((n) => activeNames.add(normText(n)));
            }
          }
        }

        const visPredRe = /(外貌|长相|容貌|身体|特征|发[色型]|瞳[色眸]|肤色|身材|着装|衣着|服饰|穿着|装扮|服装|装饰|饰品|束缚|状态|伤[势痕]|形态|物种|种族|身份|地点|位置|场景|所在|appearance|body|cloth|outfit|hair|eye|location|state)/i;
        for (const fact of json.facts || []) {
          if (!fact || fact.retracted) continue;
          if (fact._addedAt !== undefined && Number(fact._addedAt) > mesId) continue;
          const s = String(fact.s || '').trim();
          const p = String(fact.p || '').trim();
          const o = String(fact.o || '').trim();
          if (!s || !p || !o) continue;

          const sHit = activeNames.has(normText(s)) ? 4 : matchTermScore(s, curLower, prevLower);
          const oHit = activeNames.has(normText(o)) ? 2 : matchTermScore(o, curLower, prevLower);
          const isVisual = visPredRe.test(p) || visPredRe.test(o);
          let score = sHit + oHit + (isVisual ? 6 : 0);
          if (sHit === 0 && oHit === 0) score = 0;
          if (score >= 6) {
            items.push({
              score: score + (fact._isState ? 0.5 : 0),
              text: `${s} · ${p}：${o.slice(0, 140)}`,
            });
          }
        }

        const matchedEvents = [];
        for (const ev of eventsList) {
          const title = String(ev.title || '').trim();
          const summary = cleanFloorForDistill(ev.summary || '', false);
          if (!summary) continue;
          const parts = Array.isArray(ev.participants) ? ev.participants : [];
          const hasParticipant = parts.some((p) => activeNames.has(normText(p)) || matchTermScore(p, curLower, prevLower) > 0);
          const txtHit = matchTermScore(title, curLower, prevLower) > 0 || matchTermScore(summary, curLower, prevLower) > 0;
          if (hasParticipant || txtHit) {
            matchedEvents.push({
              score: 5.2,
              text: `近期事件${title ? `「${title.slice(0, 24)}」` : ''}：${summary.slice(0, 140)}`,
            });
          }
        }
        items.push(...matchedEvents.slice(-2));

        for (const arc of json.arcs || []) {
          if (arc?._addedAt !== undefined && Number(arc._addedAt) > mesId) continue;
          const aName = String(arc?.name || '').trim();
          if (!aName || !activeNames.has(normText(aName))) continue;
          const latestMoment = (arc.moments || [])
            .filter((m) => m?._addedAt == null || Number(m._addedAt) <= mesId)
            .slice(-1)[0];
          const mTxt = String(typeof latestMoment === 'string' ? latestMoment : latestMoment?.text || '').trim();
          const traj = String(arc.trajectory || '').trim();
          const note = mTxt || traj;
          if (note) {
            items.push({ score: 5, text: `${aName} 近期境况：${note.slice(0, 100)}` });
          }
        }
      }

      if (atoms.length > 0) {
        const candAtoms = atoms
          .filter((a) => a && Number(a.floor) <= mesId && a.semantic)
          .sort((a, b) => Number(b.floor || 0) - Number(a.floor || 0))
          .slice(0, 6);
        for (const a of candAtoms) {
          const sem = cleanFloorForDistill(a.semantic, false);
          if (!sem) continue;
          const edgeStr = (a.edges || [])
            .filter((e) => e && e.s && e.r && e.t)
            .slice(0, 4)
            .map((e) => `${e.s}-${e.r}-${e.t}`)
            .join('；');
          let score = Number(a.floor) === mesId ? 7.5 : 4.5;
          for (const tok of activeNames) {
            if (sem.toLowerCase().includes(tok) || edgeStr.toLowerCase().includes(tok)) {
              score += 2.5;
              break;
            }
          }
          const loc = a.where ? `@${a.where}` : '';
          const body = edgeStr ? `${sem.slice(0, 120)} (${edgeStr})` : sem.slice(0, 140);
          items.push({ score, text: `状态原子${loc}：${body}` });
        }
      }
    } catch {}
    return items;
  }

  function findPrevVisualPrompt(ctx, mesId) {
    try {
      const chat = ctx?.chat || [];
      for (let i = mesId - 1; i >= Math.max(0, mesId - 5); i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const mediaArr = m.extra?.media;
        if (Array.isArray(mediaArr) && mediaArr.length > 0) {
          const lastMedia = mediaArr[mediaArr.length - 1];
          if (lastMedia?.title && String(lastMedia.title).trim()) {
            return String(lastMedia.title).trim().slice(0, 500);
          }
        }
        if (m.extra?.title && String(m.extra.title).trim()) {
          return String(m.extra.title).trim().slice(0, 500);
        }
      }
    } catch {}
    return '';
  }

  async function collectWorldContext(ctx, mesId, mesObj, curCleanText, prevCleanText, settings) {
    const ch = ctx?.characters?.[ctx.characterId];
    const chData = ch?.data || {};
    const curLower = normText(curCleanText);
    const prevLower = normText(prevCleanText);

    const userName = ctx?.name1 || '';
    const userAppearance = String(ctx?.powerUserSettings?.persona_description || '').trim().slice(0, 220);
    const prevVisualPrompt = findPrevVisualPrompt(ctx, mesId);

    if (!settings.autoWorldLore) {
      return { memoryContext: '', userName, userAppearance, prevVisualPrompt: '' };
    }

    const candidates = [];

    // Source A: 小白X (storySummary.json + stateAtoms)
    candidates.push(...collectXiaobaiXMemory(ctx, mesId, curLower, prevLower));

    // Source B1: Card scenario / description brief
    try {
      const rawScenario = String(chData.scenario || ch?.scenario || '').trim();
      if (rawScenario) {
        candidates.push({ score: 3.5, text: `世界背景：${cleanFloorForDistill(rawScenario, false).slice(0, 220)}` });
      } else {
        const rawDesc = String(chData.description || ch?.description || '').trim();
        if (rawDesc) {
          candidates.push({ score: 2.5, text: `卡面设定：${cleanFloorForDistill(rawDesc, false).slice(0, 220)}` });
        }
      }
    } catch {}

    // Source C2: SillyTavern built-in summary & message/chat variables
    try {
      const stSummary = String(ctx?.chatMetadata?.memory?.summary || '').trim();
      if (stSummary) {
        candidates.push({ score: 4.0, text: `剧情摘要：${cleanFloorForDistill(stSummary, false).slice(0, 240)}` });
      }
      const varHints = [];
      collectVariableVisualHints(mesObj?.variables, varHints);
      collectVariableVisualHints(ctx?.chatMetadata?.variables, varHints);
      for (const vh of varHints.slice(0, 4)) {
        candidates.push({ score: 4.5, text: `当前状态变量 ${vh}` });
      }
    } catch {}

    // Source C3: SillyTavern World Info (embedded character_book + linked external + chat metadata)
    const rawEntries = [];
    const addBookEntries = (book) => {
      if (!book?.entries) return;
      const vals = Array.isArray(book.entries) ? book.entries : Object.values(book.entries);
      for (const e of vals) {
        if (e && typeof e === 'object') rawEntries.push(e);
      }
    };
    try { addBookEntries(chData.character_book); } catch {}

    const linkedWorldNames = new Set();
    const addWorldName = (val) => {
      if (!val) return;
      if (Array.isArray(val)) val.forEach((v) => v && linkedWorldNames.add(String(v)));
      else linkedWorldNames.add(String(val));
    };
    addWorldName(chData.extensions?.world);
    addWorldName(chData.extensions?.extra_worlds);
    addWorldName(ctx?.chatMetadata?.world_info);

    if (typeof ctx?.loadWorldInfo === 'function') {
      for (const wName of linkedWorldNames) {
        try {
          const book = await ctx.loadWorldInfo(wName);
          addBookEntries(book);
        } catch {}
      }
    }

    const seenLore = new Set();
    for (const entry of rawEntries) {
      if (entry.disable === true) continue;
      const contentClean = cleanFloorForDistill(entry.content || '', false);
      if (!contentClean) continue;
      const dedupKey = contentClean.slice(0, 80);
      if (seenLore.has(dedupKey)) continue;
      seenLore.add(dedupKey);

      const keys = [
        ...splitLoreKeys(entry.key),
        ...splitLoreKeys(entry.keys),
        ...splitLoreKeys(entry.keysecondary),
      ];
      let score = 0;
      const matchedKeys = [];
      for (const k of keys) {
        const hit = matchTermScore(k, curLower, prevLower);
        if (hit > 0) {
          score += hit;
          matchedKeys.push(k);
        }
      }
      if (score === 0 && entry.constant && contentClean.length <= 260) {
        score = 1.5;
      }
      if (score > 0) {
        const title = (entry.comment || matchedKeys[0] || '世界设定').toString().trim().slice(0, 28);
        candidates.push({ score: score + 2, text: `${title}：${contentClean.slice(0, 240)}` });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const outLines = [];
    const seenOut = new Set();
    let totalLen = 0;
    for (const c of candidates) {
      const sig = c.text.slice(0, 48);
      if (seenOut.has(sig)) continue;
      if (totalLen + c.text.length + 1 > 1550) break;
      seenOut.add(sig);
      outLines.push(c.text);
      totalLen += c.text.length + 1;
    }

    return {
      memoryContext: outLines.join('\n'),
      userName,
      userAppearance,
      prevVisualPrompt,
    };
  }

  function buildHeaders(settings) {
    const h = { 'Content-Type': 'application/json' };
    if (settings.token && settings.token.trim()) {
      h['X-Studio-Token'] = settings.token.trim();
    }
    return h;
  }

  function normalizeStudioUrl(raw) {
    const trimmed = String(raw || '').trim().replace(/\/+$/, '');
    if (!trimmed) return '';
    if (trimmed.startsWith('/')) {
      const origin = (window.location?.origin || '').replace(/\/+$/, '');
      return origin ? `${origin}${trimmed}` : trimmed;
    }
    return trimmed;
  }

  async function pingEndpoint(baseUrl, token, timeoutMs) {
    const url = normalizeStudioUrl(baseUrl);
    if (!url) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = {};
      if (token && token.trim()) headers['X-Studio-Token'] = token.trim();
      const resp = await fetch(`${url}/api/st/ping`, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      if (!resp.ok) return { ok: false, status: resp.status, url };
      const data = await resp.json();
      return { ok: true, url, data };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveStudioUrl() {
    const s = getSettings();
    const policy = s.backendPolicy || 'mac';
    let firstErr = null;

    if (policy !== 'mac') {
      const localRes = await pingEndpoint(s.localUrl, s.token, 1200);
      if (localRes?.ok) {
        activeStudioUrl = localRes.url;
        activeEndpointMode = 'local';
        activeBusy = !!localRes.data?.busy;
        updateConnectionUi();
        return localRes;
      }
      const remoteRes = await pingEndpoint(s.remoteUrl, s.token, 2500);
      if (remoteRes?.ok) {
        activeStudioUrl = remoteRes.url;
        activeEndpointMode = 'remote';
        activeBusy = !!remoteRes.data?.busy;
        updateConnectionUi();
        return remoteRes;
      }
      firstErr = localRes || remoteRes;
      if (policy === 'windows') {
        activeStudioUrl = null;
        activeEndpointMode = firstErr?.status === 401 ? 'auth_error' : 'offline';
        activeBusy = false;
        updateConnectionUi();
        return firstErr || null;
      }
    }

    if (policy !== 'windows') {
      const macRes = await pingEndpoint(s.macUrl || '/yiyi-mac', s.token, 3500);
      if (macRes?.ok) {
        activeStudioUrl = macRes.url;
        activeEndpointMode = 'mac';
        activeBusy = !!macRes.data?.busy;
        updateConnectionUi();
        return macRes;
      }
      if (!firstErr || macRes?.status === 401) firstErr = macRes;
    }

    activeStudioUrl = null;
    activeEndpointMode = firstErr?.status === 401 ? 'auth_error' : 'offline';
    activeBusy = false;
    updateConnectionUi();
    return firstErr || null;
  }

  function updateConnectionUi() {
    const s = getSettings();
    const fab = document.getElementById('yiyi-st-fab');
    const dot = fab?.querySelector('.yiyi-dot');
    const tag = fab?.querySelector('.yiyi-state-tag');
    const statusText = document.getElementById('yiyi-conn-status');

    if (fab) {
      fab.classList.toggle('is-on', !!s.enabled);
    }
    if (dot) {
      dot.className = 'yiyi-dot';
      if (activeBusy) dot.classList.add('busy');
      else if (activeStudioUrl) dot.classList.add('online');
    }
    if (tag) {
      tag.textContent = s.enabled ? '自动:开' : '自动:关';
    }
    if (statusText) {
      if (activeEndpointMode === 'local') {
        statusText.textContent = `🟢 本机 4060 直连 (${activeStudioUrl})`;
      } else if (activeEndpointMode === 'remote') {
        statusText.textContent = `🟢 远程 4060 在线 (${activeStudioUrl})`;
      } else if (activeEndpointMode === 'mac') {
        statusText.textContent = `🟢 Mac 24h 极速在线 (${s.macUrl || '/yiyi-mac'})`;
      } else if (activeEndpointMode === 'auth_error') {
        statusText.textContent = '🔒 需要输入正确的配置密码';
      } else {
        statusText.textContent = '⚪ 生图服务未连接';
      }
    }
  }

  function toastInfo(msg, kind = 'info') {
    if (window.toastr && typeof window.toastr[kind] === 'function') {
      window.toastr[kind](msg, '依依本地生图');
    } else {
      console.log(`[yiyi-st:${kind}]`, msg);
    }
  }

  function ensureFloorStatusBar(mesEl) {
    let bar = mesEl.querySelector('.yiyi-floor-status');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'yiyi-floor-status';
      bar.innerHTML = `
        <div class="yiyi-floor-msg">正在准备生图…</div>
        <div class="yiyi-floor-bar-track"><div class="yiyi-floor-bar-fill"></div></div>
      `;
      const textEl = mesEl.querySelector('.mes_text');
      if (textEl && textEl.parentNode) {
        textEl.parentNode.insertBefore(bar, textEl.nextSibling);
      } else {
        mesEl.appendChild(bar);
      }
    }
    return bar;
  }

  function setFloorStatus(mesEl, msg, pct) {
    if (!mesEl) return;
    const bar = ensureFloorStatusBar(mesEl);
    const label = bar.querySelector('.yiyi-floor-msg');
    const fill = bar.querySelector('.yiyi-floor-bar-fill');
    if (label) label.textContent = msg;
    if (fill && typeof pct === 'number') {
      fill.style.width = `${Math.max(5, Math.min(100, pct))}%`;
    }
  }

  function removeFloorStatus(mesEl) {
    mesEl?.querySelector('.yiyi-floor-status')?.remove();
  }

  async function uploadImageToSillyTavern(base64Data, format, chName) {
    const ctx = getCtx();
    const headers = ctx.getRequestHeaders();
    const resp = await fetch('/api/images/upload', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: base64Data,
        format: format || 'webp',
        ch_name: (chName || 'yiyi_illust').replace(/[\\/:*?"<>|]/g, '_'),
        filename: `yiyi_${Date.now()}`,
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`上传到酒馆失败 (${resp.status}): ${txt}`);
    }
    const data = await resp.json();
    return data.path;
  }

  async function attachImageToFloor(mesId, savedPath, positivePrompt, negativePrompt) {
    const ctx = getCtx();
    const mes = ctx?.chat?.[mesId];
    const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
    if (!mes || !mesEl) return;

    if (!mes.extra || typeof mes.extra !== 'object') {
      mes.extra = {};
    }
    const jq = window.$ || window.jQuery;
    if (
      typeof ctx.ensureMessageMediaIsArray === 'function' &&
      typeof ctx.appendMediaToMessage === 'function' &&
      typeof jq === 'function'
    ) {
      ctx.ensureMessageMediaIsArray(mes);
      if (!Array.isArray(mes.extra.media)) {
        mes.extra.media = [];
      }
      mes.extra.media.push({
        url: savedPath,
        type: 'image',
        title: positivePrompt || 'AI Illustration',
        generation_type: 'free',
        negative: negativePrompt || '',
        source: 'generated',
      });
      mes.extra.media_display = 'gallery';
      mes.extra.media_index = mes.extra.media.length - 1;
      mes.extra.inline_image = true;
      ctx.appendMediaToMessage(mes, jq(mesEl));
    } else {
      if (!Array.isArray(mes.extra.media)) {
        mes.extra.media = [];
      }
      mes.extra.media.push({
        url: savedPath,
        type: 'image',
        title: positivePrompt || 'AI Illustration',
        source: 'generated',
      });
      mes.extra.inline_image = true;
      const img = document.createElement('img');
      img.src = savedPath;
      img.className = 'mes_img';
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      mesEl.querySelector('.mes_text')?.after(img);
    }
    if (typeof ctx.saveChat === 'function') {
      await ctx.saveChat();
    }
  }

  async function illustrateFloor(mesId, isManual = false) {
    const idNum = Number(mesId);
    if (runningFloorIds.has(idNum)) return;

    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    if (!mes || mes.is_user || mes.is_system) return;
    if (!mes.mes || !mes.mes.trim()) return;

    const mesEl = document.querySelector(`.mes[mesid="${idNum}"]`);
    const s = getSettings();

    runningFloorIds.add(idNum);
    try {
      const conn = await resolveStudioUrl();
      if (!conn?.ok) {
        if (conn && conn.status === 401) {
          toastInfo('访问密码 (Token) 不正确，请在悬浮窗中核对', 'error');
        } else if (isManual || !s.silentOffline) {
          toastInfo('电脑端生图服务不在线，请确认电脑已启动生图工作台/隧道', 'warning');
        }
        return;
      }

      if (mesEl) setFloorStatus(mesEl, '正在读取小白X记忆与当前剧情画面…', 8);

      const recentLines = [];
      for (let i = Math.max(0, idNum - 3); i < idNum; i++) {
        const m = ctx.chat[i];
        if (m && !m.is_system && m.mes) {
          const prevClean = cleanFloorForDistill(m.mes, false);
          if (prevClean) {
            recentLines.push(`${m.name || (m.is_user ? ctx.name1 : ctx.name2)}: ${prevClean.slice(-280)}`);
          }
        }
      }

      const cleanedFloor = cleanFloorForDistill(mes.mes, true) || mes.mes;
      const recentContext = recentLines.join('\n');
      const [wStr, hStr] = (s.ratio || '832x1216').split('x');
      const charName = mes.name || getActiveCharName();
      const lore = await collectWorldContext(ctx, idNum, mes, cleanedFloor, recentContext, s);

      const startResp = await fetch(`${activeStudioUrl}/api/st/illustrate/start`, {
        method: 'POST',
        headers: buildHeaders(s),
        body: JSON.stringify({
          floor_text: cleanedFloor,
          recent_context: recentContext,
          char_name: charName,
          char_appearance: '',
          style_prefix: (s.stylePrefix || '').trim(),
          world_mode: true,
          world_context: '',
          memory_context: lore.memoryContext,
          prev_visual_prompt: lore.prevVisualPrompt,
          matched_characters: '',
          user_name: lore.userName,
          user_appearance: lore.userAppearance,
          prompt_mode: s.promptMode || 'auto_or_tag',
          engine: s.engine || 'anima',
          rating_mode: s.ratingMode || 'unrestricted',
          width: parseInt(wStr, 10) || 832,
          height: parseInt(hStr, 10) || 1216,
          steps: s.engine === 'illustrious' ? 24 : 26,
          cfg: s.engine === 'illustrious' ? 6.0 : 4.5,
          hires_fix: !!s.hiresFix,
          return_base64: true,
          image_format: 'webp',
        }),
      });
      if (!startResp.ok) {
        throw new Error(`启动任务失败 (${startResp.status})`);
      }
      const { job_id } = await startResp.json();

      // Poll job state cleanly (works reliably through Cloudflare & mobile networks)
      let jobData = null;
      const deadline = Date.now() + 260000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900));
        const jr = await fetch(`${activeStudioUrl}/api/jobs/${job_id}`, {
          method: 'GET',
          headers: buildHeaders(s),
        });
        if (!jr.ok) throw new Error(`轮询任务失败 (${jr.status})`);
        jobData = await jr.json();

        if (jobData.status === 'done') break;
        if (jobData.status === 'error') throw new Error(jobData.error || '生图出错');
        if (jobData.status === 'cancelled') throw new Error('生成已中断');

        let pct = 15;
        let msg = jobData.status_message || '处理中…';
        if (jobData.status === 'distilling') pct = 18;
        else if (jobData.status === 'preparing') pct = 28;
        else if (jobData.status === 'running') {
          const stepPct = jobData.max_steps ? (jobData.step / jobData.max_steps) * 60 : 10;
          pct = 30 + stepPct;
          if (jobData.max_steps) {
            msg = `${jobData.node_title || '绘制中'} (${jobData.step}/${jobData.max_steps})`;
          }
        } else if (jobData.status === 'saving') {
          pct = 93;
        }
        if (mesEl) setFloorStatus(mesEl, msg, pct);
      }

      if (!jobData || jobData.status !== 'done') {
        throw new Error('生成超时');
      }

      const res = jobData.extra_result || {};
      if (res.skipped) {
        if (isManual) toastInfo('当前设置仅识别 [IMG] 标签，本楼层未包含该标签', 'info');
        return;
      }
      if (!res.image_base64) {
        throw new Error('未收到图像数据');
      }

      if (mesEl) setFloorStatus(mesEl, '正在保存到酒馆楼层…', 97);
      const savedPath = await uploadImageToSillyTavern(
        res.image_base64,
        res.image_format || 'webp',
        charName,
      );
      await attachImageToFloor(idNum, savedPath, res.positive, res.negative);
      if (isManual) toastInfo(`插画已生成 (${res.elapsed || ''}s)`, 'success');
    } catch (err) {
      console.error('[yiyi-st]', err);
      toastInfo(err.message || '生图失败', 'error');
    } finally {
      runningFloorIds.delete(idNum);
      if (mesEl) removeFloorStatus(mesEl);
      resolveStudioUrl().catch(() => {});
    }
  }

  function injectFloorButton(mesId) {
    const ctx = getCtx();
    const idNum = Number(mesId);
    const mes = ctx?.chat?.[idNum];
    if (!mes || mes.is_user || mes.is_system) return;
    const mesEl = document.querySelector(`.mes[mesid="${idNum}"]`);
    if (!mesEl) return;
    const btnRow = mesEl.querySelector('.extraMesButtons');
    if (!btnRow || btnRow.querySelector('.yiyi-floor-btn')) return;

    const btn = document.createElement('div');
    btn.className = 'mes_button yiyi-floor-btn fa-solid fa-palette';
    btn.title = '依依本地生图：为这一层生成插画';
    btn.onclick = (e) => {
      e.stopPropagation();
      illustrateFloor(idNum, true);
    };
    btnRow.prepend(btn);
  }

  function injectAllVisibleFloorButtons() {
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
      const id = el.getAttribute('mesid');
      if (id !== null) injectFloorButton(id);
    });
  }

  function buildFloatingUi() {
    if (document.getElementById('yiyi-st-fab')) return;
    const s = getSettings();

    const fab = document.createElement('div');
    fab.id = 'yiyi-st-fab';
    fab.innerHTML = `<span class="yiyi-dot"></span><span>🎨</span><span class="yiyi-state-tag">自动:关</span>`;
    if (s.fabPos && typeof s.fabPos.right === 'number' && typeof s.fabPos.bottom === 'number') {
      fab.style.right = `${s.fabPos.right}px`;
      fab.style.bottom = `${s.fabPos.bottom}px`;
    }

    const panel = document.createElement('div');
    panel.id = 'yiyi-st-panel';
    panel.className = 'yiyi-hidden';
    panel.innerHTML = `
      <div class="yiyi-panel-head">
        <div class="yiyi-panel-title"><span>🎨</span> 依依本地无限制生图</div>
        <button class="yiyi-close-btn" id="yiyi-panel-close" title="收起">✕</button>
      </div>
      <div class="yiyi-panel-body">
        <label class="yiyi-switch-row">
          <strong>楼层生成自动插画</strong>
          <input type="checkbox" id="yiyi-opt-enabled" />
        </label>

        <div class="yiyi-status-row">
          <span id="yiyi-conn-status">检查连接中…</span>
          <button class="yiyi-btn" id="yiyi-btn-test">测试连接</button>
        </div>

        <button class="yiyi-btn yiyi-btn-primary" id="yiyi-btn-draw-last">🖌️ 为最新楼层立即画一张</button>

        <div class="yiyi-grid-2">
          <div class="yiyi-field">
            <label>生图引擎</label>
            <select id="yiyi-opt-engine">
              <option value="anima">Anima v1.1 (综合最强)</option>
              <option value="illustrious">WAI-Illustrious v17</option>
            </select>
          </div>
          <div class="yiyi-field">
            <label>画面尺度</label>
            <select id="yiyi-opt-rating">
              <option value="unrestricted">自由 / 无限制</option>
              <option value="safe">全年龄 (Safe)</option>
              <option value="sensitive">氛围擦边</option>
              <option value="nsfw">NSFW 成人</option>
              <option value="explicit">Explicit 全尺度</option>
            </select>
          </div>
          <div class="yiyi-field">
            <label>画面提炼方式</label>
            <select id="yiyi-opt-prompt-mode">
              <option value="auto_or_tag">智能(有[IMG]用标签/无则AI提炼)</option>
              <option value="auto_local">强制本机 AI 提炼画面</option>
              <option value="tag_only">仅识别楼层 [IMG:...] 标签</option>
            </select>
          </div>
          <div class="yiyi-field">
            <label>默认画幅</label>
            <select id="yiyi-opt-ratio">
              <option value="832x1216">竖图 832×1216</option>
              <option value="1216x832">横图 1216×832</option>
              <option value="1024x1024">方图 1024×1024</option>
            </select>
          </div>
        </div>

        <div class="yiyi-field">
          <label>生图算力路由</label>
          <select id="yiyi-opt-policy">
            <option value="mac">Mac 24h 极速常驻 (推荐)</option>
            <option value="auto">自动优选 (Windows 4060优先 → Mac 24h兜底)</option>
            <option value="windows">仅走 Windows 4060</option>
          </select>
        </div>

        <div class="yiyi-field">
          <label>全局画风偏好（可选，留空完全跟随剧情）</label>
          <input type="text" id="yiyi-opt-style" placeholder="例如: anime coloring, rim lighting" />
        </div>

        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-world-lore" /> 自动读取小白X记忆 / 世界书与前图锚点（保持大世界人物形象一致）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-hires" /> 开启 1.5x 高清重绘（耗时略增，细节更锐利）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-skip-first" /> 跳过开场白（第0层不自动画）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-silent" /> 无可用生图服务时静默不弹窗</label>

        <div class="yiyi-field">
          <label>Mac 24h 服务地址（默认同源 /yiyi-mac 免配置）</label>
          <input type="text" id="yiyi-opt-mac-url" />
        </div>
        <div class="yiyi-field">
          <label>Windows 本机地址（优先尝试）</label>
          <input type="text" id="yiyi-opt-local-url" />
        </div>
        <div class="yiyi-field">
          <label>Windows 远程地址（局域网 IP、SSH 隧道或 Cloudflare 地址）</label>
          <input type="text" id="yiyi-opt-remote-url" />
        </div>
        <div class="yiyi-field">
          <label>配置访问密码（服务已设密时必填）</label>
          <input type="password" id="yiyi-opt-token" placeholder="请输入配置密码" />
        </div>
      </div>
    `;

    document.body.append(fab, panel);

    // Draggable FAB (pointer events work on both mouse and phone touch)
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origRight = 16;
    let origBottom = 76;

    fab.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = fab.getBoundingClientRect();
      origRight = window.innerWidth - rect.right;
      origBottom = window.innerHeight - rect.bottom;
      fab.setPointerCapture(e.pointerId);
    });
    fab.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const nextRight = Math.max(8, Math.min(window.innerWidth - 90, origRight - dx));
      const nextBottom = Math.max(8, Math.min(window.innerHeight - 48, origBottom - dy));
      fab.style.right = `${nextRight}px`;
      fab.style.bottom = `${nextBottom}px`;
    });
    fab.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      fab.releasePointerCapture(e.pointerId);
      if (moved) {
        const st = getSettings();
        st.fabPos = {
          right: parseInt(fab.style.right, 10) || 16,
          bottom: parseInt(fab.style.bottom, 10) || 76,
        };
        saveSettings();
      } else {
        panel.classList.toggle('yiyi-hidden');
        if (!panel.classList.contains('yiyi-hidden')) {
          syncPanelFromSettings();
          resolveStudioUrl();
        }
      }
    });

    document.getElementById('yiyi-panel-close').onclick = () => panel.classList.add('yiyi-hidden');
    document.getElementById('yiyi-btn-test').onclick = async () => {
      const res = await resolveStudioUrl();
      if (res?.ok) {
        const modeLabel = activeEndpointMode === 'local'
          ? 'Windows 本机 4060'
          : activeEndpointMode === 'remote'
            ? 'Windows 远程 4060'
            : 'Mac 24h 极速';
        toastInfo(`连接成功 (${modeLabel})`, 'success');
      } else if (res?.status === 401) {
        toastInfo('配置密码未填或不正确，请在下方输入框填写密码', 'error');
      } else {
        toastInfo('暂未连上生图服务，请检查网络与服务状态', 'warning');
      }
    };
    document.getElementById('yiyi-btn-draw-last').onclick = () => {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
          illustrateFloor(i, true);
          return;
        }
      }
      toastInfo('当前对话还没有可绘制的 AI 楼层', 'info');
    };

    const bindVal = (id, key, isCheck = false, refreshConn = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        const st = getSettings();
        st[key] = isCheck ? !!el.checked : el.value;
        saveSettings();
        updateConnectionUi();
        if (refreshConn) resolveStudioUrl().catch(() => {});
      });
    };

    bindVal('yiyi-opt-enabled', 'enabled', true);
    bindVal('yiyi-opt-policy', 'backendPolicy', false, true);
    bindVal('yiyi-opt-engine', 'engine');
    bindVal('yiyi-opt-rating', 'ratingMode');
    bindVal('yiyi-opt-prompt-mode', 'promptMode');
    bindVal('yiyi-opt-ratio', 'ratio');
    bindVal('yiyi-opt-style', 'stylePrefix');
    bindVal('yiyi-opt-world-lore', 'autoWorldLore', true);
    bindVal('yiyi-opt-hires', 'hiresFix', true);
    bindVal('yiyi-opt-skip-first', 'skipFirstMessage', true);
    bindVal('yiyi-opt-silent', 'silentOffline', true);
    bindVal('yiyi-opt-mac-url', 'macUrl', false, true);
    bindVal('yiyi-opt-local-url', 'localUrl', false, true);
    bindVal('yiyi-opt-remote-url', 'remoteUrl', false, true);
    bindVal('yiyi-opt-token', 'token', false, true);

    syncPanelFromSettings();
  }

  function syncPanelFromSettings() {
    const s = getSettings();
    const setVal = (id, v, isCheck = false) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (isCheck) el.checked = !!v;
      else el.value = v ?? '';
    };
    setVal('yiyi-opt-enabled', s.enabled, true);
    setVal('yiyi-opt-policy', s.backendPolicy || 'mac');
    setVal('yiyi-opt-engine', s.engine);
    setVal('yiyi-opt-rating', s.ratingMode);
    setVal('yiyi-opt-prompt-mode', s.promptMode);
    setVal('yiyi-opt-ratio', s.ratio);
    setVal('yiyi-opt-style', s.stylePrefix);
    setVal('yiyi-opt-world-lore', s.autoWorldLore, true);
    setVal('yiyi-opt-hires', s.hiresFix, true);
    setVal('yiyi-opt-skip-first', s.skipFirstMessage, true);
    setVal('yiyi-opt-silent', s.silentOffline, true);
    setVal('yiyi-opt-mac-url', s.macUrl || '/yiyi-mac');
    setVal('yiyi-opt-local-url', s.localUrl);
    setVal('yiyi-opt-remote-url', s.remoteUrl);
    setVal('yiyi-opt-token', s.token);
    updateConnectionUi();
  }

  function registerEvents() {
    const ctx = getCtx();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    const { eventSource, eventTypes } = ctx;

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (mesId, type) => {
      const s = getSettings();
      if (s.skipFirstMessage && type === 'first_message') return;
      pendingAutoIds.add(Number(mesId));
    });

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId) => {
      const idNum = Number(mesId);
      injectFloorButton(idNum);
      const s = getSettings();
      if (s.enabled && pendingAutoIds.has(idNum)) {
        pendingAutoIds.delete(idNum);
        illustrateFloor(idNum, false);
      }
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
      pendingAutoIds.clear();
      setTimeout(() => {
        injectAllVisibleFloorButtons();
        syncPanelFromSettings();
      }, 250);
    });
  }

  function init() {
    if (!getCtx()) {
      setTimeout(init, 600);
      return;
    }
    buildFloatingUi();
    registerEvents();
    injectAllVisibleFloorButtons();
    resolveStudioUrl().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
