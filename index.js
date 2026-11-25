(() => {
  const EXT_KEY = 'yiyi_local_illust';
  const EXT_VERSION = '1.9.0';
  const EXT_FOLDER_NAME = 'yiyi-local-illust';
  const DEFAULT_MAC_HTTPS_URL = 'https://draw.fzy.asia/yiyi-mac';
  const DEFAULT_MAC_HTTP_URL = 'http://120.2.102.194:8093/yiyi-mac';
  const BUILTIN_MAC_URLS = new Set([
    '',
    '/yiyi-mac',
    DEFAULT_MAC_HTTPS_URL,
    DEFAULT_MAC_HTTP_URL,
  ]);

  const VALID_CLOUD_ENGINES = new Set([
    'noctq_v1',
    'anima_noct',
    'rouwei_vpred',
    'anima_artbook',
    'netayume',
    'janku_v777',
    'newbie',
  ]);

  const DEFAULTS = {
    enabled: false,
    backendPolicy: 'mac', // Always cloud gateway
    localUrl: '',
    remoteUrl: '',
    macUrl: DEFAULT_MAC_HTTPS_URL,
    token: '',
    engine: 'noctq_v1',
    ratingMode: 'unrestricted',
    promptMode: 'auto_or_tag',
    ratio: '1024x1536',
    faceDetailer: true,
    handDetailer: true,
    hiresFix: true,
    skipFirstMessage: true,
    silentOffline: true,
    autoWorldLore: true,
    memoryMode: 'smart', // 'smart' | 'story_only' | 'off'
    overlayMode: 'auto', // 'auto' | 'always' | 'floor_only'
    overlayPos: null,
    overlayPosDesktop: null,
    overlayPosMobile: null,
    stylePrefix: '',
    fabPos: null,
    fabPosDesktop: null,
    fabPosMobile: null,
  };

  let activeStudioUrl = null;
  let activeGatewayUrl = null;
  let activeCloudInfo = null;
  let activeEndpointMode = 'offline'; // 'cloud' | 'sleeping' | 'booting' | 'auth_error' | ... | 'offline'
  let activeBusy = false;
  let lastConnError = null;
  let activeProgressLabel = '';
  let overlayIndex = 0;
  let overlayCollapsed = false;
  let remoteLatestVersion = '';
  let updateAvailable = false;
  let updateCommitHint = '';
  let updateNotified = false;
  let detectedExtGlobal = null;
  let updateBusy = false;
  let layoutRafId = null;
  let responsiveListenersBound = false;
  let hudResizeObserver = null;
  const hudObservedEls = new WeakSet();
  let cssBustAttempted = false;
  let cssWatchBound = false;
  const pendingAutoIds = new Set();
  const runningFloorIds = new Set();

  function getCtx() {
    return window.SillyTavern?.getContext?.() || null;
  }

  function getSettings() {
    const ctx = getCtx();
    if (!ctx) return { ...DEFAULTS };
    if (!ctx.extensionSettings || typeof ctx.extensionSettings !== 'object') {
      ctx.extensionSettings = {};
    }
    const raw = ctx.extensionSettings[EXT_KEY] || {};
    const merged = Object.assign({}, DEFAULTS, raw);
    merged.backendPolicy = 'mac';
    const rawMac = typeof raw.macUrl === 'string' ? raw.macUrl.trim().replace(/\/+$/, '') : '';
    if (!rawMac || rawMac === '/yiyi-mac') {
      merged.macUrl = DEFAULT_MAC_HTTPS_URL;
    }
    if (!VALID_CLOUD_ENGINES.has(merged.engine)) {
      merged.engine = 'noctq_v1';
    }
    if (raw.handDetailer === undefined) {
      merged.handDetailer = true;
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
      .replace(/<(think[a-z0-9_-]*|thinking|thought|cot|reasoning|scratchpad|inner_monologue)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(style|script|head|svg|template|noscript|details|UpdateVariable|Variable|variables|statusbar|status|options|choices|mvu|JSONPatch|tableEdit)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
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
        const isBooting = !!(data.op_running || data.state === 'booting');
        return {
          ok: false,
          status: resp.status,
          reason: isBooting ? 'booting' : 'sleeping',
          url,
          data,
          detail: data.phase || (isBooting
            ? '云端 GPU 正在开机部署中（约 1~2 分钟），请稍候…'
            : '当前不可生图：云端 GPU 休眠中（每晚 18:00–01:00 自动开启）'),
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

  function compareSemver(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length, 3);
    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0;
      const vb = pb[i] || 0;
      if (va !== vb) return va > vb ? 1 : -1;
    }
    return 0;
  }

  function refreshUpdateUi() {
    const verEl = document.getElementById('yiyi-ver-text');
    const rowEl = document.getElementById('yiyi-update-row');
    const btnEl = document.getElementById('yiyi-btn-update');
    const fabEl = document.getElementById('yiyi-st-fab');
    const newerVer = !!(remoteLatestVersion && compareSemver(remoteLatestVersion, EXT_VERSION) > 0);
    const hasUpdate = !!(updateAvailable || newerVer);

    if (fabEl) {
      fabEl.classList.toggle('has-update', hasUpdate);
    }
    if (rowEl) {
      rowEl.classList.toggle('is-available', hasUpdate);
    }
    if (verEl) {
      if (hasUpdate) {
        verEl.textContent = newerVer
          ? `🆕 发现新版 v${remoteLatestVersion} (当前 v${EXT_VERSION})`
          : `🆕 发现 Git 更新${updateCommitHint ? ` (${updateCommitHint})` : ''} · 当前 v${EXT_VERSION}`;
      } else {
        verEl.textContent = `当前 v${EXT_VERSION}（已是最新）`;
      }
    }
    if (btnEl && !updateBusy) {
      btnEl.textContent = hasUpdate ? '⬇️ 立即一键更新' : '🔄 一键更新';
      btnEl.disabled = false;
    }
  }

  async function postStExtApi(endpoint, timeoutMs = 15000) {
    const ctx = getCtx();
    if (!ctx || typeof ctx.getRequestHeaders !== 'function') {
      return { ok: false, status: 0, text: 'missing_ctx' };
    }
    const headers = Object.assign({ 'Content-Type': 'application/json' }, ctx.getRequestHeaders() || {});
    const tryOrder = detectedExtGlobal === null ? [false, true] : [detectedExtGlobal];
    let lastResp = null;
    for (const isGlobal of tryOrder) {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const resp = await fetch(`/api/extensions/${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ extensionName: EXT_FOLDER_NAME, global: isGlobal }),
          signal: ctrl?.signal,
        });
        if (resp.ok) {
          detectedExtGlobal = isGlobal;
          const data = await resp.json().catch(() => ({}));
          return { ok: true, status: resp.status, data, isGlobal };
        }
        const text = await resp.text().catch(() => '');
        lastResp = { ok: false, status: resp.status, text, isGlobal };
        if (resp.status !== 404) {
          return lastResp;
        }
      } catch (err) {
        return {
          ok: false,
          status: 0,
          text: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network_error'),
        };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return lastResp || { ok: false, status: 404, text: 'not_found' };
  }

  async function checkExtensionUpdate({ silent = true } = {}) {
    const res = await postStExtApi('version', 12000);
    if (res.ok && res.data && typeof res.data === 'object') {
      if (res.data.isUpToDate === false) {
        updateAvailable = true;
        updateCommitHint = res.data.currentCommitHash ? String(res.data.currentCommitHash).slice(0, 7) : '';
      } else if (res.data.isUpToDate === true) {
        updateAvailable = false;
      }
    }
    refreshUpdateUi();
    const newerVer = !!(remoteLatestVersion && compareSemver(remoteLatestVersion, EXT_VERSION) > 0);
    const hasUpdate = !!(updateAvailable || newerVer);
    if (hasUpdate && (!silent || !updateNotified)) {
      updateNotified = true;
      const verSuffix = newerVer ? ` (v${remoteLatestVersion})` : '';
      toastInfo(`发现依依生图新版本${verSuffix}，点开右下角悬浮窗即可一键更新`, 'info');
    }
    return { hasUpdate, remoteLatestVersion, gitChecked: !!res.ok };
  }

  async function triggerExtensionUpdate() {
    if (updateBusy) return;
    updateBusy = true;
    const btnEl = document.getElementById('yiyi-btn-update');
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '⏳ 更新中…';
    }
    try {
      const res = await postStExtApi('update', 30000);
      if (res.ok) {
        const data = res.data || {};
        if (data.isUpToDate === false) {
          updateAvailable = false;
          toastInfo(`✅ 扩展已更新 (${data.shortCommitHash || '最新'})，正在自动刷新酒馆生效…`, 'success');
          setTimeout(() => window.location?.reload?.(), 1000);
          return { updated: true, reloaded: true };
        }
        if (remoteLatestVersion && compareSemver(remoteLatestVersion, EXT_VERSION) > 0) {
          updateAvailable = false;
          toastInfo(`✅ 本地扩展已是新版 (v${remoteLatestVersion})，正在自动刷新酒馆加载新版本…`, 'success');
          setTimeout(() => window.location?.reload?.(), 1000);
          return { updated: false, reloaded: true, upToDate: true };
        } else {
          updateAvailable = false;
          toastInfo(`✅ 当前已是最新版本 (v${EXT_VERSION})`, 'success');
        }
        return { updated: false, upToDate: true };
      }

      if (res.status === 403) {
        toastInfo('全局扩展需要管理员账号才能在网页更新，请改用管理员登录或到服务端拉取', 'warning');
      } else if (res.status === 404) {
        toastInfo('当前可能是压缩包/油猴手动安装，请从 SillyTavern 扩展管理用 Git 链接安装，或重新导入新版压缩包', 'warning');
      } else if (res.status === 500) {
        toastInfo('更新失败 (500)：酒馆后台 Git 拉取 GitHub 出错（请检查酒馆设备的 GitHub 网络、代理或 ~/.gitconfig 加速规则）', 'error');
      } else if (res.text === 'timeout') {
        toastInfo('拉取 GitHub 更新超时，请稍后重试或检查酒馆网络代理', 'error');
      } else {
        const msg = res.text && res.status ? `：${String(res.text).slice(0, 100)}` : '';
        toastInfo(`更新失败 (${res.status || res.text || '未知错误'})${msg}`, 'error');
      }
      return { updated: false, error: res.status || res.text };
    } finally {
      updateBusy = false;
      refreshUpdateUi();
    }
  }

  function _markEndpointOnline(mode, res) {
    activeStudioUrl = res.url;
    activeGatewayUrl = res.url;
    activeCloudInfo = res.data || null;
    activeEndpointMode = mode;
    activeBusy = !!res.data?.busy;
    lastConnError = null;
    if (res.data?.latest_ext_version) {
      remoteLatestVersion = String(res.data.latest_ext_version).trim();
    }
    updateConnectionUi();
    refreshUpdateUi();
    return res;
  }

  async function resolveStudioUrl() {
    const s = getSettings();
    let gwErr = null;
    const candidates = getMacProbeCandidates(s.macUrl);

    for (const cand of candidates) {
      const res = await pingEndpoint(cand.url, s.token, cand.timeout);
      if (res?.ok) return _markEndpointOnline('cloud', res);
      gwErr = res;
      if (res?.reason === 'auth_error' || res?.reason === 'sleeping' || res?.reason === 'booting') {
        break;
      }
    }

    const bestErr = gwErr || { ok: false, reason: 'network_error', url: '', detail: '暂未连上云端生图网关' };
    activeStudioUrl = null;
    if (bestErr.reason === 'sleeping' || bestErr.reason === 'booting') {
      activeGatewayUrl = bestErr.url || null;
      activeCloudInfo = bestErr.data || null;
      if (bestErr.data?.latest_ext_version) {
        remoteLatestVersion = String(bestErr.data.latest_ext_version).trim();
      }
    } else {
      activeGatewayUrl = null;
      activeCloudInfo = null;
    }
    lastConnError = bestErr;
    activeEndpointMode = bestErr.reason || 'offline';
    activeBusy = false;
    updateConnectionUi();
    refreshUpdateUi();
    return bestErr;
  }

  let wakePollTimer = null;

  async function wakeCloudFromPanel() {
    const s = getSettings();
    const gwUrl = activeGatewayUrl || normalizeStudioUrl(s.macUrl || DEFAULT_MAC_HTTPS_URL);
    if (!gwUrl) {
      toastInfo('请先在底部设置填写云端网关地址', 'warning');
      return;
    }
    const wakeBtn = document.getElementById('yiyi-btn-wake-cloud');
    if (wakeBtn) {
      wakeBtn.disabled = true;
      wakeBtn.textContent = '⏳ 正在发送开机指令…';
    }
    try {
      const resp = await fetch(`${gwUrl}/api/colab/start`, {
        method: 'POST',
        headers: buildHeaders(s),
        body: JSON.stringify({ gpu: 'auto', force: false }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(formatHttpErr(resp.status, '临时唤醒云端', body));
      }
      const data = await resp.json().catch(() => ({}));
      toastInfo(data.message || '⚡ 已开始唤醒云端 GPU，约 1~2 分钟后即可生图~', 'info');
      activeEndpointMode = 'booting';
      updateConnectionUi();
      if (wakePollTimer) clearInterval(wakePollTimer);
      let tries = 0;
      wakePollTimer = setInterval(async () => {
        tries += 1;
        const r = await resolveStudioUrl().catch(() => null);
        if (r?.ok) {
          clearInterval(wakePollTimer);
          wakePollTimer = null;
          toastInfo('🟢 云端 GPU 已就绪，现在可以开始生图啦！', 'success');
        } else if (tries >= 36) {
          clearInterval(wakePollTimer);
          wakePollTimer = null;
        }
      }, 5000);
    } catch (err) {
      toastInfo(err?.message || '唤醒云端失败', 'error');
      updateConnectionUi();
    }
  }

  function updateConnectionUi() {
    const s = getSettings();
    const fab = document.getElementById('yiyi-st-fab');
    const dot = fab?.querySelector('.yiyi-dot');
    const tag = fab?.querySelector('.yiyi-state-tag');
    const banner = document.getElementById('yiyi-can-draw-banner');
    const titleEl = document.getElementById('yiyi-can-draw-title');
    const subEl = document.getElementById('yiyi-can-draw-sub');
    const wakeBtn = document.getElementById('yiyi-btn-wake-cloud');
    const advDetails = document.getElementById('yiyi-adv-details');

    const info = activeCloudInfo || {};
    const schedule = info.schedule || '18:00–01:00 (北京时间)';
    const gpuName = String(info.gpu_name || info.gpu_tier || '').replace(/^cuda:\d+\s*/i, '').trim();
    const cuText = typeof info.cu_balance === 'number'
      ? ` · 余额 ${info.cu_balance.toFixed(0)} CU (月封顶 ${Math.round(info.monthly_cap || 2000)})`
      : '';

    if (fab) {
      fab.classList.toggle('is-on', !!s.enabled);
    }
    if (dot) {
      dot.className = 'yiyi-dot';
      if (activeBusy || activeEndpointMode === 'booting') dot.classList.add('busy');
      else if (activeStudioUrl) dot.classList.add('online');
    }
    if (tag) {
      if (activeProgressLabel) {
        tag.textContent = activeProgressLabel;
      } else if (activeEndpointMode === 'cloud') {
        tag.textContent = s.enabled ? '可生图·自动' : '可生图';
      } else if (activeEndpointMode === 'booting') {
        tag.textContent = '开机中…';
      } else if (activeEndpointMode === 'sleeping') {
        tag.textContent = '休眠中';
      } else {
        tag.textContent = s.enabled ? '自动:开' : '未连接';
      }
    }

    if (banner && titleEl && subEl) {
      banner.classList.remove('is-ready', 'is-booting', 'is-sleeping');
      if (activeEndpointMode === 'cloud') {
        banner.classList.add('is-ready');
        titleEl.textContent = activeBusy ? '🎨 当前可以生图（正在排队绘制中）' : '🟢 当前可以生图 · 云端顶配已就绪';
        subEl.textContent = `${gpuName ? `显卡：${gpuName}` : '云端 GPU 在线'}${cuText} · 每晚 ${schedule}`;
      } else if (activeEndpointMode === 'booting') {
        banner.classList.add('is-booting');
        titleEl.textContent = '⏳ 当前暂不可生图 · 云端开机部署中';
        subEl.textContent = `正在启动云端显卡与模型（约 1~2 分钟自动就绪），请稍候…`;
      } else if (activeEndpointMode === 'sleeping') {
        banner.classList.add('is-sleeping');
        titleEl.textContent = '🌙 当前不可生图 · 云端休眠省电中';
        subEl.textContent = `每晚 ${schedule} 自动开启${cuText}。白天急用可点下方「⚡ 临时唤醒云端」`;
      } else if (activeEndpointMode === 'auth_error') {
        titleEl.textContent = '🔒 需要输入访问密码';
        subEl.textContent = '请在下方「⚙️ 连接地址与密码设置」填写正确的访问密码';
        if (advDetails) advDetails.open = true;
      } else if (activeEndpointMode === 'mixed_content') {
        titleEl.textContent = '⚠️ HTTPS 页面禁止直连 HTTP';
        subEl.textContent = '请将地址改为 https://draw.fzy.asia/yiyi-mac';
      } else if (activeEndpointMode === 'timeout') {
        titleEl.textContent = '⏱️ 连接云端网关超时';
        subEl.textContent = '请检查网络后点「🔄 刷新状态」重试';
      } else {
        titleEl.textContent = '⚪ 暂未连上云端生图网关';
        subEl.textContent = lastConnError?.detail || '点「🔄 刷新状态」检查云端是否可以生图';
      }
    }

    if (wakeBtn) {
      if (activeEndpointMode === 'sleeping') {
        wakeBtn.style.display = '';
        wakeBtn.disabled = false;
        wakeBtn.textContent = '⚡ 临时唤醒云端';
      } else if (activeEndpointMode === 'booting') {
        wakeBtn.style.display = '';
        wakeBtn.disabled = true;
        wakeBtn.textContent = '⏳ 云端开机中…';
      } else {
        wakeBtn.style.display = 'none';
      }
    }
  }

  function toastInfo(msg, kind = 'info') {
    if (window.toastr && typeof window.toastr[kind] === 'function') {
      window.toastr[kind](msg, '依依云端生图');
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
      } catch {
        // showPopover() refused (unsupported / not connected / already in top layer elsewhere):
        // never leave a stranded [popover] attribute behind, or the UA rule
        // `[popover]:not(:popover-open) { display: none }` hides the HUD forever.
        try {
          if (!el.matches?.(':popover-open') && el.hasAttribute?.('popover')) {
            el.removeAttribute('popover');
          }
        } catch {}
      }
    }
  }

  function promoteHudAbovePopovers() {
    const foreignOpen = hasForeignPopoverOpen();
    const hudIds = ['yiyi-st-fab', 'yiyi-float-progress', 'yiyi-overlay-viewer', 'yiyi-st-panel', 'yiyi-lightbox'];
    for (const id of hudIds) {
      const el = document.getElementById(id);
      if (!el) continue;
      const visible = !el.classList?.contains('yiyi-hidden');
      if (!foreignOpen && (el.matches?.(':popover-open') || el.hasAttribute?.('popover'))) {
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
    layoutResponsiveHud();
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
      layoutResponsiveHud();
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
          if (conn?.reason === 'sleeping') {
            toastInfo('🌙 当前不可生图：云端休眠中（每晚 18:00–01:00 自动开启），点开悬浮窗可「⚡ 临时唤醒云端」', 'warning');
          } else if (conn?.reason === 'booting') {
            toastInfo('⏳ 云端 GPU 正在开机部署中，请稍等约 1 分钟即可生图', 'info');
          } else {
            const target = conn?.url ? ` [${conn.url}]` : '';
            toastInfo(
              `${conn?.detail || '暂未连上云端生图服务，请检查网络与服务状态'}${target}`,
              conn?.reason === 'auth_error' ? 'error' : 'warning',
            );
          }
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
      const [wStr, hStr] = (s.ratio || '1024x1536').split('x');
      const charName = mes.name || getActiveCharName();
      const lore = await collectWorldContext(ctx, idNum, mes, cleanedFloor, recentContext, s, mes.mes);

      const reqEngine = VALID_CLOUD_ENGINES.has(s.engine) ? s.engine : 'noctq_v1';

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
          engine: reqEngine,
          rating_mode: s.ratingMode || 'unrestricted',
          width: parseInt(wStr, 10) || 1024,
          height: parseInt(hStr, 10) || 1536,
          steps: 0,
          cfg: 0,
          face_detailer: s.faceDetailer !== false,
          hand_detailer: s.handDetailer !== false,
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
      const deadline = Date.now() + 720000;
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
        throw new Error('生成超时（超过 12 分钟未完成），请检查服务端状态或切到更快的引擎');
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
    btn.title = '依依云端生图：为这一层生成插画';
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

  function getViewportBox() {
    // documentElement.clientWidth/Height always report the layout viewport (excluding desktop
    // scrollbars) even when SillyTavern's mobile CSS collapses <html> to height 0.
    const de = document.documentElement;
    const deW = Number(de?.clientWidth);
    const deH = Number(de?.clientHeight);
    const rawW = (Number.isFinite(deW) && deW > 0) ? deW : (window.innerWidth || 1280);
    const rawH = (Number.isFinite(deH) && deH > 0) ? deH : (window.innerHeight || 800);
    const lw = Math.max(240, rawW);
    const lh = Math.max(320, rawH);
    const vv = window.visualViewport;
    if (vv && Number(vv.width) > 120 && Number(vv.height) > 120) {
      const width = Math.min(lw, Number(vv.width) || lw);
      const height = Math.min(lh, Number(vv.height) || lh);
      const left = Math.max(0, Math.min(lw - width, Number(vv.offsetLeft) || 0));
      const top = Math.max(0, Math.min(lh - height, Number(vv.offsetTop) || 0));
      return { layoutW: lw, layoutH: lh, left, top, width, height, scale: Number(vv.scale) || 1 };
    }
    return { layoutW: lw, layoutH: lh, left: 0, top: 0, width: lw, height: lh, scale: 1 };
  }

  function getSheldBounds(vp) {
    const sheldEl = document.getElementById?.('sheld');
    const topBarEl = document.getElementById?.('top-bar') || document.getElementById?.('top-settings-holder');
    const sendFormEl = document.getElementById?.('send_form') || document.getElementById?.('form_sheld');
    const sr = sheldEl?.getBoundingClientRect?.();
    const tr = topBarEl?.getBoundingClientRect?.();
    const fr = sendFormEl?.getBoundingClientRect?.();
    const sheldValid = sr && sr.width >= 200 && sr.height >= 120;
    const rawTopBar = tr && tr.height >= 24 && tr.height <= 120 ? Math.round(tr.bottom - vp.top) : 44;
    const rawSendForm = fr && fr.height >= 28 && fr.height <= 180 ? Math.round(fr.height) : 56;
    return {
      sheld: sheldValid ? sr : null,
      topBarH: Math.max(0, Math.min(120, rawTopBar)),
      sendFormH: Math.max(36, Math.min(160, rawSendForm)),
    };
  }

  function measureElSize(el, fallbackW, fallbackH) {
    if (!el || el.classList?.contains?.('yiyi-hidden')) {
      return { w: fallbackW, h: fallbackH };
    }
    // FOUC guard: ST loads index.js and style.css in parallel. Until our stylesheet applies,
    // the HUD is an unstyled full-width block — measuring it would misplace everything.
    try {
      if (typeof window.getComputedStyle === 'function') {
        const cs = window.getComputedStyle(el);
        if (cs && cs.position !== 'fixed') {
          return { w: fallbackW, h: fallbackH };
        }
      }
    } catch {}
    const r = el.getBoundingClientRect?.();
    const w = (r && r.width > 20) ? r.width : (el.offsetWidth > 20 ? el.offsetWidth : fallbackW);
    const h = (r && r.height > 20) ? r.height : (el.offsetHeight > 20 ? el.offsetHeight : fallbackH);
    return { w, h };
  }

  // NOTE (v1.7.1): SillyTavern sets `html { transform: translateZ(0) }`, which makes <html> the
  // containing block of every position:fixed element. On <=1000px ST also sets
  // `body { position: fixed }`, collapsing <html> to height 0, so any `bottom:`-anchored box flies
  // to negative Y (off-screen). We therefore ALWAYS write left/top and never bottom/right.
  // `anchorY` is kept only for API compatibility (callers still persist logical bottom offsets).
  function placeFixedBox(el, left, top, w, h, anchorY, vp, minTopOverride = null) {
    if (!el) return null;
    const visRight = vp.left + vp.width;
    const visBottom = vp.top + vp.height;
    const padX = vp.width <= 768 ? 8 : 10;
    const padY = 8;
    const minTop = minTopOverride !== null ? Math.max(vp.top + padY, minTopOverride) : (vp.top + padY);
    const maxLeft = Math.max(vp.left + padX, visRight - w - padX);
    const maxTop = Math.max(minTop, visBottom - h - padY);
    const clampedLeft = Math.max(vp.left + padX, Math.min(maxLeft, left));
    const clampedTop = Math.max(minTop, Math.min(maxTop, top));
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.left = `${Math.round(clampedLeft)}px`;
    el.style.top = `${Math.round(clampedTop)}px`;
    return { left: clampedLeft, top: clampedTop, right: clampedLeft + w, bottom: clampedTop + h, w, h };
  }

  function layoutResponsiveHud() {
    const fab = document.getElementById('yiyi-st-fab');
    const panel = document.getElementById('yiyi-st-panel');
    const floatProg = document.getElementById('yiyi-float-progress');
    const viewer = document.getElementById('yiyi-overlay-viewer');
    const lightbox = document.getElementById('yiyi-lightbox');
    if (!fab && !panel && !viewer && !floatProg) return;
    ensureHudObservers();

    const vp = getViewportBox();
    const isMobile = vp.width <= 768;
    const isNarrow = vp.width <= 460;
    const visRight = vp.left + vp.width;
    const visBottom = vp.top + vp.height;
    const { sheld, topBarH, sendFormH } = getSheldBounds(vp);
    const minHudTop = vp.top + Math.min(topBarH + 6, Math.max(8, vp.height * 0.2));
    const s = getSettings();

    for (const el of [fab, panel, floatProg, viewer, lightbox]) {
      if (!el?.classList) continue;
      el.classList.toggle('yiyi-mobile', isMobile);
      el.classList.toggle('yiyi-mobile-narrow', isNarrow);
    }

    let fabBox = { left: visRight - 168 - 14, top: visBottom - 76 - 38, right: visRight - 14, bottom: visBottom - 76, w: 168, h: 38 };
    if (fab) {
      const fabSize = measureElSize(fab, isNarrow ? 112 : 168, 38);
      const savedFab = isMobile ? s.fabPosMobile : s.fabPosDesktop;
      let fabLeft;
      let fabTop;
      if (savedFab && typeof savedFab.right === 'number' && typeof savedFab.bottom === 'number') {
        fabLeft = visRight - savedFab.right - fabSize.w;
        fabTop = visBottom - savedFab.bottom - fabSize.h;
      } else if (isMobile) {
        fabLeft = visRight - fabSize.w - 10;
        fabTop = visBottom - Math.max(72, sendFormH + 14) - fabSize.h;
      } else {
        const rightGutter = sheld ? (visRight - sheld.right) : 0;
        if (sheld && rightGutter >= fabSize.w + 24) {
          fabLeft = sheld.right + 14;
          fabTop = visBottom - 76 - fabSize.h;
        } else {
          // No room beside #sheld (769–1000px tablets, ST mobile layout, chat_width 100):
          // the FAB floats over the chat column, so keep it clear of #send_form.
          fabLeft = visRight - fabSize.w - 14;
          fabTop = visBottom - Math.max(72, sendFormH + 14) - fabSize.h;
        }
      }
      fabBox = placeFixedBox(fab, fabLeft, fabTop, fabSize.w, fabSize.h, 'bottom', vp, minHudTop) || fabBox;
    }

    if (viewer) {
      const targetOvW = isMobile ? Math.max(240, Math.min(360, Math.round(vp.width - 16))) : 310;
      viewer.style.width = isMobile ? `${targetOvW}px` : '';
      const ovSize = measureElSize(viewer, targetOvW, overlayCollapsed ? 44 : (isMobile ? 320 : 360));
      const vW = isMobile ? targetOvW : ovSize.w;
      const vH = ovSize.h;
      const savedOv = isMobile ? s.overlayPosMobile : s.overlayPosDesktop;
      let ovLeft;
      let ovTop;
      if (savedOv && typeof savedOv.right === 'number' && typeof savedOv.top === 'number') {
        ovLeft = visRight - savedOv.right - vW;
        ovTop = vp.top + savedOv.top;
      } else if (isMobile) {
        ovLeft = vp.left + Math.round((vp.width - vW) / 2);
        ovTop = minHudTop;
      } else {
        const rightGutter = sheld ? (visRight - sheld.right) : 0;
        if (sheld && rightGutter >= vW + 24) {
          ovLeft = sheld.right + 14;
        } else {
          ovLeft = visRight - vW - 14;
        }
        ovTop = Math.max(vp.top + 64, minHudTop);
      }
      placeFixedBox(viewer, ovLeft, ovTop, vW, vH, 'top', vp, minHudTop);
    }

    if (panel) {
      if (isMobile) {
        const panelW = Math.max(240, Math.min(440, Math.round(vp.width - 16)));
        const panelMaxH = Math.max(260, Math.round(vp.height - (minHudTop - vp.top) - 14));
        panel.style.width = `${panelW}px`;
        panel.style.maxHeight = `${panelMaxH}px`;
        const pH = Math.min(panelMaxH, measureElSize(panel, panelW, Math.min(480, panelMaxH)).h);
        const pLeft = vp.left + Math.round((vp.width - panelW) / 2);
        const pTop = visBottom - 10 - pH;
        placeFixedBox(panel, pLeft, pTop, panelW, pH, 'bottom', vp, minHudTop);
      } else {
        const panelMaxH = Math.max(300, Math.round(vp.height - (minHudTop - vp.top) - 20));
        panel.style.width = '';
        panel.style.maxHeight = `${panelMaxH}px`;
        const pSize = measureElSize(panel, 326, Math.min(540, panelMaxH));
        const pH = Math.min(panelMaxH, pSize.h);
        const pLeft = fabBox.left;
        const openBelow = fabBox.top < vp.top + vp.height * 0.45 && (visBottom - fabBox.bottom - 12 >= Math.min(pH, 320));
        const pTop = openBelow ? (fabBox.bottom + 10) : (fabBox.top - pH - 10);
        placeFixedBox(panel, pLeft, pTop, pSize.w, pH, 'bottom', vp, minHudTop);
      }
    }

    if (floatProg) {
      if (isMobile) {
        const progW = Math.max(200, Math.min(320, Math.round(vp.width - 24)));
        floatProg.style.width = `${progW}px`;
        const progH = measureElSize(floatProg, progW, 44).h;
        const progLeft = vp.left + Math.round((vp.width - progW) / 2);
        const progTop = Math.min(fabBox.top - progH - 10, visBottom - sendFormH - 64 - progH);
        placeFixedBox(floatProg, progLeft, progTop, progW, progH, 'bottom', vp, minHudTop);
      } else {
        floatProg.style.width = '';
        const progSize = measureElSize(floatProg, 248, 44);
        const progLeft = fabBox.left;
        const progTop = fabBox.top - progSize.h - 10;
        placeFixedBox(floatProg, progLeft, progTop, progSize.w, progSize.h, 'bottom', vp, minHudTop);
      }
    }
  }

  function scheduleResponsiveLayout() {
    if (layoutRafId !== null) return;
    const run = () => {
      layoutRafId = null;
      layoutResponsiveHud();
    };
    if (typeof window.requestAnimationFrame === 'function') {
      layoutRafId = window.requestAnimationFrame(run);
    } else {
      layoutRafId = setTimeout(run, 16);
    }
  }

  function ensureHudObservers() {
    if (typeof ResizeObserver !== 'function') return;
    try {
      if (!hudResizeObserver) hudResizeObserver = new ResizeObserver(() => scheduleResponsiveLayout());
      // #sheld may not be mounted yet on the first pass, and HUD boxes change size when CSS
      // arrives late or their text (state tag / progress) changes — keep observing all of them.
      const ids = ['sheld', 'yiyi-st-fab', 'yiyi-st-panel', 'yiyi-float-progress', 'yiyi-overlay-viewer'];
      for (const id of ids) {
        const node = document.getElementById?.(id);
        if (node && !hudObservedEls.has(node)) {
          hudObservedEls.add(node);
          hudResizeObserver.observe(node);
        }
      }
    } catch {}
  }

  function bindResponsiveListeners() {
    ensureHudObservers();
    if (responsiveListenersBound) return;
    responsiveListenersBound = true;
    try {
      window.addEventListener?.('resize', scheduleResponsiveLayout);
      window.addEventListener?.('orientationchange', () => setTimeout(layoutResponsiveHud, 120));
      window.addEventListener?.('load', () => {
        ensureFreshCss();
        scheduleResponsiveLayout();
      });
      window.visualViewport?.addEventListener?.('resize', scheduleResponsiveLayout);
      window.visualViewport?.addEventListener?.('scroll', scheduleResponsiveLayout);
    } catch {}
  }

  function getCssLinkEl() {
    try {
      return document.getElementById?.('third-party_yiyi-local-illust-css')
        || document.querySelector?.(`link[rel="stylesheet"][href*="/${EXT_FOLDER_NAME}/style.css"]`)
        || null;
    } catch {
      return null;
    }
  }

  function readCssVersion() {
    try {
      if (typeof window.getComputedStyle !== 'function' || !document.documentElement) return null;
      const cs = window.getComputedStyle(document.documentElement);
      if (!cs || typeof cs.getPropertyValue !== 'function') return null;
      return String(cs.getPropertyValue('--yiyi-css-ver') || '').trim().replace(/^["']|["']$/g, '').trim();
    } catch {
      return null;
    }
  }

  function bustStaleCss(link) {
    if (cssBustAttempted || !link) return false;
    cssBustAttempted = true;
    try {
      const rawHref = String(link.getAttribute?.('href') || link.href || '');
      if (!rawHref) return false;
      const base = rawHref.replace(/[?#].*$/, '');
      const fresh = document.createElement('link');
      fresh.rel = 'stylesheet';
      fresh.type = 'text/css';
      fresh.href = `${base}?v=${encodeURIComponent(EXT_VERSION)}`;
      fresh.addEventListener?.('load', () => {
        // Swap in place so ST can still find/remove us by the original id.
        const oldId = link.id;
        try {
          if (typeof link.remove === 'function') link.remove();
          else link.parentNode?.removeChild?.(link);
        } catch {}
        if (oldId) fresh.id = oldId;
        scheduleResponsiveLayout();
        setTimeout(layoutResponsiveHud, 60);
      });
      fresh.addEventListener?.('error', () => {
        try {
          if (typeof fresh.remove === 'function') fresh.remove();
          else fresh.parentNode?.removeChild?.(fresh);
        } catch {}
      });
      if (link.parentNode?.insertBefore) {
        link.parentNode.insertBefore(fresh, link.nextSibling || null);
      } else {
        (document.head || document.body)?.appendChild?.(fresh);
      }
      console.info?.(`[yiyi-local-illust] stale style.css detected (want ${EXT_VERSION}), reloading ${fresh.href}`);
      return true;
    } catch {
      return false;
    }
  }

  // Cloudflare/browser caches may serve an old style.css next to a fresh index.js (no ?v= from ST).
  // style.css carries `:root { --yiyi-css-ver }`; if it doesn't match EXT_VERSION, reload it once.
  function ensureFreshCss(opts = {}) {
    const ver = readCssVersion();
    if (ver === null) return false; // no getComputedStyle — nothing we can verify
    if (ver === EXT_VERSION) return true;
    const link = getCssLinkEl();
    if (!link) return false; // userscript build (inline <style>) or ST hasn't injected it yet
    let loaded = false;
    try {
      loaded = !!link.sheet;
    } catch {
      loaded = true;
    }
    if (!loaded && !opts.final) {
      if (!cssWatchBound) {
        cssWatchBound = true;
        link.addEventListener?.('load', () => {
          scheduleResponsiveLayout();
          ensureFreshCss();
        });
        link.addEventListener?.('error', () => ensureFreshCss({ final: true }));
        setTimeout(() => ensureFreshCss({ final: true }), 4000);
      }
      return false;
    }
    return bustStaleCss(link);
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
    let origLeft = 0;
    let origTop = 0;
    let dragW = minW;
    let dragH = minH;
    let lastPlaced = null;
    let activePointerId = null;

    const releaseCapture = (pointerId) => {
      try {
        if (pointerId !== null && pointerId !== undefined) handleEl.releasePointerCapture?.(pointerId);
      } catch {}
    };

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.isPrimary === false) return;
      if (opts.ignoreSelector && e.target?.closest?.(opts.ignoreSelector)) return;
      dragging = true;
      moved = false;
      lastPlaced = null;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const vp = getViewportBox();
      const rect = targetEl.getBoundingClientRect?.();
      dragW = (rect && rect.width > 20) ? rect.width : minW;
      dragH = (rect && rect.height > 20) ? rect.height : minH;
      const parsedLeft = parseFloat(targetEl.style.left);
      const parsedTop = parseFloat(targetEl.style.top);
      origLeft = Number.isFinite(parsedLeft)
        ? parsedLeft
        : (rect ? rect.left : (vp.left + vp.width - dragW - 14));
      origTop = Number.isFinite(parsedTop)
        ? parsedTop
        : (rect ? rect.top : (anchorY === 'top' ? (vp.top + 64) : (vp.top + vp.height - dragH - 76)));
      try {
        handleEl.setPointerCapture?.(e.pointerId);
      } catch {}
    });
    handleEl.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (!moved) return;
      const vp = getViewportBox();
      lastPlaced = placeFixedBox(targetEl, origLeft + dx, origTop + dy, dragW, dragH, anchorY, vp);
    });
    handleEl.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      releaseCapture(e.pointerId ?? activePointerId);
      activePointerId = null;
      if (moved) {
        const vp = getViewportBox();
        const placed = lastPlaced || { left: origLeft, top: origTop, w: dragW, h: dragH };
        const rightOff = Math.max(6, Math.round((vp.left + vp.width) - (placed.left + placed.w)));
        const yOff = anchorY === 'top'
          ? Math.max(6, Math.round(placed.top - vp.top))
          : Math.max(6, Math.round((vp.top + vp.height) - (placed.top + placed.h)));
        opts.onSavePos?.({
          right: rightOff,
          [anchorY]: yOff,
          isMobile: vp.width <= 768,
        });
        layoutResponsiveHud();
      } else {
        opts.onClick?.(e);
      }
    });
    handleEl.addEventListener('pointercancel', (e) => {
      if (!dragging) return;
      const wasMoved = moved;
      dragging = false;
      moved = false;
      lastPlaced = null;
      releaseCapture(e?.pointerId ?? activePointerId);
      activePointerId = null;
      // Gesture interrupted by the browser: snap back to the saved/responsive position.
      if (wasMoved) layoutResponsiveHud();
    });
  }

  function buildFloatingUi() {
    if (document.getElementById('yiyi-st-fab')) return;
    const s = getSettings();

    const fab = document.createElement('div');
    fab.id = 'yiyi-st-fab';
    fab.innerHTML = `<span class="yiyi-dot"></span><span>🎨</span><span class="yiyi-state-tag">自动:关</span><button type="button" class="yiyi-fab-mini" id="yiyi-fab-draw" title="立即为最新楼层生图">🖌️</button><button type="button" class="yiyi-fab-mini" id="yiyi-fab-gallery" title="打开/收起悬浮画框（同层卡专用）">🖼️<span class="yiyi-fab-badge" id="yiyi-fab-badge" style="display:none">0</span></button>`;

    const panel = document.createElement('div');
    panel.id = 'yiyi-st-panel';
    panel.className = 'yiyi-hidden';
    panel.innerHTML = `
      <div class="yiyi-panel-head">
        <div class="yiyi-panel-title"><span>🎨</span> 依依云端无限制生图</div>
        <div class="yiyi-panel-head-actions">
          <button type="button" class="yiyi-close-btn" id="yiyi-panel-reset-pos" title="重置悬浮球与画框到默认响应式位置">⟲</button>
          <button type="button" class="yiyi-close-btn" id="yiyi-panel-close" title="收起">✕</button>
        </div>
      </div>
      <div class="yiyi-panel-body">
        <div class="yiyi-can-draw-banner" id="yiyi-can-draw-banner">
          <div id="yiyi-can-draw-title" style="font-weight:700">正在检查当前是否可以生图…</div>
          <div id="yiyi-can-draw-sub" style="font-size:11px;opacity:.88">每晚 18:00–01:00 (北京时间) 自动开启云端显卡</div>
          <div class="yiyi-cloud-actions">
            <button type="button" class="yiyi-btn" id="yiyi-btn-wake-cloud" style="display:none">⚡ 临时唤醒云端</button>
            <button type="button" class="yiyi-btn" id="yiyi-btn-test">🔄 刷新状态</button>
            <button type="button" class="yiyi-btn" id="yiyi-btn-open-studio">🎨 独立远程生图页</button>
          </div>
        </div>

        <label class="yiyi-switch-row">
          <strong>楼层生成自动插画</strong>
          <input type="checkbox" id="yiyi-opt-enabled" />
        </label>

        <div class="yiyi-update-row" id="yiyi-update-row">
          <span id="yiyi-ver-text">当前 v${EXT_VERSION}</span>
          <button type="button" class="yiyi-btn" id="yiyi-btn-update">🔄 一键更新</button>
        </div>

        <button class="yiyi-btn yiyi-btn-primary" id="yiyi-btn-draw-last">🖌️ 为最新楼层立即画一张</button>
        <button class="yiyi-btn" id="yiyi-btn-gallery">🖼️ 打开本局插画画廊（同层卡专用）</button>

        <div class="yiyi-grid-2">
          <div class="yiyi-field">
            <label>云端旗舰工作流</label>
            <select id="yiyi-opt-engine">
              <option value="noctq_v1">👑 Noct-Q-Anime V1 (10/10 全能王者 · 首选)</option>
              <option value="anima_noct">🌙 Anima-Noct V2 (9.9/10 多人零串色 · 夜景剧场)</option>
              <option value="rouwei_vpred">🖌️ RouWei v0.8 V-Pred (9.9/10 厚涂光影封神)</option>
              <option value="anima_artbook">🎨 Anima v1.1 Artbook (9.8/10 画集柔光)</option>
              <option value="netayume">💎 NetaYume-Lumina v4 (9.7/10 极净锐利)</option>
              <option value="janku_v777">⚡ JANKU v7.77 (9.6/10 极速二次元 SDXL)</option>
              <option value="newbie">✨ NewBie-Exp0.1 XML (9.6/10 XML角色锁定)</option>
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
              <option value="auto_local">强制 AI 提炼画面</option>
              <option value="tag_only">仅识别楼层 [IMG:...] 标签</option>
            </select>
          </div>
          <div class="yiyi-field">
            <label>默认画幅</label>
            <select id="yiyi-opt-ratio">
              <option value="1024x1536">竖图 1024×1536 (剧场高清)</option>
              <option value="1344x896">横图 1344×896 (宽屏 CG)</option>
              <option value="1280x1280">方图 1280×1280 (高清方图)</option>
              <option value="832x1216">竖图 832×1216 (SDXL 标准)</option>
              <option value="1216x832">横图 1216×832 (SDXL 宽屏)</option>
            </select>
          </div>
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
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-face-detailer" /> ✨ 自动修脸 + 眼神精绘（SAM + Anzhc 瞳孔高光）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-hand-detailer" /> 🖐️ 自动修手增强（手部精修，特写更稳）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-hires" /> 💎 IllustrationJaNai 高清重绘（SDXL / Anima 细节拉满）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-skip-first" /> 跳过开场白（第0层不自动画）</label>
        <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-silent" /> 休眠时段静默不弹窗</label>

        <details class="yiyi-adv-details" id="yiyi-adv-details">
          <summary>⚙️ 连接地址与访问密码设置</summary>
          <div style="display:flex;flex-direction:column;gap:7px">
            <div class="yiyi-field">
              <label>云端网关地址（默认已内置，一般无需修改）</label>
              <input type="text" id="yiyi-opt-mac-url" placeholder="https://draw.fzy.asia/yiyi-mac" />
            </div>
            <div class="yiyi-field">
              <label>访问密码（与独立生图页一致）</label>
              <input type="password" id="yiyi-opt-token" placeholder="请输入配置密码" />
            </div>
          </div>
        </details>
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
      minH: 38,
      ignoreSelector: '.yiyi-fab-mini',
      onSavePos: (pos) => {
        const st = getSettings();
        const saved = { right: pos.right, bottom: pos.bottom };
        if (pos.isMobile) st.fabPosMobile = saved;
        else st.fabPosDesktop = saved;
        saveSettings();
      },
      onClick: () => {
        panel.classList.toggle('yiyi-hidden');
        if (!panel.classList.contains('yiyi-hidden')) {
          syncPanelFromSettings();
          syncTopLayer(panel, true, true);
          layoutResponsiveHud();
          resolveStudioUrl();
        } else {
          syncTopLayer(panel, false);
        }
      },
    });

    attachFixedDrag(document.getElementById('yiyi-ov-head'), viewer, {
      anchorY: 'top',
      minW: 200,
      minH: 44,
      ignoreSelector: '.yiyi-ov-actions, button',
      onSavePos: (pos) => {
        const st = getSettings();
        const saved = { right: pos.right, top: pos.top };
        if (pos.isMobile) st.overlayPosMobile = saved;
        else st.overlayPosDesktop = saved;
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
    const resetPosBtn = document.getElementById('yiyi-panel-reset-pos');
    if (resetPosBtn) {
      resetPosBtn.onclick = () => {
        const st = getSettings();
        st.fabPos = null;
        st.fabPosDesktop = null;
        st.fabPosMobile = null;
        st.overlayPos = null;
        st.overlayPosDesktop = null;
        st.overlayPosMobile = null;
        saveSettings();
        layoutResponsiveHud();
        toastInfo('已复位悬浮球与画框到默认响应式位置', 'info');
      };
    }
    const wakeBtn = document.getElementById('yiyi-btn-wake-cloud');
    if (wakeBtn) {
      wakeBtn.onclick = () => { wakeCloudFromPanel().catch(() => {}); };
    }
    const openStudioBtn = document.getElementById('yiyi-btn-open-studio');
    if (openStudioBtn) {
      openStudioBtn.onclick = () => {
        const st = getSettings();
        const url = `${(activeGatewayUrl || normalizeStudioUrl(st.macUrl || DEFAULT_MAC_HTTPS_URL) || DEFAULT_MAC_HTTPS_URL).replace(/\/+$/, '')}/`;
        window.open(url, '_blank', 'noopener,noreferrer');
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
        readInput('yiyi-opt-mac-url', 'macUrl');
        readInput('yiyi-opt-token', 'token');
        saveSettings();

        const res = await resolveStudioUrl();
        if (res?.ok) {
          const gpu = String(res.data?.gpu_name || res.data?.gpu_tier || '云端显卡').replace(/^cuda:\d+\s*/i, '').trim();
          toastInfo(`🟢 当前可以生图！（${gpu} 已就绪）`, 'success');
        } else if (res?.reason === 'sleeping') {
          toastInfo('🌙 当前不可生图：云端休眠中（每晚 18:00–01:00 自动开启），点「⚡ 临时唤醒云端」可随时开机', 'info');
        } else if (res?.reason === 'booting') {
          toastInfo('⏳ 云端正在开机部署中，请稍候 1~2 分钟', 'info');
        } else {
          const target = res?.url ? ` [${res.url}]` : '';
          toastInfo(
            `${res?.detail || '暂未连上云端生图服务，请检查网络与服务状态'}${target}`,
            res?.reason === 'auth_error' ? 'error' : 'warning',
          );
        }
      };
    }

    const drawLastBtn = document.getElementById('yiyi-btn-draw-last');
    if (drawLastBtn) drawLastBtn.onclick = drawLatestFloor;
    const panelGalleryBtn = document.getElementById('yiyi-btn-gallery');
    if (panelGalleryBtn) panelGalleryBtn.onclick = () => showOverlayViewer();
    const updateBtn = document.getElementById('yiyi-btn-update');
    if (updateBtn) updateBtn.onclick = () => { triggerExtensionUpdate().catch(() => {}); };

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
        layoutResponsiveHud();
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
    bindVal('yiyi-opt-engine', 'engine');
    bindVal('yiyi-opt-rating', 'ratingMode');
    bindVal('yiyi-opt-prompt-mode', 'promptMode');
    bindVal('yiyi-opt-ratio', 'ratio');
    bindVal('yiyi-opt-style', 'stylePrefix');
    bindVal('yiyi-opt-memory-mode', 'memoryMode');
    bindVal('yiyi-opt-overlay-mode', 'overlayMode');
    bindVal('yiyi-opt-face-detailer', 'faceDetailer', true);
    bindVal('yiyi-opt-hand-detailer', 'handDetailer', true);
    bindVal('yiyi-opt-hires', 'hiresFix', true);
    bindVal('yiyi-opt-skip-first', 'skipFirstMessage', true);
    bindVal('yiyi-opt-silent', 'silentOffline', true);
    bindVal('yiyi-opt-mac-url', 'macUrl', false, true);
    bindVal('yiyi-opt-token', 'token', false, true);

    syncPanelFromSettings();
    updateGalleryBadge();
    refreshUpdateUi();
    layoutResponsiveHud();
    bindResponsiveListeners();
    ensureFreshCss();
    setTimeout(layoutResponsiveHud, 120);
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
    setVal('yiyi-opt-engine', VALID_CLOUD_ENGINES.has(s.engine) ? s.engine : 'noctq_v1');
    setVal('yiyi-opt-rating', s.ratingMode);
    setVal('yiyi-opt-prompt-mode', s.promptMode);
    setVal('yiyi-opt-ratio', s.ratio);
    setVal('yiyi-opt-style', s.stylePrefix);
    setVal('yiyi-opt-memory-mode', s.memoryMode || (s.autoWorldLore === false ? 'off' : 'smart'));
    setVal('yiyi-opt-overlay-mode', s.overlayMode || 'auto');
    setVal('yiyi-opt-face-detailer', s.faceDetailer !== false, true);
    setVal('yiyi-opt-hand-detailer', s.handDetailer !== false, true);
    setVal('yiyi-opt-hires', s.hiresFix, true);
    setVal('yiyi-opt-skip-first', s.skipFirstMessage, true);
    setVal('yiyi-opt-silent', s.silentOffline, true);
    setVal('yiyi-opt-mac-url', s.macUrl || DEFAULT_MAC_HTTPS_URL);
    setVal('yiyi-opt-token', s.token);
    updateConnectionUi();
  }

  function registerEvents() {
    const ctx = getCtx();
    if (!ctx?.eventSource || !ctx?.eventTypes) return;
    const { eventSource, eventTypes } = ctx;

    if (eventTypes.APP_READY) {
      eventSource.on(eventTypes.APP_READY, () => {
        ensureFreshCss();
        promoteHudAbovePopovers();
        scheduleResponsiveLayout();
      });
    }

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
        layoutResponsiveHud();
      }, 250);
    });
  }

  function init() {
    const ctx = getCtx();
    if (!ctx) {
      setTimeout(init, 600);
      return;
    }
    if (!document.body) {
      setTimeout(init, 400);
      return;
    }
    const existingRaw = ctx.extensionSettings?.[EXT_KEY];
    const prevMacNorm = typeof existingRaw?.macUrl === 'string'
      ? existingRaw.macUrl.trim().replace(/\/+$/, '')
      : '';
    const shouldPersistMigration = !!existingRaw && (
      !prevMacNorm ||
      prevMacNorm === '/yiyi-mac' ||
      existingRaw.backendPolicy !== 'mac' ||
      !VALID_CLOUD_ENGINES.has(existingRaw.engine)
    );
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
    setTimeout(() => checkExtensionUpdate({ silent: true }).catch(() => {}), 2000);
    resolveStudioUrl().catch(() => {});
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
