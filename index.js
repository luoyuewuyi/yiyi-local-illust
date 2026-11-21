(() => {
  const EXT_KEY = 'yiyi_local_illust';
  const DEFAULT_MAC_HTTPS_URL = 'https://draw.fzy.asia/yiyi-mac';
  const DEFAULT_MAC_HTTP_URL = 'http://120.2.102.194:8093/yiyi-mac';
  const BUILTIN_MAC_URLS = new Set([
    '',
    '/yiyi-mac',
    DEFAULT_MAC_HTTPS_URL,
    DEFAULT_MAC_HTTP_URL,
  ]);

  const DEFAULTS = {
    enabled: false,
    backendPolicy: 'mac', // 'mac' | 'auto' | 'windows'
    localUrl: 'http://127.0.0.1:7860',
    remoteUrl: '',
    macUrl: DEFAULT_MAC_HTTPS_URL,
    token: '',
    engine: 'anima',
    ratingMode: 'unrestricted',
    promptMode: 'auto_or_tag',
    ratio: '832x1216',
    hiresFix: false,
    skipFirstMessage: true,
    silentOffline: true,
    autoWorldLore: true,
    memoryMode: 'smart', // 'smart' | 'story_only' | 'off'
    overlayMode: 'auto', // 'auto' | 'always' | 'floor_only'
    overlayPos: null,
    stylePrefix: '',
    fabPos: null,
  };

  let activeStudioUrl = null;
  let activeEndpointMode = 'offline'; // 'local' | 'remote' | 'mac' | 'auth_error' | ... | 'offline'
  let activeBusy = false;
  let lastConnError = null;
  let activeProgressLabel = '';
  let overlayIndex = 0;
  let overlayCollapsed = false;
  const pendingAutoIds = new Set();
  const runningFloorIds = new Set();

  function getCtx() {
    return window.SillyTavern?.getContext?.() || null;
  }

  function getSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    const raw = ctx.extensionSettings[EXT_KEY] || {};
    const merged = Object.assign({}, DEFAULTS, raw);
    const rawMac = typeof raw.macUrl === 'string' ? raw.macUrl.trim().replace(/\/+$/, '') : '';
    if (!rawMac || rawMac === '/yiyi-mac') {
      merged.macUrl = DEFAULT_MAC_HTTPS_URL;
    }
    if (raw.memoryMode == null && raw.autoWorldLore === false) {
      merged.memoryMode = 'off';
    }
    ctx.extensionSettings[EXT_KEY] = merged;
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
      .replace(/<(?:think|thinking|thought)>[\s\S]*?<\/(?:think|thinking|thought)>/gi, '')
      .replace(/<(?:style|script|head|svg|template|noscript|details|UpdateVariable|Variable|variables|statusbar|status|options|choices|mvu|JSONPatch|tableEdit)\b[^>]*>[\s\S]*?<\/(?:style|script|head|svg|template|noscript|details|UpdateVariable|Variable|variables|statusbar|status|options|choices|mvu|JSONPatch|tableEdit)>/gi, '')
      .replace(/```(?:html|css|js|javascript|json|yaml|yml|mvu|updatevariable|status|statusbar)\b[\s\S]*?```/gi, '')
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

  const VIS_KEY_RE = /(外貌|长相|容貌|特征|衣着|穿[着戴]|服[装饰]|装扮|裙|裤|发[色型]|瞳[色眸]|眸色|肤色|身[材高体]|配饰|首饰|手持|地点|位置|场景|环境|所在|天气|时间|情绪|心情|状态|伤[势痕]|appearance|look|outfit|cloth|wear|dress|hair|eye|skin|body|location|place|scene|weather|time|state)/i;
  const NOISE_VAR_KEY_RE = /^(?:hp|mp|exp|lv|level|gold|money|coin|credit|score|rank|id|uuid|timestamp|created_at|updated_at|\$meta)$/i;
  const STORY_VIS_RE = /(?:一袭|身穿|穿着|换上|披着|身披|戴着|系着|赤裸|裸露|未着寸缕|赤身|衣衫|裙摆|长裙|短裙|礼裙|汉服|旗袍|和服|睡衣|内衣|比基尼|校服|白袜|黑丝|丝袜|高跟|发型|长发|短发|双马尾|银发|白发|黑发|金发|粉发|红发|蓝发|紫发|灰发|挑染|瞳色|异瞳|红眸|蓝眸|金眸|紫眸|碧眸|兽耳|狐耳|猫耳|龙角|羽翼|尾巴|面容|肌肤|伤痕|青紫|红晕|身处|位于|站在|坐在|躺在|倚在|走进|来到|城堡|古塔|森林|温泉|海边|雨夜|月光|灯火|露台|宫殿|教室|街头|卧室|silver hair|white hair|black hair|blonde|red eyes|blue eyes|heterochromia|wearing|dressed in|naked|nude)/i;
  const APPEARANCE_STICKY_RE = /(?:发|瞳|眼|眸|穿着|身穿|换上|一袭|披着|裙|衣|衫|服|饰|耳|角|尾|羽翼|肤|脸|面容|赤裸|未着寸缕|hair|eyes|heterochromia|wearing|dressed|outfit|nude|naked)/i;

  function collectVariableVisualHints(obj, out, depth = 0, prefix = '') {
    if (!obj || typeof obj !== 'object' || depth > 4 || out.length >= 10) return;
    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 12)) {
        if (out.length >= 10) break;
        if (item && typeof item === 'object') {
          collectVariableVisualHints(item, out, depth + 1, prefix);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= 10) break;
      if (NOISE_VAR_KEY_RE.test(k)) continue;
      const fullKey = prefix ? `${prefix}·${k}` : k;
      if (typeof v === 'string') {
        const vs = cleanFloorForDistill(v, false);
        if (vs && vs.length >= 2 && vs.length <= 160 && (VIS_KEY_RE.test(fullKey) || STORY_VIS_RE.test(vs))) {
          out.push(`${fullKey}: ${vs}`);
        }
      } else if (v && typeof v === 'object') {
        collectVariableVisualHints(v, out, depth + 1, k === 'stat_data' ? prefix : fullKey);
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

  function extractVisualStatusFromRaw(raw) {
    const items = [];
    if (!raw || typeof raw !== 'string') return items;
    try {
      const blocks = [];
      const tagPat = /<(?:details|statusbar|status|UpdateVariable|Variable)[^>]*>([\s\S]*?)<\/(?:details|statusbar|status|UpdateVariable|Variable)>/gi;
      let m;
      while ((m = tagPat.exec(raw)) !== null) {
        blocks.push(m[1]);
      }
      const fencePat = /```(?:json|yaml|yml|status|statusbar|vars?|mvu|updatevariable)?\b([\s\S]*?)```/gi;
      while ((m = fencePat.exec(raw)) !== null) {
        blocks.push(m[1]);
      }
      const scanSrc = blocks.length ? blocks.join('\n') : '';
      if (!scanSrc) return items;

      const cleaned = scanSrc
        .replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, '')
        .replace(/<[^>]+>/g, '\n');
      for (const line of cleaned.split(/\r?\n/)) {
        const kv = line.match(/^\s*["']?([^"'：:=|\n]{2,18})["']?\s*[:：=]\s*["']?([^"'}\]\n]{2,90})/);
        if (!kv) continue;
        const k = kv[1].trim();
        const v = kv[2].replace(/,\s*$/, '').trim();
        if (!VIS_KEY_RE.test(k) || !v || /^\d+(?:\/\d+)?%?$/.test(v)) continue;
        items.push({ score: 6.5, text: `当前状态栏 ${k}：${v}` });
        if (items.length >= 5) break;
      }
    } catch {}
    return items;
  }

  function extractGenericTableItems(container, curLower, prevLower, items, depth = 0) {
    if (!container || typeof container !== 'object' || depth > 4 || items.length >= 20) return;
    if (Array.isArray(container)) {
      if (container.length > 0 && Array.isArray(container[0])) {
        const headers = container[0].map((h) => String(h ?? '').trim()).filter(Boolean);
        for (let r = 1; r < container.length && r < 40; r++) {
          const row = container[r];
          if (!Array.isArray(row)) continue;
          const cells = [];
          for (let c = 0; c < row.length; c++) {
            const val = String(row[c] ?? '').replace(/\s+/g, ' ').trim();
            if (!val || val === '-' || val === '无') continue;
            const hk = headers[c] && headers[c].length <= 16 ? `${headers[c]}:` : '';
            cells.push(`${hk}${val}`.slice(0, 60));
          }
          const rowTxt = cells.join(' · ').slice(0, 180);
          if (!rowTxt || (!STORY_VIS_RE.test(rowTxt) && !VIS_KEY_RE.test(rowTxt) && matchTermScore(cells[0] || '', curLower, prevLower) === 0)) {
            continue;
          }
          const hit = cells.some((c) => matchTermScore(c, curLower, prevLower) > 0);
          items.push({
            score: (hit ? 6.2 : 3.4) + (STORY_VIS_RE.test(rowTxt) || VIS_KEY_RE.test(rowTxt) ? 1.5 : 0),
            text: `表格记忆：${rowTxt}`,
          });
        }
        return;
      }
      for (const el of container.slice(0, 40)) {
        if (items.length >= 20) break;
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          const parts = [];
          for (const [k, v] of Object.entries(el)) {
            if (v == null || typeof v === 'object') continue;
            const sv = String(v).replace(/\s+/g, ' ').trim();
            if (!sv || NOISE_VAR_KEY_RE.test(k)) continue;
            parts.push(`${k}:${sv.slice(0, 60)}`);
          }
          const rowTxt = parts.join(' · ').slice(0, 180);
          if (rowTxt && (STORY_VIS_RE.test(rowTxt) || VIS_KEY_RE.test(rowTxt))) {
            const hit = parts.some((p) => matchTermScore(p.split(':')[1] || p, curLower, prevLower) > 0);
            items.push({ score: hit ? 6.0 : 3.5, text: `数据库记录：${rowTxt}` });
          }
        } else {
          extractGenericTableItems(el, curLower, prevLower, items, depth + 1);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(container)) {
      if (k === 'LittleWhiteBox') continue;
      if (v && typeof v === 'object') {
        extractGenericTableItems(v, curLower, prevLower, items, depth + 1);
      }
    }
  }

  function collectUniversalMemoryPlugins(ctx, mesObj, curLower, prevLower) {
    const items = [];
    const promptKeyRe = /memory|table|sheet|summary|amily|vector|lore|note|remember|rag|db|mem|状态|记忆|总结|表格/i;
    const systemBoilerplateRe = /(?:You are an AI|Write the next|jailbreak|system prompt|roleplay as|uncensored model|<rules>)/i;

    // 1. Third-party extensionPrompts (表格记忆 st-memory-enhancement, Amily2, VectorStorage, Summarize, Author's Note, etc.)
    try {
      const extPrompts = ctx?.extensionPrompts || {};
      for (const [key, val] of Object.entries(extPrompts)) {
        if (!val) continue;
        const rawStr = typeof val === 'string' ? val : (val.value || val.text || '');
        if (!rawStr || typeof rawStr !== 'string') continue;
        if (!promptKeyRe.test(key) && systemBoilerplateRe.test(rawStr)) continue;

        const cleaned = cleanFloorForDistill(rawStr, false);
        if (!cleaned) continue;
        const isMemKey = promptKeyRe.test(key);
        const lines = cleaned.split(/\r?\n/);
        for (const rawLine of lines) {
          let line = rawLine.trim();
          if (!line || /^\|?[\s:-]{3,}(?:\|[\s:-]+)+\|?$/.test(line)) continue;
          if (systemBoilerplateRe.test(line)) continue;
          if (line.includes('|')) {
            line = line
              .split('|')
              .map((c) => c.trim())
              .filter(Boolean)
              .join(' · ');
          }
          if (line.length < 8 || line.length > 220) continue;

          const visMatch = VIS_KEY_RE.test(line) || STORY_VIS_RE.test(line);
          const tokens = line.split(/[\s·：:,，、]+/).filter((t) => t.length >= 2).slice(0, 5);
          const hitScore = tokens.reduce((acc, tok) => Math.max(acc, matchTermScore(tok, curLower, prevLower)), 0);
          if (!visMatch && !(isMemKey && hitScore > 0)) continue;

          const score = 3.2 + (isMemKey ? 1.5 : 0) + (visMatch ? 2.2 : 0) + hitScore;
          items.push({ score, text: `记忆插件：${line.slice(0, 180)}` });
        }
      }
    } catch {}

    // 2. Built-in summaries & generic table metadata (st-memory-enhancement sheets/hash_sheets, custom DBs)
    try {
      const summaryTexts = [
        ctx?.chatMetadata?.memory?.summary,
        ctx?.chatMetadata?.summary,
        mesObj?.extra?.summary,
      ];
      for (const stSum of summaryTexts) {
        const s = cleanFloorForDistill(stSum || '', false);
        if (s) items.push({ score: 4.5, text: `剧情摘要：${s.slice(0, 240)}` });
      }
      const tableContainers = [
        ctx?.chatMetadata?.sheets,
        ctx?.chatMetadata?.hash_sheets,
        ctx?.chatMetadata?.memory_tables,
        ctx?.chatMetadata?.tableData,
        mesObj?.hash_sheets,
        mesObj?.extra?.tableData,
        mesObj?.extra?.memory,
      ];
      for (const tc of tableContainers) {
        if (tc) extractGenericTableItems(tc, curLower, prevLower, items);
      }
    } catch {}

    // 3. Deep variables scan (MVU stat_data, swipe variables, chat/global variables)
    try {
      const varHints = [];
      const activeSwipeVars = Array.isArray(mesObj?.variables)
        ? mesObj.variables[mesObj.swipe_id ?? 0]
        : null;
      collectVariableVisualHints(activeSwipeVars, varHints);
      collectVariableVisualHints(mesObj?.variables, varHints);
      collectVariableVisualHints(ctx?.chatMetadata?.variables, varHints);
      collectVariableVisualHints(ctx?.variables?.local, varHints);
      for (const vh of varHints.slice(0, 8)) {
        items.push({ score: 5.0, text: `当前状态变量 ${vh}` });
      }
    } catch {}

    return items;
  }

  function collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, maxLookback = 30) {
    const items = [];
    try {
      const chat = ctx?.chat || [];
      if (!chat.length || mesId <= 0) return items;

      const entityHints = new Set();
      const addHint = (tok) => {
        const t = String(tok || '').trim();
        if (t.length >= 2 && t.length <= 12) entityHints.add(t);
      };
      addHint(mesObj?.name);
      addHint(ctx?.name2);
      const curNames = curCleanText.match(/[A-Z][a-z]{2,14}|[\u4e00-\u9fa5]{2,4}(?=(?:说|笑|问|看|望|低头|抬手|转身|轻声|的))/g) || [];
      for (const n of curNames.slice(0, 12)) addHint(n);

      const startIdx = Math.max(0, mesId - maxLookback);
      for (let i = mesId - 1; i >= startIdx; i--) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes) continue;
        const clean = cleanFloorForDistill(m.mes, false);
        if (!clean) continue;

        const dist = mesId - 1 - i;
        const sentences = clean.split(/[。！？!\?\n]+/);
        for (const rawSent of sentences) {
          const s = rawSent.trim();
          if (s.length < 10 || s.length > 150) continue;
          if (!STORY_VIS_RE.test(s)) continue;

          const hasStickyAppearance = APPEARANCE_STICKY_RE.test(s);
          // Skip stale location-only lines from >3 turns back so old rooms never override current scene
          if (dist >= 3 && !hasStickyAppearance) continue;

          let entityBoost = 0;
          for (const tok of entityHints) {
            if (s.includes(tok)) {
              entityBoost = 2.6;
              break;
            }
          }
          const speaker = m.name || (m.is_user ? ctx?.name1 : ctx?.name2) || '';
          const recency = Math.max(1.0, 4.4 - dist * 0.12);
          const score = recency + (hasStickyAppearance ? 2.1 : 0.4) + entityBoost;
          items.push({
            score,
            text: `${speaker ? `${speaker}前文` : '前文特征'}：${s}`,
          });
        }
      }
    } catch {}
    return items;
  }

  async function collectWorldContext(ctx, mesId, mesObj, curCleanText, prevCleanText, settings, rawFloorText = '') {
    const ch = ctx?.characters?.[ctx.characterId];
    const chData = ch?.data || {};
    const curLower = normText(curCleanText);
    const prevLower = normText(prevCleanText);

    const userName = ctx?.name1 || '';
    const userAppearance = String(ctx?.powerUserSettings?.persona_description || '').trim().slice(0, 220);
    const prevVisualPrompt = findPrevVisualPrompt(ctx, mesId);
    const memoryMode = settings.memoryMode || (settings.autoWorldLore === false ? 'off' : 'smart');

    if (memoryMode === 'off') {
      return { memoryContext: '', userName, userAppearance, prevVisualPrompt: '' };
    }

    const candidates = [];

    // Status block visual cues extracted before tag stripping (works in both smart & story_only)
    candidates.push(...extractVisualStatusFromRaw(rawFloorText || mesObj?.mes || ''));

    if (memoryMode === 'story_only') {
      candidates.push(...collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, 35));
    } else {
      // Source A: 小白X (storySummary.json + stateAtoms)
      const xbxItems = collectXiaobaiXMemory(ctx, mesId, curLower, prevLower);
      candidates.push(...xbxItems);

      // Source B: Universal third-party memory plugins (extensionPrompts, tables, MVU/chat vars)
      const pluginItems = collectUniversalMemoryPlugins(ctx, mesObj, curLower, prevLower);
      candidates.push(...pluginItems);

      // Source C: Card scenario / description brief
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

      // Source D: SillyTavern World Info (embedded character_book + linked external + chat metadata)
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

      // Source E: Story-based trait extraction (auto-fills appearance/outfit consistency if no plugins or sparse records)
      const storyItems = collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, 30);
      const pluginCount = xbxItems.length + pluginItems.length;
      for (const si of storyItems) {
        candidates.push({
          score: pluginCount >= 4 ? si.score - 1.0 : si.score + 0.5,
          text: si.text,
        });
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const outLines = [];
    const seenOut = new Set();
    let totalLen = 0;
    for (const c of candidates) {
      const sig = c.text.slice(0, 48);
      if (seenOut.has(sig)) continue;
      if (totalLen + c.text.length + 1 > 1650) break;
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
    const raw = String(baseUrl || '').trim();
    const url = normalizeStudioUrl(raw);
    if (!url) {
      return { ok: false, reason: 'empty_url', url: '', detail: '未填写生图服务地址' };
    }
    if (
      typeof window !== 'undefined' &&
      window.location?.protocol === 'https:' &&
      /^http:\/\//i.test(url) &&
      !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url)
    ) {
      return {
        ok: false,
        reason: 'mixed_content',
        url,
        detail: '当前酒馆是 HTTPS 页面，浏览器禁止直接请求 HTTP 地址；请改用 HTTPS 生图地址（如 https://域名/yiyi-mac）',
      };
    }

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
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          return {
            ok: false,
            status: resp.status,
            reason: 'auth_error',
            url,
            detail: '配置密码未填或不正确，请在下方输入框核对密码',
          };
        }
        if (resp.status === 404) {
          const isRel = raw.startsWith('/');
          return {
            ok: false,
            status: 404,
            reason: isRel ? 'not_found_relative' : 'not_found_remote',
            url,
            detail: isRel
              ? `相对路径 ${raw} 返回 404——若你在用自己的酒馆或未配置同源反代，请改成完整远程地址（如 https://域名/yiyi-mac）`
              : '接口 404（路径不对），请检查地址末尾是否漏写 /yiyi-mac',
          };
        }
        if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
          return {
            ok: false,
            status: resp.status,
            reason: 'bad_gateway',
            url,
            detail: `网关或隧道在线，但生图服务未启动或正在重启 (HTTP ${resp.status})`,
          };
        }
        return {
          ok: false,
          status: resp.status,
          reason: 'http_error',
          url,
          detail: `服务端返回异常状态 HTTP ${resp.status}`,
        };
      }

      const ct = (resp.headers?.get?.('content-type') || '').toLowerCase();
      let data = null;
      try {
        data = await resp.json();
      } catch {}
      if (!data || typeof data !== 'object' || (!('online' in data) && !ct.includes('application/json'))) {
        return {
          ok: false,
          status: resp.status,
          reason: 'not_bridge',
          url,
          detail: '目标返回了网页而非生图接口，请检查地址末尾是否漏写 /yiyi-mac 或被登录页拦截',
        };
      }
      if (data.online === false) {
        return {
          ok: false,
          status: resp.status,
          reason: 'comfy_offline',
          url,
          detail: '桥接服务在线，但后端渲染引擎（ComfyUI）离线',
        };
      }
      return { ok: true, status: resp.status, url, data };
    } catch (err) {
      if (err?.name === 'AbortError') {
        const sec = Math.max(1, Math.round(timeoutMs / 100) / 10);
        return {
          ok: false,
          reason: 'timeout',
          url,
          detail: `连接超时（超过 ${sec}s 无响应），请检查网络、代理或服务端是否开机`,
        };
      }
      return {
        ok: false,
        reason: 'network_error',
        url,
        detail: '无法连通目标地址（请检查地址拼写、网络/代理、CORS 或服务端是否在线）',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function getMacProbeCandidates(rawMacUrl) {
    const normRaw = String(rawMacUrl ?? '').trim().replace(/\/+$/, '');
    const isHttpsPage = typeof window !== 'undefined' && window.location?.protocol === 'https:';
    if (BUILTIN_MAC_URLS.has(normRaw)) {
      if (isHttpsPage) {
        return [{ url: DEFAULT_MAC_HTTPS_URL, timeout: 6500 }];
      }
      return [
        { url: DEFAULT_MAC_HTTP_URL, timeout: 3500 },
        { url: DEFAULT_MAC_HTTPS_URL, timeout: 6500 },
      ];
    }
    return [{ url: normRaw, timeout: 6500 }];
  }

  async function resolveStudioUrl() {
    const s = getSettings();
    const policy = s.backendPolicy || 'mac';
    let winErr = null;
    let macErr = null;

    if (policy !== 'mac') {
      const localUrl = String(s.localUrl || '').trim();
      if (localUrl) {
        const localRes = await pingEndpoint(localUrl, s.token, 1200);
        if (localRes?.ok) {
          activeStudioUrl = localRes.url;
          activeEndpointMode = 'local';
          activeBusy = !!localRes.data?.busy;
          lastConnError = null;
          updateConnectionUi();
          return localRes;
        }
        winErr = localRes;
      }
      const remoteUrl = String(s.remoteUrl || '').trim();
      if (remoteUrl) {
        const remoteRes = await pingEndpoint(remoteUrl, s.token, 4000);
        if (remoteRes?.ok) {
          activeStudioUrl = remoteRes.url;
          activeEndpointMode = 'remote';
          activeBusy = !!remoteRes.data?.busy;
          lastConnError = null;
          updateConnectionUi();
          return remoteRes;
        }
        winErr = remoteRes;
      }
      if (!localUrl && !remoteUrl) {
        winErr = { ok: false, reason: 'empty_url', url: '', detail: '未填写 Windows 生图地址' };
      }
      if (policy === 'windows') {
        activeStudioUrl = null;
        lastConnError = winErr;
        activeEndpointMode = winErr?.reason || 'offline';
        activeBusy = false;
        updateConnectionUi();
        return winErr;
      }
    }

    if (policy !== 'windows') {
      const candidates = getMacProbeCandidates(s.macUrl);
      for (const cand of candidates) {
        const macRes = await pingEndpoint(cand.url, s.token, cand.timeout);
        if (macRes?.ok) {
          activeStudioUrl = macRes.url;
          activeEndpointMode = 'mac';
          activeBusy = !!macRes.data?.busy;
          lastConnError = null;
          updateConnectionUi();
          return macRes;
        }
        macErr = macRes;
        if (macRes?.reason === 'auth_error' || macRes?.reason === 'comfy_offline') {
          break;
        }
      }
    }

    const bestErr =
      (winErr?.reason === 'auth_error' ? winErr : null) ||
      macErr ||
      winErr ||
      { ok: false, reason: 'network_error', url: '', detail: '暂未连上生图服务' };

    activeStudioUrl = null;
    lastConnError = bestErr;
    activeEndpointMode = bestErr.reason || 'offline';
    activeBusy = false;
    updateConnectionUi();
    return bestErr;
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
      tag.textContent = activeProgressLabel || (s.enabled ? '自动:开' : '自动:关');
    }
    if (statusText) {
      if (activeEndpointMode === 'local') {
        statusText.textContent = `🟢 本机 4060 直连 (${activeStudioUrl})`;
      } else if (activeEndpointMode === 'remote') {
        statusText.textContent = `🟢 远程 4060 在线 (${activeStudioUrl})`;
      } else if (activeEndpointMode === 'mac') {
        statusText.textContent = `🟢 Mac 24h 极速在线 (${activeStudioUrl || s.macUrl || DEFAULT_MAC_HTTPS_URL})`;
      } else if (activeEndpointMode === 'auth_error') {
        statusText.textContent = '🔒 需要输入正确的配置密码';
      } else if (activeEndpointMode === 'mixed_content') {
        statusText.textContent = '⚠️ HTTPS 页面禁止直连 HTTP 地址';
      } else if (activeEndpointMode === 'not_found_relative') {
        statusText.textContent = '❓ 相对路径 404，请改填完整远程地址';
      } else if (activeEndpointMode === 'not_found_remote') {
        statusText.textContent = '❓ 接口 404（请检查 /yiyi-mac 路径）';
      } else if (activeEndpointMode === 'bad_gateway') {
        statusText.textContent = '⚠️ 网关通但生图服务未启动';
      } else if (activeEndpointMode === 'not_bridge') {
        statusText.textContent = '❓ 返回了非生图网页（请检查路径）';
      } else if (activeEndpointMode === 'comfy_offline') {
        statusText.textContent = '⚠️ 桥接在线但渲染引擎离线';
      } else if (activeEndpointMode === 'timeout') {
        statusText.textContent = '⏱️ 连接超时，请检查网络或服务端';
      } else if (activeEndpointMode === 'empty_url') {
        statusText.textContent = '⚪ 未填写生图服务地址';
      } else {
        statusText.textContent = '⚪ 未连通（点「测试连接」查看详情）';
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

  function hasForeignPopoverOpen() {
    try {
      const nodes = document.querySelectorAll?.('[popover]') || [];
      for (const n of nodes) {
        if (n && !String(n.id || '').startsWith('yiyi-') && n.matches?.(':popover-open')) {
          return true;
        }
      }
    } catch {}
    return false;
  }

  function syncTopLayer(el, shouldBeVisible, forceRestack = false) {
    if (!el) return;
    const foreignOpen = hasForeignPopoverOpen();
    const hasPop = typeof el.showPopover === 'function' && typeof el.hidePopover === 'function';
    if (!shouldBeVisible) {
      try {
        if (hasPop && el.matches?.(':popover-open')) el.hidePopover();
      } catch {}
      try {
        if (el.hasAttribute?.('popover')) el.removeAttribute('popover');
      } catch {}
      return;
    }
    if (foreignOpen && hasPop) {
      try {
        if (el.getAttribute?.('popover') !== 'manual') {
          el.setAttribute('popover', 'manual');
        }
        if (forceRestack && el.matches?.(':popover-open')) {
          el.hidePopover();
        }
        if (!el.matches?.(':popover-open')) {
          el.showPopover();
        }
      } catch {}
    }
  }

  function promoteHudAbovePopovers() {
    const foreignOpen = hasForeignPopoverOpen();
    const hudIds = ['yiyi-st-fab', 'yiyi-float-progress', 'yiyi-overlay-viewer', 'yiyi-st-panel', 'yiyi-lightbox'];
    for (const id of hudIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const visible = !el.classList?.contains('yiyi-hidden');
      if (!foreignOpen && el.matches?.(':popover-open')) {
        syncTopLayer(el, false);
      } else if (foreignOpen && visible) {
        syncTopLayer(el, true, true);
      }
    }
  }

  function isElementHidden(el) {
    if (!el) return true;
    try {
      const cs = window.getComputedStyle?.(el);
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0)) {
        return true;
      }
      const r = el.getBoundingClientRect?.();
      if (r && (r.height < 20 || r.width < 20)) return true;
    } catch {}
    return false;
  }

  function isSameFloorOverlayActive(mesEl) {
    try {
      const ctx = getCtx();
      const targetEl = mesEl || document.querySelector?.('#chat .mes[mesid]');
      if (!targetEl) {
        if ((ctx?.chat?.length || 0) > 0) return true;
      } else if (isElementHidden(targetEl)) {
        return true;
      }

      const chatEl = document.getElementById?.('chat');
      const chatRect = chatEl?.getBoundingClientRect?.();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const chatW = chatRect?.width || vw;
      const chatH = Math.min(chatRect?.height || vh || 800, vh || 800);

      const iframes = document.querySelectorAll?.('iframe') || [];
      for (const ifr of iframes) {
        if (!ifr) continue;
        if (ifr.matches?.(':popover-open')) return true;
        let cs = null;
        try { cs = window.getComputedStyle?.(ifr); } catch {}
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue;
        const ir = ifr.getBoundingClientRect?.();
        if (!ir || ir.width < 10 || ir.height < 10) continue;
        const coversChat = ir.width >= Math.max(200, chatW * 0.6) && ir.height >= Math.max(160, chatH * 0.5);
        const overlayPos = cs?.position === 'fixed' || cs?.position === 'sticky' || cs?.position === 'absolute';
        if (coversChat && (overlayPos || ir.height >= Math.max(280, (vh || 800) * 0.72))) {
          return true;
        }
      }

      if (mesEl && typeof document.elementFromPoint === 'function') {
        const media = mesEl.querySelector?.('.mes_media img, .mes_img');
        const mr = media?.getBoundingClientRect?.();
        const maxW = vw || 1280;
        const maxH = vh || 800;
        if (mr && mr.width > 10 && mr.height > 10 && mr.top >= 0 && mr.left >= 0 && mr.bottom <= maxH && mr.right <= maxW) {
          const cx = mr.left + mr.width / 2;
          const cy = mr.top + mr.height / 2;
          const hit = document.elementFromPoint(cx, cy);
          if (
            hit &&
            (hit.tagName === 'IFRAME' ||
              (!mesEl.contains?.(hit) &&
                !hit.closest?.('#yiyi-st-fab, #yiyi-st-panel, #yiyi-overlay-viewer, #yiyi-float-progress, #yiyi-lightbox')))
          ) {
            return true;
          }
        }
      }
    } catch {}
    return false;
  }

  function collectChatIllustrations() {
    const items = [];
    try {
      const ctx = getCtx();
      const chat = ctx?.chat || [];
      for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        const mediaArr = Array.isArray(m.extra?.media) ? m.extra.media : [];
        for (let idx = 0; idx < mediaArr.length; idx++) {
          const item = mediaArr[idx];
          if (!item?.url) continue;
          if (item.type && item.type !== 'image') continue;
          items.push({
            mesId: i,
            mediaIdx: idx,
            url: item.url,
            title: String(item.title || '').trim(),
            negative: String(item.negative || '').trim(),
            charName: m.name || getActiveCharName() || '角色',
          });
        }
      }
    } catch {}
    return items;
  }

  function updateGalleryBadge() {
    const badge = document.getElementById('yiyi-fab-badge');
    if (!badge) return;
    const count = collectChatIllustrations().length;
    if (count > 0) {
      badge.textContent = String(count);
      badge.style.display = 'inline-block';
    } else {
      badge.textContent = '0';
      badge.style.display = 'none';
    }
  }

  function openLightbox(srcUrl) {
    const lb = document.getElementById('yiyi-lightbox');
    const img = document.getElementById('yiyi-lb-img');
    if (!lb || !img || !srcUrl) return;
    img.src = srcUrl;
    lb.classList.remove('yiyi-hidden');
    syncTopLayer(lb, true, true);
  }

  function closeLightbox() {
    const lb = document.getElementById('yiyi-lightbox');
    if (!lb) return;
    syncTopLayer(lb, false);
    lb.classList.add('yiyi-hidden');
  }

  function renderOverlayViewer(preferredMesId = null) {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    const items = collectChatIllustrations();
    const titleEl = document.getElementById('yiyi-ov-title');
    const stageEl = document.getElementById('yiyi-ov-stage');
    const metaEl = document.getElementById('yiyi-ov-meta');
    const promptEl = document.getElementById('yiyi-ov-prompt-text');
    const redrawBtn = document.getElementById('yiyi-ov-redraw');
    const zoomBtn = document.getElementById('yiyi-ov-zoom');

    if (!items.length) {
      overlayIndex = 0;
      if (titleEl) titleEl.textContent = '🖼️ 依依同层悬浮画框';
      if (stageEl) {
        stageEl.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'yiyi-ov-empty';
        empty.textContent = '当前对话还没有插画。\n在同层卡或伪同层界面中，直接点下方按钮或悬浮球 🖌️ 就能立即绘制并显示在这里。';
        stageEl.appendChild(empty);
      }
      if (metaEl) metaEl.textContent = '共 0 张 · 随时可生成';
      if (promptEl) promptEl.textContent = '';
      if (redrawBtn) redrawBtn.dataset.mesId = '';
      if (zoomBtn) zoomBtn.dataset.url = '';
      return;
    }

    if (preferredMesId !== null && preferredMesId !== undefined) {
      let foundIdx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (Number(items[i].mesId) === Number(preferredMesId)) {
          foundIdx = i;
          break;
        }
      }
      overlayIndex = foundIdx >= 0 ? foundIdx : items.length - 1;
    } else if (overlayIndex < 0 || overlayIndex >= items.length) {
      overlayIndex = items.length - 1;
    }

    const cur = items[overlayIndex];
    if (titleEl) titleEl.textContent = `🖼️ ${cur.charName} · 第 ${cur.mesId} 层`;
    if (stageEl) {
      stageEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = cur.url;
      img.alt = `第 ${cur.mesId} 层插画`;
      img.onclick = () => openLightbox(cur.url);
      stageEl.appendChild(img);
    }
    if (metaEl) metaEl.textContent = `第 ${overlayIndex + 1} / ${items.length} 张 · 第 ${cur.mesId} 层`;
    if (promptEl) {
      promptEl.textContent = cur.title
        ? `Positive:\n${cur.title}${cur.negative ? `\n\nNegative:\n${cur.negative}` : ''}`
        : '（未记录提示词）';
    }
    if (redrawBtn) redrawBtn.dataset.mesId = String(cur.mesId);
    if (zoomBtn) zoomBtn.dataset.url = cur.url;
  }

  function showOverlayViewer(preferredMesId = null) {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    overlayCollapsed = false;
    viewer.classList.remove('yiyi-ov-collapsed');
    viewer.classList.remove('yiyi-hidden');
    const collapseBtn = document.getElementById('yiyi-ov-collapse');
    if (collapseBtn) collapseBtn.textContent = '—';
    renderOverlayViewer(preferredMesId);
    syncTopLayer(viewer, true, true);
  }

  function hideOverlayViewer() {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    syncTopLayer(viewer, false);
    viewer.classList.add('yiyi-hidden');
  }

  function setGlobalProgress(msg, pct, showFloatingPill = false) {
    activeProgressLabel = typeof pct === 'number' ? `绘图中 ${Math.round(pct)}%` : '绘图中…';
    updateConnectionUi();
    const pill = document.getElementById('yiyi-float-progress');
    if (!pill) return;
    if (showFloatingPill) {
      pill.classList.remove('yiyi-hidden');
      const label = pill.querySelector('.yiyi-floor-msg');
      const fill = pill.querySelector('.yiyi-floor-bar-fill');
      if (label) label.textContent = msg;
      if (fill && typeof pct === 'number') {
        fill.style.width = `${Math.max(5, Math.min(100, pct))}%`;
      }
      syncTopLayer(pill, true);
    }
  }

  function clearGlobalProgress() {
    activeProgressLabel = '';
    updateConnectionUi();
    const pill = document.getElementById('yiyi-float-progress');
    if (pill) {
      syncTopLayer(pill, false);
      pill.classList.add('yiyi-hidden');
    }
  }

  function drawLatestFloor() {
    const ctx = getCtx();
    const chat = ctx?.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
      if (!chat[i].is_user && !chat[i].is_system) {
        illustrateFloor(i, true);
        return;
      }
    }
    toastInfo('当前对话还没有可绘制的 AI 楼层', 'info');
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

  function formatHttpErr(status, action, bodyText = '') {
    const snippet = String(bodyText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (status === 401 || status === 403) return `${action}失败 (${status})：配置密码未填或已失效，请在悬浮窗核对密码`;
    if (status === 404) return `${action}失败 (404)：接口路径不存在，请检查地址末尾是否漏写 /yiyi-mac`;
    if (status === 429) return `${action}失败 (429)：请求太快啦，请稍等几秒再试`;
    if (status === 502 || status === 503 || status === 504) return `${action}失败 (${status})：网关或隧道暂时连不上后台渲染服务`;
    return `${action}失败 (HTTP ${status})${snippet ? `：${snippet}` : ''}`;
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
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`上传到酒馆失败 (${resp.status})：酒馆登录会话或 CSRF 已过期，请刷新页面后重试`);
      }
      if (resp.status === 413) {
        throw new Error('上传到酒馆失败 (413)：图片体积超过酒馆或反代限制');
      }
      const txt = await resp.text().catch(() => '');
      throw new Error(`上传到酒馆失败 (${resp.status})${txt ? `: ${txt.slice(0, 140)}` : ''}`);
    }
    const data = await resp.json();
    return data.path;
  }

  async function attachImageToFloor(mesId, savedPath, positivePrompt, negativePrompt) {
    const ctx = getCtx();
    const mes = ctx?.chat?.[mesId];
    const mesEl = document.querySelector(`.mes[mesid="${mesId}"]`);
    if (!mes) return;

    if (!mes.extra || typeof mes.extra !== 'object') {
      mes.extra = {};
    }
    const jq = window.$ || window.jQuery;
    if (typeof ctx.ensureMessageMediaIsArray === 'function') {
      ctx.ensureMessageMediaIsArray(mes);
    }
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

    if (mesEl) {
      if (typeof ctx.appendMediaToMessage === 'function' && typeof jq === 'function') {
        ctx.appendMediaToMessage(mes, jq(mesEl));
      } else {
        const img = document.createElement('img');
        img.src = savedPath;
        img.className = 'mes_img';
        img.style.maxWidth = '100%';
        img.style.borderRadius = '8px';
        mesEl.querySelector('.mes_text')?.after(img);
      }
    }

    if (typeof ctx.saveChat === 'function') {
      await ctx.saveChat();
    }

    updateGalleryBadge();
    const s = getSettings();
    const mode = s.overlayMode || 'auto';
    if (mode === 'always' || (mode !== 'floor_only' && isSameFloorOverlayActive(mesEl))) {
      showOverlayViewer(mesId);
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
        const showErr = isManual || conn?.reason === 'auth_error' || conn?.reason === 'mixed_content' || !s.silentOffline;
        if (showErr) {
          const target = conn?.url ? ` [${conn.url}]` : '';
          toastInfo(
            `${conn?.detail || '暂未连上生图服务，请检查网络与服务状态'}${target}`,
            conn?.reason === 'auth_error' ? 'error' : 'warning',
          );
        }
        return;
      }

      const showFloat = s.overlayMode === 'always' || !mesEl || isSameFloorOverlayActive(mesEl);
      if (mesEl) setFloorStatus(mesEl, '正在提取记忆与剧情画面特征…', 8);
      setGlobalProgress('正在提取记忆与剧情画面特征…', 8, showFloat);

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
      const lore = await collectWorldContext(ctx, idNum, mes, cleanedFloor, recentContext, s, mes.mes);

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
        const errBody = await startResp.text().catch(() => '');
        throw new Error(formatHttpErr(startResp.status, '启动生图任务', errBody));
      }
      const { job_id } = await startResp.json();

      // Poll job state cleanly (tolerates up to 3 transient mobile/Cloudflare blips)
      let jobData = null;
      let transientErrors = 0;
      const deadline = Date.now() + 260000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 900));
        let jr;
        try {
          jr = await fetch(`${activeStudioUrl}/api/jobs/${job_id}`, {
            method: 'GET',
            headers: buildHeaders(s),
          });
        } catch (netErr) {
          transientErrors += 1;
          if (transientErrors > 3) {
            throw new Error(`查询生图进度中断：${netErr?.message || '网络连接断开'}`);
          }
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        if (!jr.ok) {
          if (jr.status === 502 || jr.status === 503 || jr.status === 504) {
            transientErrors += 1;
            if (transientErrors <= 3) {
              await new Promise((r) => setTimeout(r, 1200));
              continue;
            }
          }
          const errBody = await jr.text().catch(() => '');
          throw new Error(formatHttpErr(jr.status, '查询生图进度', errBody));
        }
        transientErrors = 0;
        jobData = await jr.json();

        if (jobData.status === 'done') break;
        if (jobData.status === 'error') throw new Error(jobData.error || '服务端渲染出错');
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
        setGlobalProgress(msg, pct, showFloat);
      }

      if (!jobData || jobData.status !== 'done') {
        throw new Error('生成超时（超过 4 分钟未完成），请检查服务端状态');
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
      setGlobalProgress('正在保存到酒馆楼层…', 97, showFloat);
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
      clearGlobalProgress();
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

  function attachFixedDrag(handleEl, targetEl, opts = {}) {
    if (!handleEl || !targetEl) return;
    const anchorY = opts.anchorY === 'top' ? 'top' : 'bottom';
    const minW = opts.minW || 90;
    const minH = opts.minH || 48;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let origRight = 16;
    let origY = 76;

    handleEl.addEventListener('pointerdown', (e) => {
      if (opts.ignoreSelector && e.target?.closest?.(opts.ignoreSelector)) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = targetEl.getBoundingClientRect?.();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      origRight = rect ? vw - rect.right : 16;
      origY = rect ? (anchorY === 'top' ? rect.top : vh - rect.bottom) : 76;
      handleEl.setPointerCapture?.(e.pointerId);
    });
    handleEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      const nextRight = Math.max(8, Math.min(vw - minW, origRight - dx));
      const nextY = Math.max(8, Math.min(vh - minH, anchorY === 'top' ? origY + dy : origY - dy));
      targetEl.style.right = `${nextRight}px`;
      targetEl.style[anchorY] = `${nextY}px`;
    });
    handleEl.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      handleEl.releasePointerCapture?.(e.pointerId);
      if (moved) {
        opts.onSavePos?.({
          right: parseInt(targetEl.style.right, 10) || 16,
          [anchorY]: parseInt(targetEl.style[anchorY], 10) || (anchorY === 'top' ? 64 : 76),
        });
      } else {
        opts.onClick?.(e);
      }
    });
  }

  function buildFloatingUi() {
    if (document.getElementById('yiyi-st-fab')) return;
    const s = getSettings();

    const fab = document.createElement('div');
    fab.id = 'yiyi-st-fab';
    fab.innerHTML = `<span class="yiyi-dot"></span><span>🎨</span><span class="yiyi-state-tag">自动:关</span><button type="button" class="yiyi-fab-mini" id="yiyi-fab-draw" title="立即为最新楼层生图">🖌️</button><button type="button" class="yiyi-fab-mini" id="yiyi-fab-gallery" title="打开/收起悬浮画框（同层卡专用）">🖼️<span class="yiyi-fab-badge" id="yiyi-fab-badge" style="display:none">0</span></button>`;
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
        <button class="yiyi-btn" id="yiyi-btn-gallery">🖼️ 打开本局插画画廊（同层卡专用）</button>

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

        <div class="yiyi-field">
          <label>剧情记忆与人物一致性来源</label>
          <select id="yiyi-opt-memory-mode">
            <option value="smart">智能全适配 (小白X/表格/数据库/世界书 + 剧情自总结)</option>
            <option value="story_only">仅前文剧情自总结 (无任何记忆插件也适用)</option>
            <option value="off">关闭记忆读取 (只看当前这一楼)</option>
          </select>
        </div>
        <div class="yiyi-field">
          <label>同层卡 / 伪同层适配展示</label>
          <select id="yiyi-opt-overlay-mode">
            <option value="auto">智能同层适配 (普通卡贴楼层，同层/伪同层自动弹悬浮画框)</option>
            <option value="always">始终弹出悬浮画框 (同时保留楼层原图)</option>
            <option value="floor_only">仅挂载到酒馆楼层 (关闭悬浮画框)</option>
          </select>
        </div>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-hires" /> 开启 1.5x 高清重绘（耗时略增，细节更锐利）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-skip-first" /> 跳过开场白（第0层不自动画）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-silent" /> 无可用生图服务时静默不弹窗</label>

        <div class="yiyi-field">
          <label>Mac 24h 公网服务地址（已内置直连 + HTTPS 自动兜底）</label>
          <input type="text" id="yiyi-opt-mac-url" placeholder="https://draw.fzy.asia/yiyi-mac" />
          <div class="yiyi-hint">提示：已内置公网地址（HTTP 酒馆优先高速直连，HTTPS 酒馆或直连不通时自动切 HTTPS 隧道）；通常不用改地址，填好下方配置密码即可。</div>
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

    const floatProg = document.createElement('div');
    floatProg.id = 'yiyi-float-progress';
    floatProg.className = 'yiyi-hidden';
    floatProg.innerHTML = `
      <div class="yiyi-floor-msg">正在准备生图…</div>
      <div class="yiyi-floor-bar-track"><div class="yiyi-floor-bar-fill"></div></div>
    `;

    const viewer = document.createElement('div');
    viewer.id = 'yiyi-overlay-viewer';
    viewer.className = 'yiyi-hidden';
    viewer.innerHTML = `
      <div class="yiyi-ov-head" id="yiyi-ov-head" title="按住此处可拖动悬浮画框">
        <div class="yiyi-ov-title" id="yiyi-ov-title">🖼️ 依依同层悬浮画框</div>
        <div class="yiyi-ov-actions">
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-prev" title="上一张">◀</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-next" title="下一张">▶</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-redraw" title="重画这一层">🔄</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-zoom" title="大图放大">🔍</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-collapse" title="折叠/展开">—</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-close" title="收起画框">✕</button>
        </div>
      </div>
      <div class="yiyi-ov-img-wrap" id="yiyi-ov-stage"></div>
      <div class="yiyi-ov-foot">
        <div class="yiyi-ov-meta-row">
          <span class="yiyi-ov-meta" id="yiyi-ov-meta">第 0 层</span>
          <button type="button" class="yiyi-btn" id="yiyi-ov-draw-last">🖌️ 画最新一楼</button>
        </div>
        <details class="yiyi-details">
          <summary>查看本图提示词</summary>
          <textarea id="yiyi-ov-prompt-text" rows="4" readonly></textarea>
        </details>
      </div>
    `;
    if (s.overlayPos && typeof s.overlayPos.right === 'number' && typeof s.overlayPos.top === 'number') {
      viewer.style.right = `${s.overlayPos.right}px`;
      viewer.style.top = `${s.overlayPos.top}px`;
    }

    const lightbox = document.createElement('div');
    lightbox.id = 'yiyi-lightbox';
    lightbox.className = 'yiyi-hidden';
    lightbox.innerHTML = `
      <button type="button" class="yiyi-lb-close" id="yiyi-lb-close" title="关闭大图">✕</button>
      <img id="yiyi-lb-img" alt="插画预览" />
    `;

    document.body.append(fab, panel, floatProg, viewer, lightbox);

    attachFixedDrag(fab, fab, {
      anchorY: 'bottom',
      minW: 110,
      minH: 48,
      ignoreSelector: '.yiyi-fab-mini',
      onSavePos: (pos) => {
        const st = getSettings();
        st.fabPos = pos;
        saveSettings();
      },
      onClick: () => {
        panel.classList.toggle('yiyi-hidden');
        if (!panel.classList.contains('yiyi-hidden')) {
          syncPanelFromSettings();
          syncTopLayer(panel, true, true);
          resolveStudioUrl();
        } else {
          syncTopLayer(panel, false);
        }
      },
    });

    attachFixedDrag(document.getElementById('yiyi-ov-head'), viewer, {
      anchorY: 'top',
      minW: 200,
      minH: 48,
      ignoreSelector: '.yiyi-ov-actions, button',
      onSavePos: (pos) => {
        const st = getSettings();
        st.overlayPos = pos;
        saveSettings();
      },
    });

    const fabDrawBtn = document.getElementById('yiyi-fab-draw');
    if (fabDrawBtn) {
      fabDrawBtn.onclick = (e) => {
        e.stopPropagation();
        drawLatestFloor();
      };
    }
    const fabGalleryBtn = document.getElementById('yiyi-fab-gallery');
    if (fabGalleryBtn) {
      fabGalleryBtn.onclick = (e) => {
        e.stopPropagation();
        if (viewer.classList.contains('yiyi-hidden')) showOverlayViewer();
        else hideOverlayViewer();
      };
    }

    const closeBtn = document.getElementById('yiyi-panel-close');
    if (closeBtn) {
      closeBtn.onclick = () => {
        syncTopLayer(panel, false);
        panel.classList.add('yiyi-hidden');
      };
    }
    const testBtn = document.getElementById('yiyi-btn-test');
    if (testBtn) {
      testBtn.onclick = async () => {
        const st = getSettings();
        const readInput = (id, key) => {
          const el = document.getElementById(id);
          if (el) st[key] = el.value;
        };
        readInput('yiyi-opt-policy', 'backendPolicy');
        readInput('yiyi-opt-mac-url', 'macUrl');
        readInput('yiyi-opt-local-url', 'localUrl');
        readInput('yiyi-opt-remote-url', 'remoteUrl');
        readInput('yiyi-opt-token', 'token');
        saveSettings();

        const res = await resolveStudioUrl();
        if (res?.ok) {
          const modeLabel = activeEndpointMode === 'local'
            ? 'Windows 本机 4060'
            : activeEndpointMode === 'remote'
              ? 'Windows 远程 4060'
              : 'Mac 24h 极速';
          toastInfo(`连接成功 (${modeLabel})`, 'success');
        } else {
          const target = res?.url ? ` [${res.url}]` : '';
          toastInfo(
            `${res?.detail || '暂未连上生图服务，请检查网络与服务状态'}${target}`,
            res?.reason === 'auth_error' ? 'error' : 'warning',
          );
        }
      };
    }

    const drawLastBtn = document.getElementById('yiyi-btn-draw-last');
    if (drawLastBtn) drawLastBtn.onclick = drawLatestFloor;
    const panelGalleryBtn = document.getElementById('yiyi-btn-gallery');
    if (panelGalleryBtn) panelGalleryBtn.onclick = () => showOverlayViewer();

    const stepOverlay = (delta) => {
      const items = collectChatIllustrations();
      if (!items.length) return;
      overlayIndex = (overlayIndex + delta + items.length) % items.length;
      renderOverlayViewer();
    };
    const ovPrev = document.getElementById('yiyi-ov-prev');
    const ovNext = document.getElementById('yiyi-ov-next');
    const ovRedraw = document.getElementById('yiyi-ov-redraw');
    const ovZoom = document.getElementById('yiyi-ov-zoom');
    const ovCollapse = document.getElementById('yiyi-ov-collapse');
    const ovClose = document.getElementById('yiyi-ov-close');
    const ovDrawLast = document.getElementById('yiyi-ov-draw-last');
    const lbClose = document.getElementById('yiyi-lb-close');

    if (ovPrev) ovPrev.onclick = () => stepOverlay(-1);
    if (ovNext) ovNext.onclick = () => stepOverlay(1);
    if (ovRedraw) {
      ovRedraw.onclick = () => {
        const mid = ovRedraw.dataset?.mesId;
        if (mid !== '' && mid !== undefined) illustrateFloor(Number(mid), true);
        else drawLatestFloor();
      };
    }
    if (ovZoom) {
      ovZoom.onclick = () => {
        if (ovZoom.dataset?.url) openLightbox(ovZoom.dataset.url);
      };
    }
    if (ovCollapse) {
      ovCollapse.onclick = () => {
        overlayCollapsed = !overlayCollapsed;
        viewer.classList.toggle('yiyi-ov-collapsed', overlayCollapsed);
        ovCollapse.textContent = overlayCollapsed ? '▢' : '—';
      };
    }
    if (ovClose) ovClose.onclick = hideOverlayViewer;
    if (ovDrawLast) ovDrawLast.onclick = drawLatestFloor;
    if (lbClose) lbClose.onclick = closeLightbox;
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !lightbox.classList.contains('yiyi-hidden')) {
        closeLightbox();
      }
    });
    document.addEventListener('toggle', (e) => {
      if (String(e?.target?.id || '').startsWith('yiyi-')) return;
      setTimeout(promoteHudAbovePopovers, 30);
    }, true);

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
    bindVal('yiyi-opt-memory-mode', 'memoryMode');
    bindVal('yiyi-opt-overlay-mode', 'overlayMode');
    bindVal('yiyi-opt-hires', 'hiresFix', true);
    bindVal('yiyi-opt-skip-first', 'skipFirstMessage', true);
    bindVal('yiyi-opt-silent', 'silentOffline', true);
    bindVal('yiyi-opt-mac-url', 'macUrl', false, true);
    bindVal('yiyi-opt-local-url', 'localUrl', false, true);
    bindVal('yiyi-opt-remote-url', 'remoteUrl', false, true);
    bindVal('yiyi-opt-token', 'token', false, true);

    syncPanelFromSettings();
    updateGalleryBadge();
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
    setVal('yiyi-opt-memory-mode', s.memoryMode || (s.autoWorldLore === false ? 'off' : 'smart'));
    setVal('yiyi-opt-overlay-mode', s.overlayMode || 'auto');
    setVal('yiyi-opt-hires', s.hiresFix, true);
    setVal('yiyi-opt-skip-first', s.skipFirstMessage, true);
    setVal('yiyi-opt-silent', s.silentOffline, true);
    setVal('yiyi-opt-mac-url', s.macUrl || DEFAULT_MAC_HTTPS_URL);
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
      const idNum = Number(mesId);
      pendingAutoIds.add(idNum);
      if (s.enabled) {
        setTimeout(() => {
          if (pendingAutoIds.has(idNum)) {
            pendingAutoIds.delete(idNum);
            const curSettings = getSettings();
            if (curSettings.enabled) illustrateFloor(idNum, false);
          }
        }, 1200);
      }
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
        updateGalleryBadge();
        const viewer = document.getElementById('yiyi-overlay-viewer');
        if (viewer && !viewer.classList.contains('yiyi-hidden')) {
          renderOverlayViewer();
        }
        promoteHudAbovePopovers();
      }, 250);
    });
  }

  function init() {
    const ctx = getCtx();
    if (!ctx) {
      setTimeout(init, 600);
      return;
    }
    const existingRaw = ctx.extensionSettings?.[EXT_KEY];
    const prevMacNorm = typeof existingRaw?.macUrl === 'string'
      ? existingRaw.macUrl.trim().replace(/\/+$/, '')
      : '';
    const shouldPersistMigration = !!existingRaw && (!prevMacNorm || prevMacNorm === '/yiyi-mac');
    getSettings();
    if (shouldPersistMigration) {
      saveSettings();
    }
    buildFloatingUi();
    registerEvents();
    injectAllVisibleFloorButtons();
    updateGalleryBadge();
    promoteHudAbovePopovers();
    setTimeout(promoteHudAbovePopovers, 800);
    resolveStudioUrl().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
