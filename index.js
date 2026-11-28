(() => {
  const EXT_KEY = 'yiyi_local_illust';
  const EXT_VERSION = '2.3.0';
  const EXT_FOLDER_NAME = 'yiyi-local-illust';
  const DEFAULT_MAC_HTTPS_URL = 'https://draw.fzy.asia/yiyi-mac';
  const DEFAULT_MAC_HTTP_URL = 'http://120.2.102.194:8093/yiyi-mac';
  const BUILTIN_MAC_URLS = new Set([
    '',
    '/yiyi-mac',
    DEFAULT_MAC_HTTPS_URL,
    DEFAULT_MAC_HTTP_URL,
  ]);

  const DEFAULT_CLOUD_ENGINES = [
    {
      id: 'moss_quality',
      label: '🎨 画质拉满',
      short: '画质拉满',
      sub: 'BF16 旗舰 · ~80–100s',
      desc: 'MOSS-Image BF16 无审查旗舰（28步，画质与细节拉满，约 80–100s）',
      isDefault: true,
    },
    {
      id: 'moss_fast',
      label: '⚡ 快速出图',
      short: '快速出图',
      sub: '12步极速 · ~18–26s',
      desc: 'MOSS-Image 12 步极速无审查（高频跑团首选，约 18–26s）',
      isDefault: false,
    },
  ];

  const ENGINE_FRIENDLY_META = {
    moss_quality: {
      label: '🎨 画质拉满',
      short: '画质拉满',
      sub: 'BF16 旗舰 · ~80–100s',
      desc: 'MOSS-Image BF16 无审查旗舰（28步，画质与细节拉满，约 80–100s）',
    },
    moss_fast: {
      label: '⚡ 快速出图',
      short: '快速出图',
      sub: '12步极速 · ~18–26s',
      desc: 'MOSS-Image 12 步极速无审查（高频跑团首选，约 18–26s）',
    },
  };

  // Silent migration sets for historical persisted settings (never exposed in UI)
  const LEGACY_FAST_ENGINES = new Set(['moss_turbo']);
  const LEGACY_QUALITY_ENGINES = new Set([
    'moss_anime',
    'moss_drama',
    'moss_image',
    'moss_image_sft',
    'moss_image_base',
    'qwen_omni',
    'noctq_v1',
    'anima_noct',
    'rouwei_vpred',
    'anima_artbook',
    'netayume',
    'janku_v777',
    'newbie',
    'anima',
    'illustrious',
  ]);

  let runtimeCloudEngines = DEFAULT_CLOUD_ENGINES.map((e) => ({ ...e }));
  let enginesSyncedFromServer = false;
  const VALID_CLOUD_ENGINES = new Set(runtimeCloudEngines.map((e) => e.id));

  const DEFAULTS = {
    enabled: false,
    backendPolicy: 'mac', // Always cloud gateway
    localUrl: '',
    remoteUrl: '',
    macUrl: DEFAULT_MAC_HTTPS_URL,
    token: '',
    engine: 'moss_quality',
    engineUserChosen: false,
    hiresRefine: false,
    nsfwBoost: false,
    ratingMode: 'unrestricted',
    promptMode: 'auto_or_tag',
    ratio: '1024x1536',
    faceDetailer: false,
    handDetailer: false,
    hiresFix: false,
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
  let lightboxTarget = null;
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
  const activeRegenTasks = new Map();
  const deleteConfirmState = new WeakMap();
  const armedDeleteButtons = new Set();
  let deleteGlobalResetBound = false;
  let chatMediaObserver = null;
  const pendingEnhanceMesIds = new Set();
  let enhanceBatchTimer = null;

  function getDefaultEngine() {
    const def = runtimeCloudEngines.find((e) => e.isDefault);
    return def?.id || runtimeCloudEngines[0]?.id || 'moss_quality';
  }

  function migrateEngineId(rawEngine) {
    const raw = String(rawEngine || '').trim();
    if (!raw) return getDefaultEngine();
    if (VALID_CLOUD_ENGINES.has(raw)) return raw;
    if (LEGACY_FAST_ENGINES.has(raw)) {
      return VALID_CLOUD_ENGINES.has('moss_fast') ? 'moss_fast' : getDefaultEngine();
    }
    if (LEGACY_QUALITY_ENGINES.has(raw)) {
      return VALID_CLOUD_ENGINES.has('moss_quality') ? 'moss_quality' : getDefaultEngine();
    }
    return getDefaultEngine();
  }

  function resolveActiveEngine(settings) {
    return migrateEngineId(settings?.engine);
  }

  function formatModeButtonLabel(label, id) {
    const clean = String(label || '')
      .replace(/\s*MOSS(?:-Image)?\s*[·•\-—:]\s*/i, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return clean || ENGINE_FRIENDLY_META[id]?.label || id;
  }

  function getEngineDisplayLabel(engineId) {
    const id = String(engineId || '').trim();
    if (!id) return getEngineDisplayLabel(getDefaultEngine());
    const found = runtimeCloudEngines.find((e) => e.id === id);
    if (found?.label) return found.label;
    if (ENGINE_FRIENDLY_META[id]?.label) return ENGINE_FRIENDLY_META[id].label;
    const migrated = migrateEngineId(id);
    const migSpec = runtimeCloudEngines.find((e) => e.id === migrated) || ENGINE_FRIENDLY_META[migrated];
    return migSpec?.label || id;
  }

  function getEngineShortLabel(engineId) {
    const id = String(engineId || '').trim();
    if (!id) return '';
    const found = runtimeCloudEngines.find((e) => e.id === id);
    if (found?.short) return found.short;
    if (ENGINE_FRIENDLY_META[id]?.short) return ENGINE_FRIENDLY_META[id].short;
    if (LEGACY_FAST_ENGINES.has(id)) return ENGINE_FRIENDLY_META.moss_fast.short;
    if (LEGACY_QUALITY_ENGINES.has(id)) return ENGINE_FRIENDLY_META.moss_quality.short;
    if (found?.label) return formatModeButtonLabel(found.label, id).replace(/^[^\w\u4e00-\u9fa5]+/, '').slice(0, 10);
    return id.slice(0, 10);
  }

  function normalizeEngineSpec(entry, idx = 0) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (!id) return null;
      const preset = ENGINE_FRIENDLY_META[id];
      return {
        id,
        label: preset?.label || id,
        short: preset?.short || id.slice(0, 10),
        sub: preset?.sub || '',
        desc: preset?.desc || '',
        isDefault: idx === 0,
      };
    }
    if (!entry || typeof entry !== 'object') return null;
    const id = String(entry.id || entry.key || entry.engine || entry.value || '').trim();
    if (!id) return null;
    const preset = ENGINE_FRIENDLY_META[id];
    const label = String(entry.label || entry.name || entry.title || preset?.label || id).trim();
    const short = String(
      entry.short || entry.badge || preset?.short || formatModeButtonLabel(label, id).replace(/^[^\w\u4e00-\u9fa5]+/, '').slice(0, 10),
    ).trim();
    const stepsNum = Number(entry.steps);
    const sub = String(entry.sub || entry.subtitle || entry.speed || preset?.sub || (stepsNum > 0 ? `${stepsNum}步` : '')).trim();
    const desc = String(entry.desc || entry.description || preset?.desc || '').trim();
    return {
      id,
      label,
      short,
      sub,
      desc,
      isDefault: !!(entry.default || entry.is_default),
    };
  }

  function selectCloudEngine(engineId) {
    const nextId = migrateEngineId(engineId);
    const st = getSettings();
    const changed = st.engine !== nextId || !st.engineUserChosen;
    st.engine = nextId;
    st.engineUserChosen = true;
    if (changed) saveSettings();
    syncEngineSelectorUi();
    updateConnectionUi();
    enhanceAllVisibleFloorMedia();
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (viewer && !viewer.classList.contains('yiyi-hidden')) renderOverlayViewer();
    const lb = document.getElementById('yiyi-lightbox');
    if (lb && !lb.classList.contains('yiyi-hidden')) renderLightbox();
    return nextId;
  }

  function syncEngineSelectorUi() {
    const field = document.getElementById('yiyi-engine-field');
    const seg = document.getElementById('yiyi-opt-engine');
    const descEl = document.getElementById('yiyi-engine-desc');
    if (!seg) return;
    const s = getSettings();
    const curVal = resolveActiveEngine(s);
    seg.innerHTML = '';
    seg.dataset.value = curVal;
    for (const eng of runtimeCloudEngines) {
      const btn = document.createElement('button');
      btn.type = 'button';
      const isActive = eng.id === curVal;
      btn.className = `yiyi-mode-btn${eng.id === 'moss_fast' ? ' is-fast' : ''}${isActive ? ' is-active' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
      btn.dataset.engine = eng.id;
      btn.title = eng.desc ? `${eng.label} — ${eng.desc}` : eng.label;

      const titleSpan = document.createElement('span');
      titleSpan.className = 'yiyi-mode-title';
      titleSpan.textContent = formatModeButtonLabel(eng.label, eng.id);
      btn.appendChild(titleSpan);

      if (eng.sub) {
        const subSpan = document.createElement('span');
        subSpan.className = 'yiyi-mode-sub';
        subSpan.textContent = eng.sub;
        btn.appendChild(subSpan);
      }

      btn.onclick = () => selectCloudEngine(eng.id);
      seg.appendChild(btn);
    }
    if (descEl) {
      const activeSpec = runtimeCloudEngines.find((e) => e.id === curVal);
      const desc = activeSpec?.desc ? String(activeSpec.desc).trim() : '';
      descEl.textContent = desc;
      descEl.style.display = desc ? '' : 'none';
    }
    if (field) {
      field.style.display = runtimeCloudEngines.length > 1 ? '' : 'none';
    }
  }

  function syncEnginesFromPing(pingData) {
    if (!pingData || typeof pingData !== 'object') return false;
    const rawList = pingData.engines || pingData.available_engines || pingData.workflows || null;
    const engineMetaMap = (pingData.engine_meta && typeof pingData.engine_meta === 'object') ? pingData.engine_meta : {};
    const defaultId = String(pingData.default_engine || pingData.active_engine || '').trim();
    const parsed = [];
    const seen = new Set();

    const pushSpec = (rawItem, fallbackKey = '') => {
      let spec = null;
      if (typeof rawItem === 'string') {
        const id = rawItem.trim();
        const meta = id ? engineMetaMap[id] : null;
        spec = meta && typeof meta === 'object'
          ? normalizeEngineSpec(Object.assign({ id }, meta), parsed.length)
          : normalizeEngineSpec(id, parsed.length);
      } else if (rawItem && typeof rawItem === 'object') {
        const id = String(rawItem.id || rawItem.key || rawItem.engine || fallbackKey || '').trim();
        const meta = id ? engineMetaMap[id] : null;
        const merged = Object.assign({ id }, meta && typeof meta === 'object' ? meta : {}, rawItem);
        spec = normalizeEngineSpec(merged, parsed.length);
      }
      if (!spec || seen.has(spec.id)) return;
      const meta = engineMetaMap[spec.id];
      if (meta && typeof meta === 'object') {
        if (meta.desc && !spec.desc) spec.desc = String(meta.desc).trim();
        if (Number(meta.steps) > 0) spec.steps = Number(meta.steps);
        if (Number(meta.cfg) > 0) spec.cfg = Number(meta.cfg);
      }
      seen.add(spec.id);
      parsed.push(spec);
    };

    if (Array.isArray(rawList)) {
      rawList.forEach((item) => pushSpec(item));
    } else if (rawList && typeof rawList === 'object') {
      Object.entries(rawList).forEach(([k, v]) => {
        if (typeof v === 'string') pushSpec({ id: k, label: v }, k);
        else if (v && typeof v === 'object') pushSpec(v, k);
      });
    } else if (Object.keys(engineMetaMap).length > 0) {
      Object.entries(engineMetaMap).forEach(([k, v]) => pushSpec(v, k));
    } else if (defaultId) {
      pushSpec(defaultId);
    }

    if (!parsed.length) return false;

    if (defaultId && parsed.some((e) => e.id === defaultId)) {
      parsed.forEach((e) => { e.isDefault = e.id === defaultId; });
    } else if (!parsed.some((e) => e.isDefault)) {
      parsed[0].isDefault = true;
    }

    runtimeCloudEngines = parsed;
    enginesSyncedFromServer = true;
    VALID_CLOUD_ENGINES.clear();
    for (const e of runtimeCloudEngines) VALID_CLOUD_ENGINES.add(e.id);

    const rawBefore = String(getCtx()?.extensionSettings?.[EXT_KEY]?.engine || '').trim();
    const s = getSettings();
    const migrated = migrateEngineId(s.engine);
    if (s.engine !== migrated || (rawBefore && rawBefore !== migrated)) {
      s.engine = migrated;
      saveSettings();
    }
    syncEngineSelectorUi();
    return true;
  }

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
    const rawEngine = typeof raw.engine === 'string' ? raw.engine.trim() : '';
    merged.engine = migrateEngineId(rawEngine);
    merged.hiresRefine = !!merged.hiresRefine;
    merged.nsfwBoost = !!merged.nsfwBoost;
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

  function stripPairedBlocks(input, tagPattern) {
    let out = String(input || '');
    const re = new RegExp(`<(${tagPattern})\\b[^>]*>(?:(?!<\\1\\b)[\\s\\S])*?<\\/\\1>`, 'gi');
    for (let pass = 0; pass < 3; pass++) {
      const next = out.replace(re, '');
      if (next === out) break;
      out = next;
    }
    return out;
  }

  function unwrapSafeHtmlTags(input) {
    return String(input || '')
      .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, '\n')
      // Only strip valid ASCII HTML/XML tags so Chinese angle-bracket thoughts ("<不会吧>") or math ("<5米, >10") survive intact.
      .replace(/<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s+[^<>]{0,400})?\/?>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function countNarrativeChars(text) {
    const s = String(text || '').replace(/\s+/g, '');
    if (!s) return 0;
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    const words = (String(text || '').match(/[A-Za-z]{2,}/g) || []).length;
    return cjk + words * 3;
  }

  function looksLikeProseText(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return false;
    const kvLines = lines.filter((l) => /^["']?[^"'：:=|\n]{1,18}["']?\s*[:：=]\s*/.test(l)).length;
    if (lines.length >= 2 && kvLines / lines.length >= 0.7 && !/[。！？!?]/.test(s)) {
      return false;
    }
    return countNarrativeChars(s) >= 20;
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

    const restoreSavedTags = (txt) => {
      let out = txt;
      if (keepInlineTag && savedTags.length) {
        savedTags.forEach((orig, idx) => {
          out = out.replace(`__YIYI_IMG_TAG_${idx}__`, orig);
        });
      }
      return out.trim();
    };

    const HARD_NOISE_TAGS = 'think[a-z0-9_-]*|thinking|thought|cot|reasoning|scratchpad|inner_monologue|style|script|head|svg|template|noscript|UpdateVariable|Variable|variables|mvu|JSONPatch|tableEdit';
    const SOFT_UI_TAGS = 'details|statusbar|status|options|choices';

    // Pass 1 (gentle): remove only unambiguous reasoning/code/variable noise blocks
    let softBase = stripPairedBlocks(s, HARD_NOISE_TAGS);
    softBase = softBase
      .replace(/```(?:css|js|javascript|json|yaml|yml|mvu|updatevariable|status|statusbar)\b[\s\S]*?```/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');

    // Pass 2 (strict): also strip collapsible statusbars / choices / html code fences
    let strictBase = stripPairedBlocks(softBase, SOFT_UI_TAGS)
      .replace(/```html\b[\s\S]*?```/gi, '');

    let strictCleaned = unwrapSafeHtmlTags(strictBase);
    // Strip any leftover orphaned thinking/noise opening/closing tags without touching inner text
    strictCleaned = strictCleaned.replace(/<\/?(?:think[a-z0-9_-]*|thinking|thought|cot|reasoning|scratchpad|inner_monologue|statusbar|UpdateVariable|JSONPatch|tableEdit)\b[^>]*>/gi, '').trim();

    if (strictCleaned.length >= 16) {
      return restoreSavedTags(strictCleaned);
    }

    // Safety fallback: if strict stripping wiped out prose wrapped inside <details>/```html, degrade gently
    let softCleaned = stripPairedBlocks(softBase, 'summary')
      .replace(/```html\b([\s\S]*?)```/gi, '$1');
    softCleaned = unwrapSafeHtmlTags(softCleaned);
    softCleaned = softCleaned.replace(/<\/?(?:think[a-z0-9_-]*|thinking|thought|cot|reasoning|scratchpad|inner_monologue|statusbar|UpdateVariable|JSONPatch|tableEdit)\b[^>]*>/gi, '').trim();

    const strictNarr = countNarrativeChars(strictCleaned);
    const softNarr = countNarrativeChars(softCleaned);
    if (
      (!strictCleaned && looksLikeProseText(softCleaned)) ||
      (strictNarr < 14 && softNarr >= Math.max(48, strictNarr * 4) && looksLikeProseText(softCleaned))
    ) {
      return restoreSavedTags(softCleaned);
    }

    if (strictCleaned) {
      return restoreSavedTags(strictCleaned);
    }

    // Last-resort guard against malformed/unclosed tags swallowing a prose-rich floor
    const rawFallback = unwrapSafeHtmlTags(
      stripPairedBlocks(s, 'style|script|head|svg|template|noscript')
        .replace(/<!--[\s\S]*?-->/g, ''),
    );
    if (!strictCleaned && !softCleaned && looksLikeProseText(rawFallback) && !/<(?:think|thinking|thought|statusbar|UpdateVariable)\b/i.test(s)) {
      return restoreSavedTags(rawFallback);
    }

    return restoreSavedTags(strictCleaned);
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
    if (prevLower && prevLower.includes(tl)) return 1;
    return 0;
  }

  const NOISE_VAR_KEY_RE = /^(?:hp|mp|exp|lv|level|gold|money|coin|credit|score|rank|id|uuid|timestamp|created_at|updated_at|\$meta)$/i;

  // Permanent fixed physical traits (hair color/style, eye color/heterochromia, skin tone, physique, non-human species features, permanent marks)
  const PERMANENT_KEY_RE = /(外貌|长相|容貌|特征|发[色型]|瞳[色眸]|眸色|眼色|肤色|身[材高体]|体型|种族|物种|形态|兽耳|羽翼|尾巴|泪痣|疤痕|appearance|look|hair|eye|skin|body|race|species|ears|wings|tail|scar)/i;
  const OUTFIT_KEY_RE = /(衣着|穿着|穿戴|服饰|服装|着装|装扮|衣裙|衣服|鞋袜|配饰|首饰|束缚|outfit|cloth|wear|dress|attire|costume)/i;
  const SCENE_KEY_RE = /(地点|位置|场景|环境|所在|天气|时间|氛围|location|place|scene|setting|weather|time|environment)/i;
  const VIS_KEY_RE = new RegExp(`${PERMANENT_KEY_RE.source}|${OUTFIT_KEY_RE.source}|${SCENE_KEY_RE.source}`, 'i');

  const HAIR_TRAIT_RE = /(?:发色|发型|长发|短发|卷发|直发|碎发|齐肩发|及腰长?发|齐腰长?发|披肩长?发|马尾|双马尾|低马尾|高马尾|麻花辫|细辫|编发|丸子头|公主切|姬发式|刘海|挑染|渐变发|银发|银白(?:色)?(?:长|短|卷|直)?发|白发|雪白(?:长|短)?发|黑发|乌黑(?:长|短)?发|漆黑(?:长|短)?发|金发|金黄(?:长|短)?发|粉发|樱粉(?:长|短)?发|红发|绯红(?:长|短)?发|酒红(?:长|短)?发|蓝发|冰蓝(?:长|短)?发|紫发|淡紫(?:长|短)?发|灰发|银灰(?:长|短)?发|棕发|栗色(?:长|短|低|高)?(?:发|马尾)|茶色(?:长|短)?发|亚麻色?(?:长|短)?发|墨绿(?:长|短)?发|(?:银白|雪白|乌黑|金黄|绯红|樱粉|淡紫|浅蓝|深蓝|栗色|棕色|银灰|银|白|黑|金|粉|红|蓝|紫|灰|棕|绿|茶|栗)(?:色)?(?:的)?(?:秀发|头发|发丝)|silver\s+hair|white\s+hair|black\s+hair|blonde|brunette|pink\s+hair|red\s+hair|blue\s+hair|purple\s+hair|brown\s+hair|chestnut\s+hair|ponytail|twintails|braid)/i;
  const EYE_TRAIT_RE = /(?:瞳色|异瞳|异色双眸|异色瞳|眸色|眼色|虹膜|红瞳|红眸|蓝瞳|蓝眸|金瞳|金眸|紫瞳|紫眸|碧瞳|碧眸|绿瞳|绿眸|黑瞳|黑眸|灰瞳|灰眸|棕瞳|棕眸|绯红(?:色)?(?:眼|眸|瞳)|湛蓝(?:色)?(?:眼|眸|瞳)|宝石(?:红|蓝)(?:色)?(?:眼|眸|瞳)|琥珀(?:色)?(?:眼|眸|瞳)|翡翠(?:色)?(?:眼|眸|瞳)|冰蓝(?:色)?(?:眼|眸|瞳)|紫罗兰(?:色)?(?:眼|眸|瞳)|(?:绯红|湛蓝|浅蓝|深蓝|冰蓝|蔚蓝|翠绿|碧绿|琥珀|金黄|淡紫|深紫|赤红|银灰|茶色|棕色|红|蓝|金|紫|绿|碧|黑|灰|棕)(?:色)?(?:的)?(?:眼睛|眼眸|双眸|瞳孔)|(?:左眼|右眼|双眼|眼眸|双眸|瞳孔)[^，。！？,\n]{0,12}(?:绯红|湛蓝|红宝石|蓝宝石|赤红|血红|宝石蓝|冰蓝|翠绿|碧绿|琥珀|鎏金|金黄|淡紫|深紫|银灰|漆黑|红色|蓝色|金色|紫色|绿色|异色)|heterochromia|(?:red|blue|golden|gold|purple|violet|green|emerald|amber|crimson|sapphire|ruby|silver|black|brown|heterochromatic)\s+eyes)/i;
  const BODY_SPECIES_TRAIT_RE = /(?:肤色|白皙(?:的)?(?:肌肤|皮肤)|雪白(?:的)?(?:肌肤|皮肤)|苍白(?:的)?(?:肌肤|皮肤)|小麦色(?:的)?(?:肌肤|皮肤|肤色)|古铜色(?:的)?(?:肌肤|皮肤|肤色)|身材娇小|身材高挑|身材修长|身材纤细|身材丰满|体型(?:娇小|高挑|修长|纤细|健壮|魁梧)|兽耳|狐耳|猫耳|兔耳|狼耳|狗耳|犬耳|精灵耳|尖耳|龙角|恶魔角|羊角|鹿角|羽翼|翅膀|光翼|蝠翼|狐尾|猫尾|狼尾|龙尾|恶魔尾|鱼尾|尾巴|泪痣|美人痣|雀斑|胎记|疤痕|刀疤|伤疤|机械臂|义肢|义眼|(?:fox|cat|rabbit|wolf|elf|pointed)\s+ears|(?:dragon|demon)\s+horns|(?:angel|demon|feathered)?\s*wings|(?:fox|cat|wolf|dragon)\s+tail|beauty\s+mark|freckles|facial\s+scar|pale\s+skin|tanned\s+skin)/i;
  const PERMANENT_APPEARANCE_RE = new RegExp(`${HAIR_TRAIT_RE.source}|${EYE_TRAIT_RE.source}|${BODY_SPECIES_TRAIT_RE.source}`, 'i');

  // Atomic permanent trait phrases for cleanly rescuing fixed appearance from mixed clauses without leaking outfits/locations
  const PERMANENT_HAIR_TOKEN_RE = /(?:(?:乌黑|漆黑|墨黑|雪白|银白|苍白|纯白|浅金|金黄|淡金|绯红|酒红|暗红|樱粉|浅粉|浅蓝|深蓝|冰蓝|淡紫|深紫|银灰|灰白|浅灰|栗色|棕色|茶色|咖啡色|亚麻色|墨绿|翠绿|银|白|黑|金|粉|红|蓝|紫|灰|棕|绿|茶|栗)(?:色)?(?:的)?(?:齐腰|及腰|齐肩|过肩|齐耳|披肩|微卷|大波浪|蓬松|柔顺|顺滑)?(?:长发|短发|卷发|直发|碎发|秀发|头发|发丝|马尾|双马尾|低马尾|高马尾|麻花辫|细辫|编发|丸子头|公主切|姬发式)|(?:齐腰|及腰|齐肩|披肩)(?:长发|短发|卷发|直发)|(?:双马尾|低马尾|高马尾|麻花辫|丸子头|挑染)(?:长发|短发)?|(?:silver|white|black|blonde|golden|pink|red|crimson|blue|purple|violet|grey|gray|brown|chestnut|auburn|green)\s+(?:long\s+|short\s+|wavy\s+|curly\s+|straight\s+)?hair)/gi;
  const PERMANENT_EYE_TOKEN_RE = /(?:(?:红蓝|金蓝|红金|蓝紫|紫金|黑白)?异瞳|异色双眸|左眼[\u4e00-\u9fa5]{1,6}右眼[\u4e00-\u9fa5]{1,6}(?:的)?(?:异瞳|双眸|眼眸|瞳)?|(?:绯红|湛蓝|宝石蓝|宝石红|冰蓝|蔚蓝|海蓝|翠绿|碧绿|翡翠|琥珀|鎏金|金黄|紫罗兰|淡紫|深紫|赤红|血红|酒红|漆黑|墨黑|银灰|茶色|棕色|红|蓝|金|紫|绿|碧|黑|灰|棕)(?:色)?(?:的)?(?:瞳孔|眼眸|双眸|瞳色|眸子|眼睛|红瞳|蓝瞳|金瞳|紫瞳|绿瞳|碧瞳|黑瞳|红眸|蓝眸|金眸|紫眸|碧眸|绿眸|瞳|眸)|(?:red|blue|golden|gold|purple|violet|green|emerald|amber|crimson|sapphire|ruby|black|brown|silver|heterochromatic)\s+eyes|heterochromia)/gi;
  const PERMANENT_BODY_TOKEN_RE = /(?:(?:白皙|雪白|苍白|小麦色|古铜色|黝黑)(?:的)?(?:肌肤|皮肤|肤色)|(?:身材|体型)(?:娇小|高挑|修长|纤细|丰满|健壮|魁梧)|(?:雪白|银色|黑色|金色|蓬松)?(?:的)?(?:狐耳|猫耳|兔耳|狼耳|狗耳|犬耳|兽耳|精灵耳|尖耳|龙角|恶魔角|羊角|鹿角|天使羽翼|恶魔羽翼|羽翼|翅膀|狐尾|猫尾|狼尾|龙尾|恶魔尾|鱼尾|尾巴)|(?:左脸颊|右脸颊|眼角|眼下)?(?:一颗)?(?:小)?(?:泪痣|美人痣)|雀斑|伤疤|刀疤|疤痕|(?:fox|cat|rabbit|wolf|elf|pointed)\s+ears|(?:dragon|demon)\s+horns|(?:angel|demon|feathered)?\s*wings|(?:fox|cat|wolf|dragon)\s+tail|beauty\s+mark|freckles)/gi;

  // Transient states (outfits/nudity, locations/environments/weather, temporary actions/events) — NEVER allowed to override current floor prose
  const TRANSIENT_OUTFIT_RE = /(?:一袭|身穿|穿着|身着|换上|换了|换穿|披着|身披|脱下|褪去|赤裸|裸露|未着寸缕|赤身|全裸|半裸|衣衫|衣裙|衣服|衣裳|服装|服饰|裙摆|长裙|短裙|连衣裙|百褶裙|礼裙|礼服|晚礼服|婚纱|汉服|旗袍|和服|浴衣|睡衣|睡裙|内衣|文胸|胸罩|内裤|比基尼|泳装|泳衣|校服|水手服|制服|西装|衬衫|衬衣|T恤|毛衣|卫衣|风衣|大衣|外套|夹克|斗篷|披风|围巾|丝巾|领带|领结|牛仔裤|长裤|短裤|热裤|白袜|黑丝|白丝|丝袜|过膝袜|连裤袜|吊带袜|高跟鞋|皮鞋|运动鞋|靴子|长靴|凉鞋|拖鞋|赤脚|光脚|手套|草帽|贝雷帽|帽子|铠甲|盔甲|战甲|长袍|道袍|女仆装|兔女郎|wearing|dressed\s+in|outfit|clothes|clothing|dress|gown|skirt|shirt|blouse|coat|trench\s+coat|jacket|scarf|uniform|pajamas|lingerie|bikini|swimsuit|stockings|pantyhose|heels|boots|naked|nude|undressed|barefoot)/i;
  const TRANSIENT_SCENE_RE = /(?:身处|位于|来到|走进|踏入|站在|坐在|蹲在|躺在|趴在|倚在|靠在|卧室|房间|床边|床上|客厅|厨房|浴室|卫生间|阳台|露台|走廊|楼道|教室|课桌|图书馆|操场|天台|办公室|会议室|咖啡厅|咖啡馆|餐厅|酒吧|酒馆|茶寮|茶馆|旅馆|酒店|医院|病房|火车站|地铁站|车站|月台|站台|长椅|机场|港口|码头|街道|街头|小巷|广场|公园|花园|庭院|校园|学院|城堡|古塔|宫殿|大殿|神殿|教堂|森林|树林|山谷|山顶|海边|沙滩|湖畔|河边|温泉|洞穴|地牢|废墟|荒野|沙漠|雪原|马车|车厢|船舱|室内|室外|户外|黄昏|夕阳|日落|黎明|清晨|午后|夜晚|深夜|雨夜|月光|月夜|星夜|雨天|下雨|暴雨|细雨|下雪|大雪|晴天|雾气|灯火|霓虹|bedroom|room|classroom|office|cafe|bar|train\s+station|station|platform|bench|street|alley|park|garden|castle|tower|palace|forest|beach|rain|snow|sunset|dusk|dawn|night|moonlight|indoors|outdoors)/i;
  const TRANSIENT_META_RE = /(?:^|\s)(?:世界背景|卡面设定|角色背景|剧情摘要|近期事件|近期境况|状态原子)\s*[:：]/i;

  const ENTITY_STOPWORDS = new Set([
    '我们', '你们', '他们', '她们', '它们', '自己', '此时', '这时', '随后', '然后', '突然', '已经', '正在', '仿佛', '似乎',
    '面前', '眼前', '身旁', '身边', '身后', '声音', '语气', '神情', '表情', '目光', '眼神', '视线', '双手', '手指', '身体',
    '心中', '心里', '脑海', '空气', '微风', '阳光', '月光', '灯光', '雨水', '黄昏', '夜色', '世界', '时间', '地方', '房间',
    '街道', '这里', '那里', '什么', '怎么', '没有', '不是', '可以', '只是', '还是', '但是', '因为', '所以', '如果', '虽然',
    '一个', '一位', '一只', '一把', '一颗', '女孩', '少女', '女子', '少年', '男子', '女人', '男人', '孩子', '老人', '人们',
    '大家', '所有人', '年轻女子', '年轻女孩',
  ]);

  function analyzeFloorVisualCoverage(text) {
    const s = String(text || '');
    const hasHair = HAIR_TRAIT_RE.test(s);
    const hasEyes = EYE_TRAIT_RE.test(s);
    const hasPermanentBody = BODY_SPECIES_TRAIT_RE.test(s);
    const hasPermanentAppearance = hasHair || hasEyes || hasPermanentBody;
    const hasOutfit = TRANSIENT_OUTFIT_RE.test(s);
    const hasScene = TRANSIENT_SCENE_RE.test(s);
    const needsHairOrEyes = !hasHair || !hasEyes;
    return {
      hasHair,
      hasEyes,
      hasPermanentBody,
      hasPermanentAppearance,
      hasOutfit,
      hasScene,
      hasRichVisuals: (hasOutfit || hasScene) && hasPermanentAppearance,
      needsHairOrEyes,
      needsFixedAppearance: !hasHair || !hasEyes,
    };
  }

  function extractAtomicPermanentTokens(text, opts = {}) {
    const tokens = [];
    const seen = new Set();
    const collect = (re) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const tok = String(m[0] || '').trim().replace(/^的+/, '');
        if (!tok) continue;
        const key = normText(tok);
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(tok);
        if (tokens.length >= 4) break;
      }
    };
    if (!opts.skipHair) collect(PERMANENT_HAIR_TOKEN_RE);
    if (!opts.skipEyes) collect(PERMANENT_EYE_TOKEN_RE);
    if (!opts.skipBody && tokens.length < 4) collect(PERMANENT_BODY_TOKEN_RE);
    return tokens;
  }

  function extractPermanentAppearance(rawText, opts = {}) {
    const cleaned = cleanFloorForDistill(rawText || '', false);
    if (!cleaned) return '';
    const keepClauses = [];
    const seen = new Set();

    const pushUniq = (str) => {
      const s = String(str || '').replace(/^[·•\-—:：\s]+/, '').trim();
      if (!s || s.length < 2) return;
      const sig = normText(s);
      if (seen.has(sig)) return;
      // Avoid adding a shorter duplicate already contained in an existing clause
      for (const existing of seen) {
        if (existing.includes(sig)) return;
      }
      seen.add(sig);
      keepClauses.push(s);
    };

    const sentences = cleaned.split(/[。！？!\?\n；;]+/);
    for (const sent of sentences) {
      const st = sent.trim();
      if (!st || TRANSIENT_META_RE.test(st)) continue;
      const clauses = st.split(/[，,]+/);
      for (const rawCl of clauses) {
        const cl = rawCl.trim();
        if (!cl || cl.length < 2) continue;
        if (!PERMANENT_APPEARANCE_RE.test(cl)) continue;

        const hasTransient = TRANSIENT_OUTFIT_RE.test(cl) || TRANSIENT_SCENE_RE.test(cl);
        if (!hasTransient && cl.length <= 64) {
          const isHair = HAIR_TRAIT_RE.test(cl);
          const isEyes = EYE_TRAIT_RE.test(cl);
          const isBody = BODY_SPECIES_TRAIT_RE.test(cl);
          const wantsHair = isHair && !opts.skipHair;
          const wantsEyes = isEyes && !opts.skipEyes;
          const wantsBody = isBody && !opts.skipBody;
          if ((wantsHair || wantsEyes || wantsBody) && !(isHair && opts.skipHair && !wantsEyes && !wantsBody)) {
            if ((isHair && opts.skipHair) || (isEyes && opts.skipEyes)) {
              const toks = extractAtomicPermanentTokens(cl, opts);
              if (toks.length) pushUniq(toks.join('、'));
            } else {
              pushUniq(cl);
            }
          }
        } else {
          // Mixed clause (contains outfit/location/scene alongside hair/eyes): extract ONLY atomic permanent tokens
          const toks = extractAtomicPermanentTokens(cl, opts);
          if (toks.length) pushUniq(toks.join('、'));
        }
        if (keepClauses.length >= 3) break;
      }
      if (keepClauses.length >= 3) break;
    }

    return keepClauses.join('，').slice(0, 120);
  }

  function extractActiveEntities(ctx, mesObj, curCleanText, coverage) {
    const curLower = normText(curCleanText);
    const explicit = new Set();
    const addIfInFloor = (name) => {
      const n = String(name || '').trim();
      if (!n || ENTITY_STOPWORDS.has(n)) return;
      const minLen = /[\u4e00-\u9fa5]/.test(n) ? 2 : 3;
      if (n.length < minLen || n.length > 16) return;
      if (curLower.includes(normText(n))) explicit.add(n);
    };

    const ch = ctx?.characters?.[ctx.characterId];
    addIfInFloor(mesObj?.name);
    addIfInFloor(ctx?.name2);
    addIfInFloor(ch?.name);

    try {
      const lwbJson = ctx?.chatMetadata?.extensions?.LittleWhiteBox?.storySummary?.json;
      for (const person of lwbJson?.characters?.main || []) {
        addIfInFloor(typeof person === 'string' ? person : person?.name);
      }
      for (const alias of lwbJson?.characterAliases || []) {
        addIfInFloor(alias?.from);
        addIfInFloor(alias?.to);
      }
    } catch {}

    const nameMatches = curCleanText.match(/[A-Z][a-z]{2,14}|[\u4e00-\u9fa5]{2,4}(?=(?:说|笑|问|看|望|低头|抬手|抬眼|转身|轻声|微微|轻轻|缓步|推开|走|站|坐|蹲|躺|嘴角|眼角|手中|的))/g) || [];
    for (const rawN of nameMatches.slice(0, 12)) {
      const n = String(rawN || '').trim();
      if (n.length >= 2 && n.length <= 14 && !ENTITY_STOPWORDS.has(n) && !PERMANENT_APPEARANCE_RE.test(n) && !TRANSIENT_OUTFIT_RE.test(n) && !TRANSIENT_SCENE_RE.test(n)) {
        explicit.add(n);
      }
    }

    // Only fall back to the card/speaker name when the current floor has NO explicit character names
    // AND has NO explicit appearance description of its own (e.g. pronoun-only dialogue "她微笑着说...").
    const fallback = new Set();
    if (explicit.size === 0 && !coverage.hasPermanentAppearance) {
      for (const cand of [mesObj?.name, ctx?.name2, ch?.name]) {
        const n = String(cand || '').trim();
        if (n && n.length >= 2 && n.length <= 16 && !ENTITY_STOPWORDS.has(n)) {
          fallback.add(n);
        }
      }
    }

    return {
      explicit,
      all: explicit.size > 0 ? explicit : fallback,
      usedFallback: explicit.size === 0 && fallback.size > 0,
    };
  }

  function collectVariableVisualHints(obj, out, coverage, permOpts, depth = 0, prefix = '') {
    if (!obj || typeof obj !== 'object' || depth > 4 || out.length >= 6) return;
    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 12)) {
        if (out.length >= 6) break;
        if (item && typeof item === 'object') {
          collectVariableVisualHints(item, out, coverage, permOpts, depth + 1, prefix);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (out.length >= 6) break;
      if (NOISE_VAR_KEY_RE.test(k)) continue;
      const fullKey = prefix ? `${prefix}·${k}` : k;
      if (typeof v === 'string') {
        const vs = cleanFloorForDistill(v, false);
        if (!vs || vs.length < 2 || vs.length > 160) continue;
        // Strictly ignore outfit/scene variables once current floor describes them, or if not permanent appearance
        if (OUTFIT_KEY_RE.test(fullKey) || SCENE_KEY_RE.test(fullKey)) continue;
        if (PERMANENT_KEY_RE.test(fullKey) || PERMANENT_APPEARANCE_RE.test(vs)) {
          const perm = extractPermanentAppearance(vs, permOpts);
          if (perm) out.push(`${fullKey}：${perm}`);
        }
      } else if (v && typeof v === 'object') {
        collectVariableVisualHints(v, out, coverage, permOpts, depth + 1, k === 'stat_data' ? prefix : fullKey);
      }
    }
  }

  function collectXiaobaiXMemory(ctx, mesId, curLower, entities, coverage, permOpts) {
    const items = [];
    if (!coverage.needsFixedAppearance || entities.all.size === 0) return items;
    try {
      const lwb = ctx?.chatMetadata?.extensions?.LittleWhiteBox;
      if (!lwb || typeof lwb !== 'object') return items;

      const json = lwb.storySummary?.json;
      if (!json || typeof json !== 'object') return items;

      const aliases = Array.isArray(json.characterAliases) ? json.characterAliases : [];
      const aliasMap = new Map();
      for (const a of aliases) {
        const canonical = String(a?.to || '').trim();
        const alt = String(a?.from || '').trim();
        if (!canonical || !alt) continue;
        if (!aliasMap.has(canonical)) aliasMap.set(canonical, []);
        aliasMap.get(canonical).push(alt);
      }

      const activeNames = new Set();
      for (const n of entities.all) activeNames.add(normText(n));
      for (const person of json.characters?.main || []) {
        if (person?._addedAt !== undefined && Number(person._addedAt) > mesId) continue;
        const pName = String(typeof person === 'string' ? person : person?.name || '').trim();
        if (!pName) continue;
        const allNames = [pName, ...(aliasMap.get(pName) || [])];
        if (allNames.some((n) => activeNames.has(normText(n)) || matchTermScore(n, curLower, '') > 0)) {
          allNames.forEach((n) => activeNames.add(normText(n)));
        }
      }

      // Only pull permanent fixed physical facts for active characters; never inject past events, arcs, stale outfits, or old locations
      for (const fact of json.facts || []) {
        if (!fact || fact.retracted) continue;
        if (fact._addedAt !== undefined && Number(fact._addedAt) > mesId) continue;
        const s = String(fact.s || '').trim();
        const p = String(fact.p || '').trim();
        const o = String(fact.o || '').trim();
        if (!s || !p || !o) continue;
        if (OUTFIT_KEY_RE.test(p) || SCENE_KEY_RE.test(p)) continue;

        const sActive = activeNames.has(normText(s)) || matchTermScore(s, curLower, '') > 0;
        if (!sActive) continue;
        if (!PERMANENT_KEY_RE.test(p) && !PERMANENT_APPEARANCE_RE.test(o)) continue;

        const perm = extractPermanentAppearance(o, permOpts);
        if (!perm) continue;
        items.push({
          score: 8.5 + (HAIR_TRAIT_RE.test(perm) || EYE_TRAIT_RE.test(perm) ? 1.5 : 0),
          text: `${s}固定外貌：${perm}`,
        });
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

  function extractVisualStatusFromRaw(raw, coverage, permOpts) {
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
        .replace(/<\/?[a-zA-Z][a-zA-Z0-9:_-]*(?:\s+[^<>]*)?\/?>/g, '\n');
      for (const line of cleaned.split(/\r?\n/)) {
        const kv = line.match(/^\s*["']?([^"'：:=|\n]{2,18})["']?\s*[:：=]\s*["']?([^"'}\]\n]{2,90})/);
        if (!kv) continue;
        const k = kv[1].trim();
        const v = kv[2].replace(/,\s*$/, '').trim();
        if (!v || /^\d+(?:\/\d+)?%?$/.test(v)) continue;

        if (PERMANENT_KEY_RE.test(k)) {
          if (!coverage.needsFixedAppearance) continue;
          const perm = extractPermanentAppearance(v, permOpts);
          if (perm) items.push({ score: 7.2, text: `${k}：${perm}` });
        } else if (OUTFIT_KEY_RE.test(k)) {
          // Only read current-floor statusbar outfit if the prose itself did NOT describe outfit
          if (coverage.hasOutfit || coverage.hasScene) continue;
          items.push({ score: 4.5, text: `当前${k}：${v}` });
        } else if (SCENE_KEY_RE.test(k)) {
          // Only read current-floor statusbar location if the prose itself did NOT describe scene/outfit
          if (coverage.hasScene || coverage.hasOutfit) continue;
          items.push({ score: 4.2, text: `当前${k}：${v}` });
        }
        if (items.length >= 3) break;
      }
    } catch {}
    return items;
  }

  function extractGenericTableItems(container, curLower, entities, permOpts, items, depth = 0) {
    if (!container || typeof container !== 'object' || depth > 4 || items.length >= 8) return;
    const entityList = Array.from(entities.all);
    const matchEntity = (txt) => entityList.find((e) => normText(txt).includes(normText(e))) || '';

    if (Array.isArray(container)) {
      if (container.length > 0 && Array.isArray(container[0])) {
        const headers = container[0].map((h) => String(h ?? '').trim());
        for (let r = 1; r < container.length && r < 40; r++) {
          const row = container[r];
          if (!Array.isArray(row)) continue;
          const rowFull = row.map((c) => String(c ?? '')).join(' ');
          const hitName = matchEntity(rowFull);
          if (!hitName) continue;
          const permParts = [];
          for (let c = 0; c < row.length; c++) {
            const hk = headers[c] || '';
            const val = String(row[c] ?? '').replace(/\s+/g, ' ').trim();
            if (!val || val === '-' || val === '无') continue;
            if (OUTFIT_KEY_RE.test(hk) || SCENE_KEY_RE.test(hk)) continue;
            if (PERMANENT_KEY_RE.test(hk) || PERMANENT_APPEARANCE_RE.test(val)) {
              const p = extractPermanentAppearance(val, permOpts);
              if (p) permParts.push(p);
            }
          }
          if (permParts.length) {
            items.push({ score: 7.4, text: `${hitName}固定外貌：${permParts.join('，').slice(0, 110)}` });
          }
        }
        return;
      }
      for (const el of container.slice(0, 40)) {
        if (items.length >= 8) break;
        if (el && typeof el === 'object' && !Array.isArray(el)) {
          const rawBlob = Object.values(el).filter((v) => typeof v === 'string').join(' ');
          const hitName = matchEntity(rawBlob);
          if (!hitName) continue;
          const permParts = [];
          for (const [k, v] of Object.entries(el)) {
            if (v == null || typeof v === 'object' || NOISE_VAR_KEY_RE.test(k)) continue;
            if (OUTFIT_KEY_RE.test(k) || SCENE_KEY_RE.test(k)) continue;
            const sv = String(v).replace(/\s+/g, ' ').trim();
            if (!sv) continue;
            if (PERMANENT_KEY_RE.test(k) || PERMANENT_APPEARANCE_RE.test(sv)) {
              const p = extractPermanentAppearance(sv, permOpts);
              if (p) permParts.push(p);
            }
          }
          if (permParts.length) {
            items.push({ score: 7.2, text: `${hitName}固定外貌：${permParts.join('，').slice(0, 110)}` });
          }
        } else {
          extractGenericTableItems(el, curLower, entities, permOpts, items, depth + 1);
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(container)) {
      if (k === 'LittleWhiteBox') continue;
      if (v && typeof v === 'object') {
        extractGenericTableItems(v, curLower, entities, permOpts, items, depth + 1);
      }
    }
  }

  function collectUniversalMemoryPlugins(ctx, mesObj, curLower, entities, coverage, permOpts) {
    const items = [];
    if (!coverage.needsFixedAppearance || entities.all.size === 0) return items;
    const promptKeyRe = /memory|table|sheet|summary|amily|vector|lore|note|remember|rag|db|mem|状态|记忆|总结|表格/i;
    const systemBoilerplateRe = /(?:You are an AI|Write the next|jailbreak|system prompt|roleplay as|uncensored model|<rules>)/i;
    const entityList = Array.from(entities.all);

    // 1. Third-party extensionPrompts — strictly extract permanent appearance only for active characters
    try {
      const extPrompts = ctx?.extensionPrompts || {};
      for (const [key, val] of Object.entries(extPrompts)) {
        if (!val) continue;
        const rawStr = typeof val === 'string' ? val : (val.value || val.text || '');
        if (!rawStr || typeof rawStr !== 'string') continue;
        if (!promptKeyRe.test(key) && systemBoilerplateRe.test(rawStr)) continue;

        const cleaned = cleanFloorForDistill(rawStr, false);
        if (!cleaned) continue;
        const lines = cleaned.split(/\r?\n/);
        for (const rawLine of lines) {
          let line = rawLine.trim();
          if (!line || /^\|?[\s:-]{3,}(?:\|[\s:-]+)+\|?$/.test(line)) continue;
          if (systemBoilerplateRe.test(line) || TRANSIENT_META_RE.test(line)) continue;
          if (line.includes('|')) {
            line = line.split('|').map((c) => c.trim()).filter(Boolean).join('，');
          }
          if (line.length < 6 || line.length > 260) continue;

          const hitName = entityList.find((e) => normText(line).includes(normText(e)));
          if (!hitName) continue;
          const perm = extractPermanentAppearance(line, permOpts);
          if (!perm) continue;

          items.push({
            score: 6.8 + (promptKeyRe.test(key) ? 0.8 : 0),
            text: `${hitName}固定外貌：${perm}`,
          });
        }
      }
    } catch {}

    // 2. Generic table metadata (st-memory-enhancement sheets/hash_sheets, custom DBs) — NEVER inject plot summaries
    try {
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
        if (tc) extractGenericTableItems(tc, curLower, entities, permOpts, items);
      }
    } catch {}

    // 3. Variables scan — strictly permanent appearance traits only (never stale outfits/locations)
    try {
      const varHints = [];
      const activeSwipeVars = Array.isArray(mesObj?.variables)
        ? mesObj.variables[mesObj.swipe_id ?? 0]
        : null;
      collectVariableVisualHints(activeSwipeVars, varHints, coverage, permOpts);
      collectVariableVisualHints(mesObj?.variables, varHints, coverage, permOpts);
      collectVariableVisualHints(ctx?.chatMetadata?.variables, varHints, coverage, permOpts);
      collectVariableVisualHints(ctx?.variables?.local, varHints, coverage, permOpts);
      for (const vh of varHints.slice(0, 3)) {
        items.push({ score: 6.2, text: vh });
      }
    } catch {}

    return items;
  }

  function collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, maxLookback = 30, coverageArg = null, entitiesArg = null) {
    const items = [];
    try {
      const chat = ctx?.chat || [];
      if (!chat.length || mesId <= 0) return items;

      const coverage = coverageArg || analyzeFloorVisualCoverage(curCleanText);
      // When current floor ALREADY specifies both hair & eyes (or explicit appearance + outfit/scene without naming another entity),
      // NEVER pull stale historical traits from earlier floors.
      if (!coverage.needsFixedAppearance) return items;

      const entities = entitiesArg || extractActiveEntities(ctx, mesObj, curCleanText, coverage);
      if (entities.all.size === 0) return items;

      const entityList = Array.from(entities.all);
      const permOpts = {
        skipHair: coverage.hasHair,
        skipEyes: coverage.hasEyes,
        skipBody: coverage.hasPermanentBody,
      };

      const startIdx = Math.max(0, mesId - maxLookback);
      for (let i = mesId - 1; i >= startIdx; i--) {
        const m = chat[i];
        if (!m || m.is_system || !m.mes) continue;
        const clean = cleanFloorForDistill(m.mes, false);
        if (!clean) continue;

        const dist = mesId - 1 - i;
        const sentences = clean.split(/[。！？!\?\n；;]+/);
        for (const rawSent of sentences) {
          const s = rawSent.trim();
          if (s.length < 4 || s.length > 220) continue;
          if (!PERMANENT_APPEARANCE_RE.test(s)) continue;

          const matchedName = entityList.find((tok) => s.includes(tok))
            || (entities.usedFallback && m.name && entityList.includes(m.name) ? m.name : '');
          if (!matchedName) continue;

          // Strictly extract ONLY permanent physical traits (hair/eyes/species/marks), stripping any stale outfit or location!
          const perm = extractPermanentAppearance(s, permOpts);
          if (!perm) continue;

          const hasHairOrEye = HAIR_TRAIT_RE.test(perm) || EYE_TRAIT_RE.test(perm);
          const recency = Math.max(1.5, 5.0 - dist * 0.08);
          const score = recency + (hasHairOrEye ? 3.2 : 1.0) + (entities.explicit.has(matchedName) ? 2.0 : 0.8);
          items.push({
            score,
            text: `${matchedName}固定外貌：${perm}`,
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

    const userName = ctx?.name1 || '';
    const userAppearance = String(ctx?.powerUserSettings?.persona_description || '').trim().slice(0, 220);
    const prevVisualPrompt = findPrevVisualPrompt(ctx, mesId);
    const memoryMode = settings.memoryMode || (settings.autoWorldLore === false ? 'off' : 'smart');

    if (memoryMode === 'off') {
      return { memoryContext: '', userName, userAppearance, prevVisualPrompt: '' };
    }

    const coverage = analyzeFloorVisualCoverage(curCleanText);
    const entities = extractActiveEntities(ctx, mesObj, curCleanText, coverage);
    const permOpts = {
      skipHair: coverage.hasHair,
      skipEyes: coverage.hasEyes,
      skipBody: coverage.hasPermanentBody,
    };

    const candidates = [];

    // Status block cues from the CURRENT floor only (strictly filtered so prose outfit/scene is never overridden)
    candidates.push(...extractVisualStatusFromRaw(rawFloorText || mesObj?.mes || '', coverage, permOpts));

    if (memoryMode === 'story_only') {
      candidates.push(...collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, 30, coverage, entities));
    } else if (coverage.needsFixedAppearance && entities.all.size > 0) {
      // Source A: 小白X permanent appearance facts only
      const xbxItems = collectXiaobaiXMemory(ctx, mesId, curLower, entities, coverage, permOpts);
      candidates.push(...xbxItems);

      // Source B: Universal third-party memory plugins (permanent appearance traits only)
      const pluginItems = collectUniversalMemoryPlugins(ctx, mesObj, curLower, entities, coverage, permOpts);
      candidates.push(...pluginItems);

      // Source C: SillyTavern World Info (ONLY entries matching active entities in current floor, filtered to permanent traits)
      // NOTE: Raw card `scenario` ("世界背景：") and raw `description` ("卡面设定：") are NEVER dumped into memory_context!
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

      const entityList = Array.from(entities.all);
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
        const matchedKey = keys.find((k) => matchTermScore(k, curLower, '') > 0)
          || entityList.find((e) => keys.some((k) => normText(k) === normText(e)) || normText(entry.comment || '').includes(normText(e)));
        if (!matchedKey) continue;

        const perm = extractPermanentAppearance(contentClean, permOpts);
        if (!perm) continue;
        const title = String(matchedKey || entry.comment || '').trim().slice(0, 20);
        candidates.push({
          score: 8.2 + (HAIR_TRAIT_RE.test(perm) || EYE_TRAIT_RE.test(perm) ? 1.5 : 0),
          text: `${title ? `${title}固定外貌` : '固定外貌'}：${perm}`,
        });
      }

      // Source D: Historical chat permanent-trait lookback (strictly permanent hair/eye/species traits, zero old outfits/locations)
      const storyItems = collectChatStoryTraits(ctx, mesId, mesObj, curCleanText, 30, coverage, entities);
      candidates.push(...storyItems);

      // Source E (last-resort fallback): if card's own character is active and no source supplied hair/eyes,
      // extract ONLY permanent hair/eye/species tokens from card description (NEVER scenario, NEVER outfit/location!)
      if (candidates.length === 0) {
        try {
          const cardName = String(ch?.name || ctx?.name2 || '').trim();
          const cardActive = cardName && entityList.some((e) => normText(e) === normText(cardName));
          if (cardActive) {
            const rawDesc = String(chData.description || ch?.description || '').trim();
            if (rawDesc) {
              const permDesc = extractPermanentAppearance(rawDesc, permOpts);
              if (permDesc && (HAIR_TRAIT_RE.test(permDesc) || EYE_TRAIT_RE.test(permDesc))) {
                candidates.push({ score: 5.5, text: `${cardName}固定外貌：${permDesc}` });
              }
            }
          }
        } catch {}
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const outLines = [];
    const seenOut = new Set();
    let totalLen = 0;
    const MAX_MEMORY_CHARS = 320;
    for (const c of candidates) {
      const sig = normText(c.text.replace(/^[^：:]+[：:]/, '')).slice(0, 40);
      if (!sig || seenOut.has(sig)) continue;
      if (outLines.length >= 3) break;
      if (totalLen + c.text.length + 1 > MAX_MEMORY_CHARS) break;
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
            : `当前不可生图：云端 GPU 休眠中（${data.schedule || '07:00–02:00 全天常驻 · 02:00–07:00 休眠省电'}）`),
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
      btnEl.textContent = hasUpdate
        ? `⬇️ 立即更新${newerVer ? ` (v${remoteLatestVersion})` : ''}`
        : `🔄 检查更新 (v${EXT_VERSION})`;
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
    syncEnginesFromPing(res.data);
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
      syncEnginesFromPing(bestErr.data);
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
        body: JSON.stringify({ gpu: 'L4', force: false }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(formatHttpErr(resp.status, '唤醒云端 L4', body));
      }
      const data = await resp.json().catch(() => ({}));
      toastInfo(data.message || '⚡ 已开始唤醒云端 L4，约 2.5 分钟后就绪，30 分钟不用自动关停~', 'info');
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
          toastInfo('🟢 云端 L4 已就绪，现在可以开始生图啦！', 'success');
        } else if (tries >= 48) {
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
    const autoWake = info.auto_wake !== false;
    const idleMin = info.idle_timeout_minutes || 30;
    const idleRemMin = typeof info.idle_remaining_seconds === 'number'
      ? Math.max(1, Math.ceil(info.idle_remaining_seconds / 60))
      : null;
    const gpuName = String(info.gpu_name || info.gpu_tier || 'L4').replace(/^cuda:\d+\s*/i, '').replace(/\s*:.*$/, '').trim();
    const cuText = typeof info.cu_balance === 'number'
      ? ` · 余额 ${info.cu_balance.toFixed(0)} CU`
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
        tag.textContent = '唤醒中…';
      } else if (activeEndpointMode === 'sleeping') {
        tag.textContent = autoWake ? (s.enabled ? '待命·自动' : '待命') : '休眠中';
      } else {
        tag.textContent = s.enabled ? '自动:开' : '未连接';
      }
    }

    if (banner && titleEl && subEl) {
      banner.classList.remove('is-ready', 'is-booting', 'is-sleeping');
      if (activeEndpointMode === 'cloud') {
        banner.classList.add('is-ready');
        const llmTag = info.colab_llm_ready ? ' + 27B去审查' : '';
        titleEl.textContent = activeBusy
          ? '🎨 当前可以生图（正在排队绘制中）'
          : `🟢 当前可以生图 · L4${llmTag} 就绪`;
        const curEngShort = getEngineShortLabel(resolveActiveEngine(s));
        const engNote = curEngShort ? ` · MOSS ${curEngShort}` : '';
        const scheduleStr = typeof info.schedule === 'string' && info.schedule.trim() ? info.schedule.trim() : '';
        const alwaysOnSeg = scheduleStr ? scheduleStr.split(/[·•]/)[0].trim() : '07:00–02:00 全天常驻零等待';
        const modeNote = idleRemMin !== null
          ? ` · 夜间临时唤醒（约 ${idleRemMin} 分钟无操作自动休眠）`
          : ` · ${alwaysOnSeg}`;
        subEl.textContent = `${gpuName ? `显卡：${gpuName}` : '云端 L4 在线'}${engNote}${cuText}${modeNote}`;
      } else if (activeEndpointMode === 'booting') {
        banner.classList.add('is-booting');
        titleEl.textContent = '⏳ 正在自动唤醒云端 L4（约 2.5 分钟）…';
        subEl.textContent = info.phase || '正在拉起云端显卡与 MOSS-Image 模型，点画图也可直接排队等待就绪';
      } else if (activeEndpointMode === 'sleeping') {
        banner.classList.add('is-sleeping');
        titleEl.textContent = autoWake
          ? '🌙 夜间休眠省电中 · 点画图自动唤醒 L4'
          : '🌙 当前不可生图 · 云端休眠省电中';
        const sleepSchedule = (typeof info.schedule === 'string' && info.schedule.trim())
          ? info.schedule.trim()
          : '07:00–02:00 全天常驻，02:00–07:00 休眠省电';
        subEl.textContent = autoWake
          ? `${sleepSchedule}${cuText}。半夜想画直接点图自动唤醒（约 2.5 分钟）`
          : `休眠省电中${cuText}，可点下方「⚡ 提前唤醒 L4」手动开机`;
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
        wakeBtn.textContent = '⚡ 提前唤醒 L4';
      } else if (activeEndpointMode === 'booting') {
        wakeBtn.style.display = '';
        wakeBtn.disabled = true;
        wakeBtn.textContent = '⏳ L4 唤醒中…';
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

  function normalizeMediaUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^data:/i.test(s) || /^blob:/i.test(s)) return s;
    try {
      const base = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null')
        ? window.location.origin
        : 'http://localhost';
      const u = new URL(s, base);
      const pathAndQuery = `${u.pathname}${u.search}`;
      return decodeURIComponent(pathAndQuery);
    } catch {
      return s.replace(/^https?:\/\/[^/]+/i, '').split('#')[0];
    }
  }

  function escapeRegExp(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function generateImageUid() {
    return `yiyi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function generateFreshSeed(prevSeed = -1) {
    const prev = Number(prevSeed);
    let seed = Math.floor(Math.random() * 2147483646) + 1;
    if (Number.isFinite(prev) && prev > 0 && seed === prev) {
      seed = (seed % 2147483645) + 2;
    }
    return seed;
  }

  function buildMediaEntry(savedPath, info = {}) {
    const engineId = String(info.engine || getDefaultEngine()).trim();
    const width = Number(info.width) || 1024;
    const height = Number(info.height) || 1536;
    const prompt = String(info.positive || info.prompt || '').trim();
    const negative = String(info.negative || '').trim();
    const chinesePrompt = String(info.chinesePrompt || info.chinese_prompt || '').trim();
    const seed = Number.isFinite(Number(info.seed)) && Number(info.seed) > 0 ? Number(info.seed) : -1;
    const metaId = String(info.id || generateImageUid());
    return {
      url: savedPath,
      type: 'image',
      title: prompt || 'AI Illustration',
      generation_type: 'free',
      negative,
      source: 'generated',
      yiyi_meta: {
        id: metaId,
        engine: engineId,
        engine_label: getEngineDisplayLabel(engineId),
        prompt,
        negative,
        chinese_prompt: chinesePrompt,
        width,
        height,
        ratio: `${width}x${height}`,
        seed,
        style_prefix: String(info.stylePrefix || '').trim(),
        prompt_mode: String(info.promptMode || 'auto_or_tag'),
        rating_mode: String(info.ratingMode || 'unrestricted'),
        detail: {
          face_detailer: !!info.faceDetailer,
          hand_detailer: !!info.handDetailer,
          hires_fix: !!info.hiresFix,
          hires_refine: !!info.hiresRefine,
          nsfw_boost: !!info.nsfwBoost,
        },
        hires_refine: !!info.hiresRefine,
        nsfw_boost: !!info.nsfwBoost,
        created_at: new Date().toISOString(),
        version: EXT_VERSION,
      },
    };
  }

  function findMediaIndex(mes, targetRef) {
    const mediaArr = Array.isArray(mes?.extra?.media) ? mes.extra.media : [];
    if (!mediaArr.length || !targetRef) return -1;

    if (targetRef.itemRef) {
      const byRef = mediaArr.indexOf(targetRef.itemRef);
      if (byRef >= 0) return byRef;
    }

    const metaId = String(targetRef.metaId || targetRef.itemRef?.yiyi_meta?.id || '').trim();
    if (metaId) {
      const byId = mediaArr.findIndex((it) => it?.yiyi_meta?.id === metaId);
      if (byId >= 0) return byId;
    }

    const targetNorm = normalizeMediaUrl(targetRef.url);
    const idx = Number(targetRef.mediaIdx);
    if (Number.isInteger(idx) && idx >= 0 && idx < mediaArr.length) {
      if (!targetNorm || normalizeMediaUrl(mediaArr[idx]?.url) === targetNorm) {
        return idx;
      }
    }

    if (targetNorm) {
      const byUrl = mediaArr.findIndex((it) => normalizeMediaUrl(it?.url) === targetNorm);
      if (byUrl >= 0) return byUrl;
    }

    return -1;
  }

  function getUrlVariants(rawUrl) {
    const out = [];
    const pushUniq = (val) => {
      const s = String(val || '').trim();
      if (s && !out.includes(s)) out.push(s);
    };
    const rawTrim = String(rawUrl || '').trim();
    const norm = normalizeMediaUrl(rawTrim);
    const noLead = norm.replace(/^\/+/, '');
    pushUniq(rawTrim);
    pushUniq(norm);
    pushUniq(noLead);
    try {
      if (norm) pushUniq(encodeURI(norm));
      if (noLead) pushUniq(encodeURI(noLead));
    } catch {}
    return out;
  }

  function syncSwipeExtraMedia(mes, updatedMesText = false) {
    if (!mes || typeof mes !== 'object') return;
    const swipeIdx = mes.swipe_id != null ? Number(mes.swipe_id) : 0;
    if (updatedMesText && Array.isArray(mes.swipes) && Number.isInteger(swipeIdx) && swipeIdx >= 0 && swipeIdx < mes.swipes.length) {
      mes.swipes[swipeIdx] = mes.mes;
    }
    if (!Array.isArray(mes.swipe_info) || !Number.isInteger(swipeIdx) || swipeIdx < 0) return;
    const swInfo = mes.swipe_info[swipeIdx];
    if (!swInfo || typeof swInfo !== 'object') return;

    const hasMedia = Array.isArray(mes.extra?.media) && mes.extra.media.length > 0;
    const hasLegacyImg = !!(mes.extra && mes.extra.image);

    if (!swInfo.extra && (hasMedia || hasLegacyImg)) {
      swInfo.extra = {};
    }
    if (!swInfo.extra || typeof swInfo.extra !== 'object') return;

    if (hasMedia) {
      swInfo.extra.media = mes.extra.media.slice();
      swInfo.extra.media_index = mes.extra.media_index ?? 0;
      swInfo.extra.media_display = mes.extra.media_display || 'gallery';
      swInfo.extra.inline_image = !!mes.extra.inline_image;
    } else {
      delete swInfo.extra.media;
      delete swInfo.extra.media_index;
      delete swInfo.extra.media_display;
      delete swInfo.extra.inline_image;
    }

    if (hasLegacyImg) {
      swInfo.extra.image = mes.extra.image;
      if (mes.extra.title !== undefined) swInfo.extra.title = mes.extra.title;
    } else {
      delete swInfo.extra.image;
      if (mes.extra?.title === undefined && swInfo.extra.title !== undefined && !hasMedia) {
        delete swInfo.extra.title;
      }
    }
  }

  function removeInlineImageFromMesText(mes, rawUrl) {
    if (!mes || typeof mes.mes !== 'string' || !mes.mes || !rawUrl) return false;
    const variants = getUrlVariants(rawUrl);

    let text = mes.mes;
    let changed = false;
    for (const v of variants) {
      const esc = escapeRegExp(v);
      const mdRe = new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?(?:https?:\\/\\/[^)\\s]+)?\\/?${esc}>?(?:\\s+(?:"[^"]*"|'[^']*'))?\\s*\\)`, 'i');
      if (mdRe.test(text)) {
        text = text.replace(mdRe, '');
        changed = true;
        break;
      }
      const htmlRe = new RegExp(`<img\\b[^>]*\\bsrc\\s*=\\s*(?:"(?:https?:\\/\\/[^"]+)?\\/?${esc}"|'(?:https?:\\/\\/[^']+)?\\/?${esc}'|(?:https?:\\/\\/[^\\s>]+)?\\/?${esc})[^>]*\\/?>`, 'i');
      if (htmlRe.test(text)) {
        text = text.replace(htmlRe, '');
        changed = true;
        break;
      }
    }
    if (changed) {
      mes.mes = text.replace(/\n{3,}/g, '\n\n').trim();
    }
    return changed;
  }

  async function persistChat(ctx) {
    if (!ctx) return false;
    try {
      if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
        return true;
      }
      if (typeof ctx.saveChatConditional === 'function') {
        await ctx.saveChatConditional();
        return true;
      }
      if (typeof window !== 'undefined' && typeof window.saveChatConditional === 'function') {
        await window.saveChatConditional();
        return true;
      }
    } catch (err) {
      console.warn('[yiyi-st] persistChat failed:', err);
    }
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
        const imageEntries = [];
        for (let idx = 0; idx < mediaArr.length; idx++) {
          const item = mediaArr[idx];
          if (!item?.url) continue;
          if (item.type && item.type !== 'image') continue;
          imageEntries.push({ idx, item });
        }
        if (imageEntries.length > 0) {
          imageEntries.forEach(({ idx, item }, pos) => {
            items.push({
              mesId: i,
              mediaIdx: idx,
              url: item.url,
              title: String(item.title || '').trim(),
              negative: String(item.negative || '').trim(),
              charName: m.name || getActiveCharName() || '角色',
              meta: item.yiyi_meta || null,
              metaId: String(item.yiyi_meta?.id || ''),
              itemRef: item,
              floorMediaCount: imageEntries.length,
              floorMediaPos: pos + 1,
              legacySingleImage: false,
            });
          });
        } else if (m.extra?.image) {
          items.push({
            mesId: i,
            mediaIdx: 0,
            url: String(m.extra.image),
            title: String(m.extra.title || '').trim(),
            negative: '',
            charName: m.name || getActiveCharName() || '角色',
            meta: null,
            metaId: '',
            itemRef: null,
            floorMediaCount: 1,
            floorMediaPos: 1,
            legacySingleImage: true,
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

  function resetDeleteConfirmButton(btn) {
    if (!btn) return;
    const st = deleteConfirmState.get(btn);
    if (!st) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    st.armed = false;
    armedDeleteButtons.delete(btn);
    btn.classList.remove('is-confirming');
    if (st.normalLabel !== undefined) btn.textContent = st.normalLabel;
    if (st.normalTitle !== undefined) btn.title = st.normalTitle;
    if (st.cardEl) st.cardEl.classList.remove('is-confirming');
  }

  function resetAllDeleteConfirms(exceptBtn = null) {
    for (const btn of Array.from(armedDeleteButtons)) {
      if (btn !== exceptBtn) resetDeleteConfirmButton(btn);
    }
  }

  function ensureDeleteGlobalResetBound() {
    if (deleteGlobalResetBound || typeof document === 'undefined') return;
    deleteGlobalResetBound = true;
    document.addEventListener('click', (e) => {
      if (!armedDeleteButtons.size) return;
      for (const btn of Array.from(armedDeleteButtons)) {
        if (e.target !== btn && !btn.contains?.(e.target)) {
          resetDeleteConfirmButton(btn);
        }
      }
    }, true);
  }

  function armDeleteConfirmButton(btn, opts = {}) {
    if (!btn) return;
    ensureDeleteGlobalResetBound();
    const existing = deleteConfirmState.get(btn);
    if (existing) {
      existing.onConfirm = opts.onConfirm;
      existing.cardEl = opts.cardEl || null;
      if (opts.normalLabel !== undefined) existing.normalLabel = opts.normalLabel;
      if (opts.confirmLabel !== undefined) existing.confirmLabel = opts.confirmLabel;
      if (opts.normalTitle !== undefined) existing.normalTitle = opts.normalTitle;
      if (opts.confirmMs !== undefined) existing.confirmMs = opts.confirmMs;
      return;
    }
    const st = {
      armed: false,
      timer: null,
      normalLabel: opts.normalLabel ?? btn.textContent,
      confirmLabel: opts.confirmLabel ?? '确认删除？',
      normalTitle: opts.normalTitle ?? (btn.title || '删除此图'),
      confirmMs: opts.confirmMs ?? 3000,
      cardEl: opts.cardEl || null,
      onConfirm: opts.onConfirm,
    };
    deleteConfirmState.set(btn, st);
    btn.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (btn.disabled) return;
      const curSt = deleteConfirmState.get(btn);
      if (!curSt) return;
      if (!curSt.armed) {
        resetAllDeleteConfirms(btn);
        curSt.armed = true;
        armedDeleteButtons.add(btn);
        btn.classList.add('is-confirming');
        btn.textContent = curSt.confirmLabel;
        btn.title = '再次点击以永久删除此图（3秒后自动取消）';
        if (curSt.cardEl) curSt.cardEl.classList.add('is-confirming');
        curSt.timer = setTimeout(() => resetDeleteConfirmButton(btn), curSt.confirmMs);
        return;
      }
      resetDeleteConfirmButton(btn);
      if (typeof curSt.onConfirm === 'function') {
        Promise.resolve(curSt.onConfirm()).catch((err) => {
          console.error('[yiyi-st] delete failed:', err);
          toastInfo(err?.message || '删除插画失败', 'error');
        });
      }
    };
  }

  function makeTaskKey(mesId, targetRef) {
    const metaId = String(targetRef?.metaId || targetRef?.itemRef?.yiyi_meta?.id || '').trim();
    if (metaId) return `id:${mesId}:${metaId}`;
    const norm = normalizeMediaUrl(targetRef?.url);
    return `pos:${mesId}:${targetRef?.mediaIdx ?? -1}:${norm}`;
  }

  function isTargetMatchingTask(task, mesId, targetRef) {
    if (!task || Number(task.mesId) !== Number(mesId)) return false;
    const tRef = task.targetRef || {};
    if (tRef.itemRef && targetRef?.itemRef && tRef.itemRef === targetRef.itemRef) return true;
    const tId = String(tRef.metaId || tRef.itemRef?.yiyi_meta?.id || '').trim();
    const qId = String(targetRef?.metaId || targetRef?.itemRef?.yiyi_meta?.id || '').trim();
    if (tId && qId && tId === qId) return true;
    const tUrl = normalizeMediaUrl(tRef.url);
    const qUrl = normalizeMediaUrl(targetRef?.url);
    if (tUrl && qUrl && tUrl === qUrl) {
      if (tRef.mediaIdx === undefined || targetRef?.mediaIdx === undefined) return true;
      return Number(tRef.mediaIdx) === Number(targetRef.mediaIdx);
    }
    return false;
  }

  function findActiveRegenTask(mesId, targetRef) {
    for (const task of activeRegenTasks.values()) {
      if (isTargetMatchingTask(task, mesId, targetRef)) return task;
    }
    return null;
  }

  function findDirectChildByClass(container, cls) {
    if (!container?.children) return null;
    for (const child of container.children) {
      if (child?.classList?.contains?.(cls)) return child;
    }
    return null;
  }

  function upsertRegenMask(container, task) {
    if (!container || !task) return;
    let mask = findDirectChildByClass(container, 'yiyi-img-regen-mask');
    if (!mask) {
      mask = document.createElement('div');
      mask.className = 'yiyi-img-regen-mask';
      mask.innerHTML = `
        <div class="yiyi-regen-spinner"></div>
        <div class="yiyi-regen-title"></div>
        <div class="yiyi-regen-sub"></div>
        <div class="yiyi-regen-track"><div class="yiyi-regen-fill"></div></div>
        <button type="button" class="yiyi-regen-cancel">✕ 取消</button>
      `;
      container.appendChild(mask);
    }
    mask.dataset.taskKey = task.key;
    const titleEl = mask.querySelector('.yiyi-regen-title');
    const subEl = mask.querySelector('.yiyi-regen-sub');
    const fillEl = mask.querySelector('.yiyi-regen-fill');
    const cancelBtn = mask.querySelector('.yiyi-regen-cancel');
    const shortEng = getEngineShortLabel(task.engineId);
    if (titleEl) titleEl.textContent = shortEng ? `正在用 ${shortEng} 重新绘制…` : '正在重新绘制…';
    if (subEl) subEl.textContent = task.stageMsg || '准备中…';
    if (fillEl) fillEl.style.width = `${Math.max(6, Math.min(100, Number(task.pct) || 8))}%`;
    if (cancelBtn) {
      cancelBtn.onclick = (e) => {
        e.stopPropagation();
        e.preventDefault();
        cancelRegenTask(task.key);
      };
    }
  }

  function removeRegenMask(container, taskKey = null) {
    if (!container?.children) return;
    for (const child of Array.from(container.children)) {
      if (!child?.classList?.contains?.('yiyi-img-regen-mask')) continue;
      if (!taskKey || child.dataset?.taskKey === taskKey) {
        child.remove();
      }
    }
  }

  function renderRegenMasksForTask(task) {
    if (!task) return;
    const mesEl = document.querySelector(`.mes[mesid="${task.mesId}"]`);
    if (mesEl) {
      mesEl.querySelectorAll('.yiyi-img-card').forEach((card) => {
        if (isTargetMatchingTask(task, task.mesId, card._yiyiTargetRef)) {
          card.classList.add('is-regenerating');
          upsertRegenMask(card, task);
        }
      });
    }

    const viewer = document.getElementById('yiyi-overlay-viewer');
    const ovStage = document.getElementById('yiyi-ov-stage');
    if (viewer && !viewer.classList.contains('yiyi-hidden') && ovStage && ovStage._yiyiCurrentItem) {
      const cur = ovStage._yiyiCurrentItem;
      if (isTargetMatchingTask(task, cur.mesId, cur)) {
        upsertRegenMask(ovStage, task);
      }
    }

    const lb = document.getElementById('yiyi-lightbox');
    const lbStage = document.getElementById('yiyi-lb-stage');
    if (lb && !lb.classList.contains('yiyi-hidden') && lbStage && lightboxTarget) {
      if (isTargetMatchingTask(task, lightboxTarget.mesId, lightboxTarget)) {
        upsertRegenMask(lbStage, task);
      }
    }
  }

  function clearRegenMasksForTask(task) {
    if (!task) return;
    const mesEl = document.querySelector(`.mes[mesid="${task.mesId}"]`);
    if (mesEl) {
      mesEl.querySelectorAll('.yiyi-img-card').forEach((card) => {
        const mask = findDirectChildByClass(card, 'yiyi-img-regen-mask');
        if (mask && mask.dataset?.taskKey === task.key) {
          mask.remove();
          card.classList.remove('is-regenerating');
        }
      });
    }
    const ovStage = document.getElementById('yiyi-ov-stage');
    if (ovStage) removeRegenMask(ovStage, task.key);
    const lbStage = document.getElementById('yiyi-lb-stage');
    if (lbStage) removeRegenMask(lbStage, task.key);
  }

  function cancelRegenTask(taskKey, opts = {}) {
    const task = activeRegenTasks.get(taskKey);
    if (!task) return false;
    task.cancelledByUser = true;
    task.silentCancel = !!opts.silent;
    try {
      task.abortCtrl?.abort?.();
    } catch {}
    if (task.targetUrl && !opts.skipServerInterrupt) {
      const s = getSettings();
      try {
        fetch(`${task.targetUrl}/api/comfy/interrupt`, {
          method: 'POST',
          headers: buildHeaders(s),
          body: JSON.stringify({ job_id: task.jobId || '' }),
        }).catch(() => {});
      } catch {}
    }
    clearRegenMasksForTask(task);
    return true;
  }

  function renderLightbox() {
    const lb = document.getElementById('yiyi-lightbox');
    const stage = document.getElementById('yiyi-lb-stage');
    const img = document.getElementById('yiyi-lb-img');
    const metaEl = document.getElementById('yiyi-lb-meta');
    const prevBtn = document.getElementById('yiyi-lb-prev');
    const nextBtn = document.getElementById('yiyi-lb-next');
    const regenBtn = document.getElementById('yiyi-lb-regen');
    const delBtn = document.getElementById('yiyi-lb-delete');
    if (!lb || !img || !lightboxTarget) return;

    const items = collectChatIllustrations();
    let matchedIdx = -1;
    if (items.length) {
      matchedIdx = items.findIndex((it) => {
        if (lightboxTarget.itemRef && it.itemRef === lightboxTarget.itemRef) return true;
        if (lightboxTarget.metaId && it.metaId && it.metaId === lightboxTarget.metaId) return true;
        if (
          lightboxTarget.mesId !== undefined &&
          Number(it.mesId) === Number(lightboxTarget.mesId) &&
          normalizeMediaUrl(it.url) === normalizeMediaUrl(lightboxTarget.url)
        ) {
          if (lightboxTarget.mediaIdx === undefined || Number(it.mediaIdx) === Number(lightboxTarget.mediaIdx)) {
            return true;
          }
        }
        return false;
      });
      if (matchedIdx < 0 && lightboxTarget.url) {
        matchedIdx = items.findIndex((it) => normalizeMediaUrl(it.url) === normalizeMediaUrl(lightboxTarget.url));
      }
      if (matchedIdx >= 0) {
        lightboxTarget = items[matchedIdx];
      }
    }

    img.src = lightboxTarget.url;
    if (metaEl) {
      if (matchedIdx >= 0) {
        const cur = items[matchedIdx];
        const eng = cur.meta?.engine ? ` · ${getEngineShortLabel(cur.meta.engine)}` : '';
        const floorMulti = cur.floorMediaCount > 1 ? ` (图${cur.floorMediaPos}/${cur.floorMediaCount})` : '';
        metaEl.textContent = `${cur.charName} · 第 ${cur.mesId} 层${floorMulti}${eng} · ${matchedIdx + 1}/${items.length}`;
      } else if (lightboxTarget.mesId !== undefined) {
        metaEl.textContent = `第 ${lightboxTarget.mesId} 层插画`;
      } else {
        metaEl.textContent = '插画大图预览';
      }
    }

    const canNav = items.length > 1 && matchedIdx >= 0;
    if (prevBtn) prevBtn.style.display = canNav ? '' : 'none';
    if (nextBtn) nextBtn.style.display = canNav ? '' : 'none';

    const canMutate = lightboxTarget.mesId !== undefined && lightboxTarget.mesId !== null;
    if (regenBtn) {
      regenBtn.style.display = canMutate ? '' : 'none';
      const curEngLabel = getEngineDisplayLabel(resolveActiveEngine(getSettings()));
      regenBtn.title = `使用新随机种子重新生成（当前档位：${curEngLabel}）`;
    }
    if (delBtn) {
      delBtn.style.display = canMutate ? '' : 'none';
      resetDeleteConfirmButton(delBtn);
    }

    if (stage) {
      removeRegenMask(stage);
      if (canMutate) {
        const activeTask = findActiveRegenTask(lightboxTarget.mesId, lightboxTarget);
        if (activeTask) upsertRegenMask(stage, activeTask);
      }
    }
  }

  function stepLightbox(delta) {
    if (!lightboxTarget) return;
    const items = collectChatIllustrations();
    if (items.length <= 1) return;
    let curIdx = items.findIndex((it) =>
      (lightboxTarget.itemRef && it.itemRef === lightboxTarget.itemRef) ||
      (lightboxTarget.metaId && it.metaId === lightboxTarget.metaId) ||
      (Number(it.mesId) === Number(lightboxTarget.mesId) && Number(it.mediaIdx) === Number(lightboxTarget.mediaIdx))
    );
    if (curIdx < 0) curIdx = 0;
    const nextIdx = (curIdx + delta + items.length) % items.length;
    lightboxTarget = items[nextIdx];
    renderLightbox();
  }

  function openLightbox(srcOrTarget) {
    const lb = document.getElementById('yiyi-lightbox');
    const img = document.getElementById('yiyi-lb-img');
    if (!lb || !img || !srcOrTarget) return;
    if (typeof srcOrTarget === 'string') {
      const items = collectChatIllustrations();
      const found = items.find((it) => normalizeMediaUrl(it.url) === normalizeMediaUrl(srcOrTarget));
      lightboxTarget = found || { url: srcOrTarget };
    } else if (srcOrTarget && srcOrTarget.url) {
      lightboxTarget = { ...srcOrTarget };
    } else {
      return;
    }
    lb.classList.remove('yiyi-hidden');
    renderLightbox();
    syncTopLayer(lb, true, true);
  }

  function closeLightbox() {
    const lb = document.getElementById('yiyi-lightbox');
    if (!lb) return;
    const delBtn = document.getElementById('yiyi-lb-delete');
    if (delBtn) resetDeleteConfirmButton(delBtn);
    lightboxTarget = null;
    syncTopLayer(lb, false);
    lb.classList.add('yiyi-hidden');
  }

  function renderOverlayViewer(preferredMesId = null, preferredTargetRef = null) {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    const items = collectChatIllustrations();
    const titleEl = document.getElementById('yiyi-ov-title');
    const stageEl = document.getElementById('yiyi-ov-stage');
    const metaEl = document.getElementById('yiyi-ov-meta');
    const promptEl = document.getElementById('yiyi-ov-prompt-text');
    const redrawBtn = document.getElementById('yiyi-ov-redraw');
    const deleteBtn = document.getElementById('yiyi-ov-delete');
    const zoomBtn = document.getElementById('yiyi-ov-zoom');

    if (deleteBtn) resetDeleteConfirmButton(deleteBtn);

    if (!items.length) {
      overlayIndex = 0;
      if (titleEl) titleEl.textContent = '🖼️ 依依同层悬浮画框';
      if (stageEl) {
        stageEl._yiyiCurrentItem = null;
        stageEl.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'yiyi-ov-empty';
        empty.textContent = '当前对话还没有插画。\n在同层卡或伪同层界面中，直接点下方按钮或悬浮球 🖌️ 就能立即绘制并显示在这里。';
        stageEl.appendChild(empty);
      }
      if (metaEl) metaEl.textContent = '共 0 张 · 随时可生成';
      if (promptEl) promptEl.textContent = '';
      if (redrawBtn) {
        redrawBtn.dataset.mesId = '';
        redrawBtn.title = '为最新楼层生成插画';
      }
      if (deleteBtn) deleteBtn.disabled = true;
      if (zoomBtn) {
        zoomBtn.dataset.url = '';
        zoomBtn.disabled = true;
      }
      return;
    }

    if (preferredTargetRef) {
      const idx = items.findIndex((it) =>
        (preferredTargetRef.itemRef && it.itemRef === preferredTargetRef.itemRef) ||
        (preferredTargetRef.metaId && it.metaId && it.metaId === preferredTargetRef.metaId) ||
        (Number(it.mesId) === Number(preferredTargetRef.mesId) && Number(it.mediaIdx) === Number(preferredTargetRef.mediaIdx))
      );
      if (idx >= 0) overlayIndex = idx;
    } else if (preferredMesId !== null && preferredMesId !== undefined) {
      let foundIdx = -1;
      for (let i = items.length - 1; i >= 0; i--) {
        if (Number(items[i].mesId) === Number(preferredMesId)) {
          foundIdx = i;
          break;
        }
      }
      overlayIndex = foundIdx >= 0 ? foundIdx : items.length - 1;
    } else if (overlayIndex < 0 || overlayIndex >= items.length) {
      overlayIndex = Math.max(0, Math.min(overlayIndex, items.length - 1));
    }

    const cur = items[overlayIndex];
    const engShort = cur.meta?.engine ? ` · ${getEngineShortLabel(cur.meta.engine)}` : '';
    const floorSub = cur.floorMediaCount > 1 ? ` (图${cur.floorMediaPos}/${cur.floorMediaCount})` : '';
    if (titleEl) titleEl.textContent = `🖼️ ${cur.charName} · 第 ${cur.mesId} 层${floorSub}`;
    if (stageEl) {
      stageEl._yiyiCurrentItem = cur;
      stageEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = cur.url;
      img.alt = `第 ${cur.mesId} 层插画`;
      img.onclick = () => openLightbox(cur);
      stageEl.appendChild(img);
      const activeTask = findActiveRegenTask(cur.mesId, cur);
      if (activeTask) upsertRegenMask(stageEl, activeTask);
    }
    if (metaEl) metaEl.textContent = `第 ${overlayIndex + 1} / ${items.length} 张 · 第 ${cur.mesId} 层${engShort}`;
    if (promptEl) {
      const seedInfo = cur.meta?.seed > 0 ? `\n\nSeed: ${cur.meta.seed}` : '';
      const promptDisplay = cur.title
        ? `Positive:\n${cur.title}${cur.negative ? `\n\nNegative:\n${cur.negative}` : ''}${seedInfo}`
        : '（未记录提示词）';
      promptEl.value = promptDisplay;
      promptEl.textContent = promptDisplay;
    }
    if (redrawBtn) {
      redrawBtn.dataset.mesId = String(cur.mesId);
      redrawBtn.title = `原地重画当前插画（当前档位：${getEngineDisplayLabel(resolveActiveEngine(getSettings()))}）`;
    }
    if (deleteBtn) deleteBtn.disabled = false;
    if (zoomBtn) {
      zoomBtn.dataset.url = cur.url;
      zoomBtn.disabled = false;
    }
  }

  function showOverlayViewer(preferredMesId = null, preferredTargetRef = null) {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    overlayCollapsed = false;
    viewer.classList.remove('yiyi-ov-collapsed');
    viewer.classList.remove('yiyi-hidden');
    const collapseBtn = document.getElementById('yiyi-ov-collapse');
    if (collapseBtn) collapseBtn.textContent = '—';
    renderOverlayViewer(preferredMesId, preferredTargetRef);
    syncTopLayer(viewer, true, true);
    layoutResponsiveHud();
  }

  function hideOverlayViewer() {
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (!viewer) return;
    const delBtn = document.getElementById('yiyi-ov-delete');
    if (delBtn) resetDeleteConfirmButton(delBtn);
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

  function showEmptyFloorDrawBar(mesEl, mesId) {
    if (!mesEl) return;
    mesEl.querySelectorAll('.yiyi-empty-draw-bar').forEach((n) => n.remove());
    const bar = document.createElement('div');
    bar.className = 'yiyi-empty-draw-bar';
    bar.dataset.mesId = String(mesId);

    const text = document.createElement('span');
    text.textContent = '已移除本层插画';

    const drawBtn = document.createElement('button');
    drawBtn.type = 'button';
    drawBtn.className = 'yiyi-img-action-btn is-regen';
    drawBtn.textContent = '🖌️ 重新生成一张';
    drawBtn.title = '为本楼层重新绘制插画';
    drawBtn.onclick = (e) => {
      e.stopPropagation();
      bar.remove();
      illustrateFloor(mesId, true);
    };

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'yiyi-img-action-btn is-icon-only';
    dismissBtn.textContent = '✕';
    dismissBtn.title = '关闭提示（随时可点楼层右上角 🎨 再次生图）';
    dismissBtn.onclick = (e) => {
      e.stopPropagation();
      bar.remove();
    };

    bar.append(text, drawBtn, dismissBtn);
    const textEl = mesEl.querySelector('.mes_text');
    if (textEl && textEl.parentNode) {
      textEl.parentNode.insertBefore(bar, textEl.nextSibling);
    } else {
      mesEl.appendChild(bar);
    }
  }

  function syncFloorMediaDom(mesId, opts = {}) {
    const idNum = Number(mesId);
    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    const mesEl = document.querySelector(`.mes[mesid="${idNum}"]`);
    if (!mes || !mesEl) return;

    mesEl.querySelectorAll('.yiyi-empty-draw-bar').forEach((n) => n.remove());
    mesEl.querySelectorAll('.yiyi-fallback-media-list').forEach((n) => n.remove());

    const mediaArr = Array.isArray(mes.extra?.media) ? mes.extra.media : [];
    const hasImages = mediaArr.some((it) => it?.url && (!it.type || it.type === 'image')) || !!mes.extra?.image;
    const jq = window.$ || window.jQuery;

    if (typeof ctx.appendMediaToMessage === 'function' && typeof jq === 'function') {
      const mediaWrapper = mesEl.querySelector('.mes_media_wrapper');
      // Clean any stray fallback imgs outside ST's native containers
      mesEl.querySelectorAll('img.mes_img, .yiyi-img-card').forEach((node) => {
        if (!node.closest('.mes_media_wrapper') && !node.closest('.mes_img_container') && !node.closest('.mes_text')) {
          node.remove();
        }
      });

      if (hasImages) {
        // In SillyTavern v1.19+, appendMediaToMessage asynchronously populates .mes_media_wrapper
        // after image preload; do not wipe .mes_img_container beforehand to avoid white flash/height jump.
        if (!mediaWrapper) {
          mesEl.querySelectorAll('.mes_img_container').forEach((c) => {
            c.innerHTML = '';
          });
        }
        try {
          ctx.appendMediaToMessage(mes, jq(mesEl));
        } catch (err) {
          console.warn('[yiyi-st] appendMediaToMessage error:', err);
        }
        // Fallback re-enhance hooks after ST's async Promise.race completes
        setTimeout(() => enhanceFloorMediaCards(idNum), 160);
        setTimeout(() => enhanceFloorMediaCards(idNum), 450);
      } else {
        try {
          ctx.appendMediaToMessage(mes, jq(mesEl));
        } catch {}
        if (mediaWrapper) {
          // Keep .mes_media_wrapper shell intact while clearing all cloned .mes_img_container children
          mediaWrapper.innerHTML = '';
        }
        mesEl.querySelectorAll('.mes_img_container').forEach((c) => {
          c.innerHTML = '';
        });
      }
    } else {
      // Pure DOM fallback when ST's appendMediaToMessage is absent
      mesEl.querySelectorAll('img.mes_img, .yiyi-img-card').forEach((node) => {
        if (!node.closest('.mes_text')) node.remove();
      });
      if (hasImages) {
        const list = document.createElement('div');
        list.className = 'yiyi-fallback-media-list';
        if (mediaArr.length > 0) {
          mediaArr.forEach((item, idx) => {
            if (!item?.url || (item.type && item.type !== 'image')) return;
            const img = document.createElement('img');
            img.src = item.url;
            img.className = 'mes_img';
            img.dataset.yiyiMediaIdx = String(idx);
            if (item.yiyi_meta?.id) img.dataset.yiyiImgId = item.yiyi_meta.id;
            img.style.maxWidth = '100%';
            img.style.borderRadius = '8px';
            list.appendChild(img);
          });
        } else if (mes.extra?.image) {
          const img = document.createElement('img');
          img.src = mes.extra.image;
          img.className = 'mes_img';
          img.dataset.yiyiMediaIdx = '0';
          img.style.maxWidth = '100%';
          img.style.borderRadius = '8px';
          list.appendChild(img);
        }
        const textEl = mesEl.querySelector('.mes_text');
        if (textEl && textEl.parentNode) {
          textEl.parentNode.insertBefore(list, textEl.nextSibling);
        } else {
          mesEl.appendChild(list);
        }
      }
    }

    if (opts.removedInlineUrl) {
      const normRemoved = normalizeMediaUrl(opts.removedInlineUrl);
      mesEl.querySelectorAll('.mes_text img').forEach((img) => {
        if (normalizeMediaUrl(img.getAttribute('src') || img.src) === normRemoved) {
          const card = img.closest('.yiyi-img-card');
          if (card) card.remove();
          else img.remove();
        }
      });
    }

    injectFloorButton(idNum);
    if (hasImages) {
      enhanceFloorMediaCards(idNum);
    } else if (opts.showEmptyPrompt) {
      showEmptyFloorDrawBar(mesEl, idNum);
    }
  }

  function enhanceFloorMediaCards(mesId) {
    const idNum = Number(mesId);
    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    if (!mes || mes.is_user || mes.is_system) return;
    const mesEl = document.querySelector(`.mes[mesid="${idNum}"]`);
    if (!mesEl) return;

    const mediaArr = Array.isArray(mes.extra?.media) ? mes.extra.media : [];
    const imageMediaCount = mediaArr.filter((it) => it?.url && (!it.type || it.type === 'image')).length;
    const rawImgs = Array.from(
      mesEl.querySelectorAll(
        '.mes_media_wrapper img, .mes_img_container img, .mes_media_list img, .mes_media img, .yiyi-fallback-media-list img, img.mes_img, .mes_text img'
      ),
    );
    const imgs = [];
    const seenImgs = new Set();
    for (const img of rawImgs) {
      if (!img || seenImgs.has(img)) continue;
      if (img.closest('.avatar, .yiyi-img-toolbar, .yiyi-img-regen-mask')) continue;
      const src = img.getAttribute('src') || img.src || '';
      if (!src) continue;
      // For inline images inside .mes_text, strictly wrap only user-uploaded / yiyi illustrations
      // (never wrap character emojis, status-bar icons, or external decorative images).
      const inMesText = !!img.closest('.mes_text') && !img.closest('.mes_img_container') && !img.closest('.mes_media_wrapper');
      if (inMesText && !/(?:^|\/)user\/images\//i.test(src) && !src.includes('yiyi_') && !img.classList.contains('mes_img')) {
        continue;
      }
      seenImgs.add(img);
      imgs.push(img);
    }

    const usedMediaIndices = new Set();
    const activeGalleryIdx = Number(mes.extra?.media_index);

    for (const img of imgs) {
      const rawSrc = img.getAttribute('src') || img.src || '';
      const normSrc = normalizeMediaUrl(rawSrc);
      const isInlineMesImg = !!img.closest('.mes_text') && !img.closest('.mes_img_container') && !img.closest('.mes_media_wrapper');
      let matchedIdx = -1;
      let matchedItem = null;
      let legacySingleImage = false;

      if (!isInlineMesImg && mediaArr.length > 0) {
        const attrId = img.dataset?.yiyiImgId || img.closest?.('[data-yiyi-img-id]')?.dataset?.yiyiImgId || '';
        if (attrId) {
          const byId = mediaArr.findIndex((it, i) => !usedMediaIndices.has(i) && it?.yiyi_meta?.id === attrId);
          if (byId >= 0) matchedIdx = byId;
        }
        if (matchedIdx < 0) {
          const attrIdxRaw = img.dataset?.yiyiMediaIdx ?? img.closest?.('[data-index]')?.getAttribute?.('data-index');
          if (attrIdxRaw !== undefined && attrIdxRaw !== null && attrIdxRaw !== '') {
            const candIdx = Number(attrIdxRaw);
            if (
              Number.isInteger(candIdx) &&
              candIdx >= 0 &&
              candIdx < mediaArr.length &&
              !usedMediaIndices.has(candIdx) &&
              normalizeMediaUrl(mediaArr[candIdx]?.url) === normSrc
            ) {
              matchedIdx = candIdx;
            }
          }
        }
        // In ST gallery mode, only the active media_index is mounted: prioritize it when URL matches.
        if (
          matchedIdx < 0 &&
          imgs.length === 1 &&
          Number.isInteger(activeGalleryIdx) &&
          activeGalleryIdx >= 0 &&
          activeGalleryIdx < mediaArr.length &&
          normalizeMediaUrl(mediaArr[activeGalleryIdx]?.url) === normSrc
        ) {
          matchedIdx = activeGalleryIdx;
        }
        if (matchedIdx < 0) {
          matchedIdx = mediaArr.findIndex(
            (it, i) => !usedMediaIndices.has(i) && it?.url && normalizeMediaUrl(it.url) === normSrc,
          );
        }
        if (matchedIdx >= 0) {
          usedMediaIndices.add(matchedIdx);
          matchedItem = mediaArr[matchedIdx];
        }
      } else if (!isInlineMesImg && mes.extra?.image && normalizeMediaUrl(mes.extra.image) === normSrc) {
        matchedIdx = 0;
        legacySingleImage = true;
      }

      if (matchedIdx < 0 && !isInlineMesImg) continue;

      const wrapTarget = (img.parentElement && img.parentElement.tagName === 'A' && !img.parentElement.classList.contains('yiyi-img-card'))
        ? img.parentElement
        : img;

      let card = wrapTarget.parentElement?.classList?.contains('yiyi-img-card')
        ? wrapTarget.parentElement
        : null;
      if (!card) {
        card = document.createElement('div');
        card.className = 'yiyi-img-card';
        if (wrapTarget.parentNode) {
          wrapTarget.parentNode.insertBefore(card, wrapTarget);
          card.appendChild(wrapTarget);
        }
      }

      const targetRef = {
        mesId: idNum,
        mediaIdx: matchedIdx,
        url: matchedItem?.url || (legacySingleImage ? String(mes.extra.image) : rawSrc),
        meta: matchedItem?.yiyi_meta || null,
        metaId: String(matchedItem?.yiyi_meta?.id || ''),
        itemRef: matchedItem,
        title: String(matchedItem?.title || (legacySingleImage ? mes.extra?.title : '') || '').trim(),
        negative: String(matchedItem?.negative || '').trim(),
        legacySingleImage,
        isInlineMesImg,
      };

      const prevRef = card._yiyiTargetRef;
      const targetChanged = !prevRef ||
        prevRef.metaId !== targetRef.metaId ||
        prevRef.mediaIdx !== targetRef.mediaIdx ||
        normalizeMediaUrl(prevRef.url) !== normalizeMediaUrl(targetRef.url);

      card._yiyiTargetRef = targetRef;
      card.dataset.mesId = String(idNum);
      card.dataset.mediaIdx = String(matchedIdx);
      card.dataset.yiyiUrl = targetRef.url;
      if (targetRef.metaId) card.dataset.yiyiImgId = targetRef.metaId;
      else delete card.dataset.yiyiImgId;
      if (targetRef.meta?.engine) card.dataset.yiyiEngine = targetRef.meta.engine;
      else delete card.dataset.yiyiEngine;
      if (targetRef.meta?.seed > 0) card.dataset.yiyiSeed = String(targetRef.meta.seed);
      else delete card.dataset.yiyiSeed;

      let toolbar = findDirectChildByClass(card, 'yiyi-img-toolbar');
      if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'yiyi-img-toolbar';
        toolbar.innerHTML = `
          <span class="yiyi-img-badge" style="display:none"></span>
          <button type="button" class="yiyi-img-action-btn is-icon-only yiyi-act-zoom" title="大图预览">🔍</button>
          <button type="button" class="yiyi-img-action-btn is-regen yiyi-act-regen" title="使用新种子重新生成">🔄 重画</button>
          <button type="button" class="yiyi-img-action-btn is-danger yiyi-act-del" title="删除此图">🗑️ 删除</button>
        `;
        card.appendChild(toolbar);
      }

      const badgeEl = toolbar.querySelector('.yiyi-img-badge');
      const zoomBtn = toolbar.querySelector('.yiyi-act-zoom');
      const regenBtn = toolbar.querySelector('.yiyi-act-regen');
      const delBtn = toolbar.querySelector('.yiyi-act-del');

      if (targetChanged && delBtn) {
        resetDeleteConfirmButton(delBtn);
      }

      if (badgeEl) {
        const parts = [];
        if (imageMediaCount > 1 && matchedIdx >= 0) {
          let pos = 0;
          for (let k = 0; k <= matchedIdx; k++) {
            const it = mediaArr[k];
            if (it?.url && (!it.type || it.type === 'image')) pos += 1;
          }
          parts.push(`${pos}/${imageMediaCount}`);
        }
        const engShort = getEngineShortLabel(targetRef.meta?.engine);
        if (engShort) parts.push(engShort);
        if (parts.length) {
          badgeEl.textContent = parts.join(' · ');
          badgeEl.style.display = '';
        } else {
          badgeEl.textContent = '';
          badgeEl.style.display = 'none';
        }
      }

      if (zoomBtn) {
        zoomBtn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          openLightbox(card._yiyiTargetRef);
        };
      }

      if (regenBtn) {
        const curEngLabel = getEngineDisplayLabel(resolveActiveEngine(getSettings()));
        regenBtn.title = `使用新种子原地重画（当前档位：${curEngLabel}）`;
        regenBtn.onclick = (e) => {
          e.stopPropagation();
          e.preventDefault();
          regenerateImage(idNum, card._yiyiTargetRef);
        };
      }

      if (delBtn) {
        armDeleteConfirmButton(delBtn, {
          normalLabel: '🗑️ 删除',
          confirmLabel: '确认删除？',
          normalTitle: '删除此插画',
          cardEl: card,
          onConfirm: () => removeImageFromFloor(idNum, card._yiyiTargetRef),
        });
      }

      const activeTask = findActiveRegenTask(idNum, targetRef);
      if (activeTask) {
        card.classList.add('is-regenerating');
        upsertRegenMask(card, activeTask);
      } else {
        card.classList.remove('is-regenerating');
        removeRegenMask(card);
      }
    }
  }

  function enhanceAllVisibleFloorMedia() {
    document.querySelectorAll('#chat .mes[mesid]').forEach((el) => {
      const id = el.getAttribute('mesid');
      if (id !== null) enhanceFloorMediaCards(id);
    });
  }

  function scheduleFloorMediaEnhance(mesId) {
    if (mesId === null || mesId === undefined || mesId === '') return;
    pendingEnhanceMesIds.add(Number(mesId));
    if (enhanceBatchTimer) return;
    enhanceBatchTimer = setTimeout(() => {
      enhanceBatchTimer = null;
      const ids = Array.from(pendingEnhanceMesIds);
      pendingEnhanceMesIds.clear();
      for (const id of ids) {
        enhanceFloorMediaCards(id);
      }
    }, 60);
  }

  function ensureChatMediaObserver() {
    if (chatMediaObserver || typeof MutationObserver !== 'function') return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    try {
      chatMediaObserver = new MutationObserver((mutations) => {
        for (const mut of mutations) {
          const target = mut.target;
          if (!target) continue;
          if (target.closest?.('.yiyi-img-toolbar, .yiyi-img-regen-mask, .yiyi-floor-status, .yiyi-empty-draw-bar')) {
            continue;
          }
          if (mut.type === 'childList') {
            let ownOnly = true;
            for (const n of [...mut.addedNodes, ...mut.removedNodes]) {
              const cls = n?.className && typeof n.className === 'string' ? n.className : '';
              if (!cls.includes('yiyi-')) {
                ownOnly = false;
                break;
              }
            }
            if (ownOnly) continue;
          }
          const mesEl = target.closest?.('.mes[mesid]');
          if (mesEl) {
            const mid = mesEl.getAttribute('mesid');
            if (mid !== null) scheduleFloorMediaEnhance(mid);
          }
        }
      });
      chatMediaObserver.observe(chatEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      });
    } catch {}
  }

  function formatHttpErr(status, action, bodyText = '') {
    const snippet = String(bodyText || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (status === 401 || status === 403) return `${action}失败 (${status})：配置密码未填或已失效，请在悬浮窗核对密码`;
    if (status === 404) return `${action}失败 (404)：接口路径不存在，请检查地址末尾是否漏写 /yiyi-mac`;
    if (status === 429) return `${action}失败 (429)：请求太快啦，请稍等几秒再试`;
    if (status === 502 || status === 503 || status === 504) return `${action}失败 (${status})：网关或隧道暂时连不上后台渲染服务`;
    return `${action}失败 (HTTP ${status})${snippet ? `：${snippet}` : ''}`;
  }

  function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        const err = new Error('已取消生成');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('已取消生成');
        err.name = 'AbortError';
        reject(err);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener?.('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  async function uploadImageToSillyTavern(base64Data, format, chName, signal = null) {
    const ctx = getCtx();
    const headers = ctx.getRequestHeaders();
    const resp = await fetch('/api/images/upload', {
      method: 'POST',
      headers,
      signal: signal || undefined,
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

  function isUrlReferencedInChat(ctx, targetUrl) {
    const norm = normalizeMediaUrl(targetUrl);
    if (!norm) return false;
    const variants = getUrlVariants(targetUrl);
    const textContainsRef = (txt) => typeof txt === 'string' && txt.length > 0 && variants.some((v) => txt.includes(v));
    const chat = ctx?.chat || [];
    for (const m of chat) {
      if (!m || typeof m !== 'object') continue;
      if (Array.isArray(m.extra?.media)) {
        if (m.extra.media.some((it) => it?.url && normalizeMediaUrl(it.url) === norm)) return true;
      }
      if (m.extra?.image && normalizeMediaUrl(m.extra.image) === norm) return true;
      if (Array.isArray(m.swipe_info)) {
        for (const sw of m.swipe_info) {
          if (Array.isArray(sw?.extra?.media) && sw.extra.media.some((it) => it?.url && normalizeMediaUrl(it.url) === norm)) {
            return true;
          }
          if (sw?.extra?.image && normalizeMediaUrl(sw.extra.image) === norm) return true;
        }
      }
      if (textContainsRef(m.mes)) {
        return true;
      }
      if (Array.isArray(m.swipes) && m.swipes.some((swText) => textContainsRef(swText))) {
        return true;
      }
    }
    return false;
  }

  async function deleteOrphanImageFromSillyTavern(ctx, savedPath) {
    const raw = String(savedPath || '').trim();
    if (!raw || /^https?:\/\//i.test(raw) || /^data:/i.test(raw) || /^blob:/i.test(raw)) {
      return false;
    }
    if (!/(?:^|\/)user\/images\//i.test(raw) && !raw.includes('yiyi_')) {
      return false;
    }
    if (isUrlReferencedInChat(ctx, raw)) {
      return false;
    }
    if (!ctx || typeof ctx.getRequestHeaders !== 'function' || typeof fetch !== 'function') {
      return false;
    }
    try {
      const headers = Object.assign({ 'Content-Type': 'application/json' }, ctx.getRequestHeaders() || {});
      const resp = await fetch('/api/images/delete', {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: raw }),
      });
      return !!resp?.ok;
    } catch {
      return false;
    }
  }

  async function removeImageFromFloor(mesId, targetRef) {
    const idNum = Number(mesId);
    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    if (!mes) return { ok: false, reason: 'missing_message' };

    // Cancel any active regeneration task targeting this exact image first
    const runningTask = findActiveRegenTask(idNum, targetRef);
    if (runningTask) {
      cancelRegenTask(runningTask.key, { silent: true });
    }

    const hadTargetUrl = String(targetRef?.url || '').trim();
    const targetNorm = normalizeMediaUrl(hadTargetUrl);
    let removed = false;
    let removedEntry = null;
    let removedIdx = -1;
    let removedUrl = hadTargetUrl;
    let mesTextChanged = false;

    // Capture lightbox gallery index BEFORE mutating chat so deletion advances to the adjacent image
    const lbBefore = document.getElementById('yiyi-lightbox');
    const lbOpenBefore = !!(lbBefore && !lbBefore.classList.contains('yiyi-hidden') && lightboxTarget);
    let prevLbIdx = -1;
    if (lbOpenBefore) {
      const itemsBefore = collectChatIllustrations();
      prevLbIdx = itemsBefore.findIndex((it) =>
        (lightboxTarget.itemRef && it.itemRef === lightboxTarget.itemRef) ||
        (lightboxTarget.metaId && it.metaId && it.metaId === lightboxTarget.metaId) ||
        (Number(it.mesId) === Number(lightboxTarget.mesId) &&
          Number(it.mediaIdx) === Number(lightboxTarget.mediaIdx) &&
          normalizeMediaUrl(it.url) === normalizeMediaUrl(lightboxTarget.url))
      );
    }

    if (!mes.extra || typeof mes.extra !== 'object') {
      mes.extra = {};
    }

    if (Array.isArray(mes.extra.media) && mes.extra.media.length > 0 && !targetRef?.isInlineMesImg) {
      const idx = findMediaIndex(mes, targetRef);
      if (idx >= 0) {
        const [spliced] = mes.extra.media.splice(idx, 1);
        removedEntry = spliced || null;
        removedIdx = idx;
        removed = true;
        removedUrl = removedEntry?.url || removedUrl;

        if (mes.extra.media.length === 0) {
          delete mes.extra.media;
          delete mes.extra.media_index;
          delete mes.extra.media_display;
          delete mes.extra.inline_image;
        } else {
          const prevIndex = Number(mes.extra.media_index);
          if (!Number.isInteger(prevIndex) || prevIndex >= mes.extra.media.length) {
            mes.extra.media_index = mes.extra.media.length - 1;
          } else if (idx < prevIndex) {
            mes.extra.media_index = Math.max(0, prevIndex - 1);
          }
        }
      }
    }

    // Clear legacy single-image field if it points to the removed image
    if (mes.extra.image && (!targetNorm || normalizeMediaUrl(mes.extra.image) === targetNorm || targetRef?.legacySingleImage)) {
      removedUrl = String(mes.extra.image) || removedUrl;
      delete mes.extra.image;
      if (!mes.extra.media) {
        delete mes.extra.title;
      }
      removed = true;
    }

    // Also strip matching inline markdown/HTML image tag in mes.mes (handles no-leading-slash & encoded variants)
    if (removedUrl && typeof mes.mes === 'string' && mes.mes) {
      const textUpdated = removeInlineImageFromMesText(mes, removedUrl);
      if (textUpdated) {
        mesTextChanged = true;
        removed = true;
      }
    }

    if (!removed) {
      return { ok: false, reason: 'not_found' };
    }

    syncSwipeExtraMedia(mes, mesTextChanged);

    const remainingCount = Array.isArray(mes.extra?.media) ? mes.extra.media.length : (mes.extra?.image ? 1 : 0);
    syncFloorMediaDom(idNum, {
      showEmptyPrompt: remainingCount === 0,
      removedInlineUrl: mesTextChanged ? removedUrl : '',
    });

    const saved = await persistChat(ctx);
    if (removedUrl) {
      // Best-effort orphan file cleanup on SillyTavern v1.19+ (only when no other message/swipe references it)
      deleteOrphanImageFromSillyTavern(ctx, removedUrl).catch(() => {});
    }
    updateGalleryBadge();

    // Sync Overlay Viewer
    const viewer = document.getElementById('yiyi-overlay-viewer');
    if (viewer && !viewer.classList.contains('yiyi-hidden')) {
      renderOverlayViewer();
    }

    // Sync Lightbox if it was displaying this removed image
    const lb = document.getElementById('yiyi-lightbox');
    if (lb && !lb.classList.contains('yiyi-hidden') && lightboxTarget) {
      let sameLb = false;
      if (lightboxTarget.itemRef && removedEntry) {
        sameLb = lightboxTarget.itemRef === removedEntry;
      } else if (lightboxTarget.metaId && targetRef?.metaId) {
        sameLb = Number(lightboxTarget.mesId) === idNum && lightboxTarget.metaId === targetRef.metaId;
      } else {
        sameLb =
          Number(lightboxTarget.mesId) === idNum &&
          (!removedEntry || lightboxTarget.mediaIdx === undefined || Number(lightboxTarget.mediaIdx) === removedIdx) &&
          !!targetNorm &&
          normalizeMediaUrl(lightboxTarget.url) === targetNorm;
      }
      if (sameLb) {
        const allLeft = collectChatIllustrations();
        if (allLeft.length > 0) {
          const nextIdx = prevLbIdx >= 0 ? Math.min(prevLbIdx, allLeft.length - 1) : 0;
          lightboxTarget = allLeft[nextIdx];
          renderLightbox();
        } else {
          closeLightbox();
        }
      } else {
        renderLightbox();
      }
    }

    toastInfo(
      remainingCount === 0
        ? '🗑️ 已永久删除插画（随时可点楼层 🎨 或快捷按钮重新生成）'
        : '🗑️ 已从聊天记录中永久删除该插画',
      'info',
    );
    return { ok: true, remainingCount, saved, mesTextChanged };
  }

  async function attachImageToFloor(mesId, savedPath, positivePrompt, negativePrompt, metaInfo = {}) {
    const idNum = Number(mesId);
    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    const mesEl = document.querySelector(`.mes[mesid="${idNum}"]`);
    if (!mes) return null;

    if (!mes.extra || typeof mes.extra !== 'object') {
      mes.extra = {};
    }
    if (typeof ctx.ensureMessageMediaIsArray === 'function') {
      ctx.ensureMessageMediaIsArray(mes);
    }
    if (!Array.isArray(mes.extra.media)) {
      mes.extra.media = [];
    }

    const entry = buildMediaEntry(savedPath, {
      ...metaInfo,
      positive: positivePrompt,
      negative: negativePrompt,
    });
    mes.extra.media.push(entry);
    mes.extra.media_display = 'gallery';
    mes.extra.media_index = mes.extra.media.length - 1;
    mes.extra.inline_image = true;
    syncSwipeExtraMedia(mes, false);

    syncFloorMediaDom(idNum);
    await persistChat(ctx);

    updateGalleryBadge();
    const s = getSettings();
    const mode = s.overlayMode || 'auto';
    if (mode === 'always' || (mode !== 'floor_only' && isSameFloorOverlayActive(mesEl))) {
      showOverlayViewer(idNum, { mesId: idNum, itemRef: entry, metaId: entry.yiyi_meta.id });
    } else {
      const viewer = document.getElementById('yiyi-overlay-viewer');
      if (viewer && !viewer.classList.contains('yiyi-hidden')) {
        renderOverlayViewer(idNum, { mesId: idNum, itemRef: entry, metaId: entry.yiyi_meta.id });
      }
    }
    return entry;
  }

  async function buildIllustratePayload(ctx, idNum, mes, settings, regenOpts = null) {
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

    const rawFloor = typeof mes.mes === 'string' ? mes.mes : '';
    let cleanedFloor = cleanFloorForDistill(rawFloor, true) || rawFloor.trim();
    const hasOriginalFloorProse = !!cleanedFloor;
    const recentContext = recentLines.join('\n');
    const charName = mes.name || getActiveCharName();

    const oldMeta = regenOpts?.meta || null;
    const rawSavedPrompt = String(oldMeta?.prompt || regenOpts?.title || '').trim();
    const savedPrompt = rawSavedPrompt && rawSavedPrompt !== 'AI Illustration' ? rawSavedPrompt : '';
    const savedChinesePrompt = String(oldMeta?.chinese_prompt || '').trim();

    if (!cleanedFloor && savedPrompt) {
      cleanedFloor = `[IMG: ${savedPrompt}]`;
    }
    if (!cleanedFloor) {
      throw new Error('该楼层正文与提示词均为空，无法生成插画');
    }

    const lore = await collectWorldContext(ctx, idNum, mes, cleanedFloor, recentContext, settings, rawFloor);

    const [ratioWStr, ratioHStr] = (settings.ratio || '1024x1536').split('x');
    const defaultW = parseInt(ratioWStr, 10) || 1024;
    const defaultH = parseInt(ratioHStr, 10) || 1536;
    const width = (regenOpts && !regenOpts.useCurrentRatio && Number(oldMeta?.width) > 0)
      ? Number(oldMeta.width)
      : defaultW;
    const height = (regenOpts && !regenOpts.useCurrentRatio && Number(oldMeta?.height) > 0)
      ? Number(oldMeta.height)
      : defaultH;

    const reqEngine = regenOpts?.engine || resolveActiveEngine(settings);
    const prevSeed = Number(oldMeta?.seed);
    const freshSeed = generateFreshSeed(prevSeed);

    const detail = oldMeta?.detail && typeof oldMeta.detail === 'object' ? oldMeta.detail : null;
    const faceDetailer = detail ? !!detail.face_detailer : (settings.faceDetailer !== false);
    const handDetailer = detail ? !!detail.hand_detailer : (settings.handDetailer !== false);
    const hiresFix = detail ? !!detail.hires_fix : !!settings.hiresFix;
    const hiresRefine = regenOpts && typeof regenOpts.hiresRefine === 'boolean'
      ? regenOpts.hiresRefine
      : (typeof settings.hiresRefine === 'boolean' ? settings.hiresRefine : !!(oldMeta?.hires_refine ?? detail?.hires_refine));
    const nsfwBoost = regenOpts && typeof regenOpts.nsfwBoost === 'boolean'
      ? regenOpts.nsfwBoost
      : (typeof settings.nsfwBoost === 'boolean' ? settings.nsfwBoost : !!(oldMeta?.nsfw_boost ?? detail?.nsfw_boost));
    const stylePrefix = (oldMeta && typeof oldMeta.style_prefix === 'string' && oldMeta.style_prefix.trim())
      ? oldMeta.style_prefix.trim()
      : (settings.stylePrefix || '').trim();
    const promptMode = regenOpts
      ? ((settings.promptMode === 'tag_only' && !/\[IMG\s*:|<img_prompt>/i.test(cleanedFloor)) ? 'auto_or_tag' : (settings.promptMode || 'auto_or_tag'))
      : (settings.promptMode || 'auto_or_tag');
    const ratingMode = oldMeta?.rating_mode || settings.ratingMode || 'unrestricted';

    const payload = {
      floor_text: cleanedFloor,
      recent_context: recentContext,
      char_name: charName,
      char_appearance: '',
      style_prefix: stylePrefix,
      world_mode: true,
      world_context: '',
      memory_context: lore.memoryContext,
      prev_visual_prompt: lore.prevVisualPrompt,
      matched_characters: '',
      user_name: lore.userName,
      user_appearance: lore.userAppearance,
      prompt_mode: promptMode,
      engine: reqEngine,
      rating_mode: ratingMode,
      width,
      height,
      steps: 0,
      cfg: 0,
      seed: freshSeed,
      face_detailer: faceDetailer,
      hand_detailer: handDetailer,
      hires_fix: hiresFix,
      hires_refine: hiresRefine,
      nsfw_boost: nsfwBoost,
      return_base64: true,
      image_format: 'webp',
    };

    if (regenOpts) {
      payload.regenerate = true;
      payload.force_new_seed = true;
      payload.prefer_floor_text = hasOriginalFloorProse;
      if (Number.isFinite(prevSeed) && prevSeed > 0) payload.prev_seed = prevSeed;
      if (savedPrompt) payload.saved_prompt = savedPrompt;
      if (savedChinesePrompt && !hasOriginalFloorProse) payload.chinese_prompt = savedChinesePrompt;
    }

    return {
      payload,
      charName,
      metaSeed: {
        engine: reqEngine,
        width,
        height,
        seed: freshSeed,
        stylePrefix,
        promptMode,
        ratingMode,
        faceDetailer,
        handDetailer,
        hiresFix,
        hiresRefine,
        nsfwBoost,
        chinesePrompt: savedChinesePrompt,
      },
    };
  }

  async function executeIllustrateRequest({
    targetUrl,
    settings,
    payload,
    charName,
    signal = null,
    onProgress = null,
    onJobStarted = null,
  }) {
    const startResp = await fetch(`${targetUrl}/api/st/illustrate/start`, {
      method: 'POST',
      headers: buildHeaders(settings),
      signal: signal || undefined,
      body: JSON.stringify(payload),
    });
    if (!startResp.ok) {
      const errBody = await startResp.text().catch(() => '');
      throw new Error(formatHttpErr(startResp.status, '启动生图任务', errBody));
    }
    const { job_id } = await startResp.json();
    onJobStarted?.(job_id);

    // Poll job state cleanly (tolerates up to 4 transient mobile/Cloudflare blips & 15 min total for auto-wake)
    let jobData = null;
    let transientErrors = 0;
    const deadline = Date.now() + 900000;
    while (Date.now() < deadline) {
      await sleepWithSignal(1100, signal);
      let jr;
      try {
        jr = await fetch(`${targetUrl}/api/jobs/${job_id}`, {
          method: 'GET',
          headers: buildHeaders(settings),
          signal: signal || undefined,
        });
      } catch (netErr) {
        if (netErr?.name === 'AbortError' || signal?.aborted) throw netErr;
        transientErrors += 1;
        if (transientErrors > 3) {
          throw new Error(`查询生图进度中断：${netErr?.message || '网络连接断开'}`);
        }
        await sleepWithSignal(1200, signal);
        continue;
      }
      if (!jr.ok) {
        if (jr.status === 502 || jr.status === 503 || jr.status === 504) {
          transientErrors += 1;
          if (transientErrors <= 3) {
            await sleepWithSignal(1200, signal);
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
      onProgress?.(msg, pct);
    }

    if (!jobData || jobData.status !== 'done') {
      throw new Error('生成超时（超过 15 分钟未完成），请检查服务端状态或切到「⚡ 快速出图」档位');
    }

    const res = jobData.extra_result || {};
    if (res.skipped) {
      return { skipped: true, res };
    }
    if (!res.image_base64) {
      throw new Error('未收到图像数据');
    }

    if (signal?.aborted) {
      const err = new Error('已取消生成');
      err.name = 'AbortError';
      throw err;
    }

    onProgress?.('正在保存到酒馆楼层…', 97);
    const savedPath = await uploadImageToSillyTavern(
      res.image_base64,
      res.image_format || 'webp',
      charName,
      signal,
    );
    return { skipped: false, savedPath, res };
  }

  async function regenerateImage(mesId, targetRef, opts = {}) {
    const idNum = Number(mesId);
    const ctx = getCtx();
    const mes = ctx?.chat?.[idNum];
    if (!mes || mes.is_user || mes.is_system) {
      return { ok: false, reason: 'invalid_message' };
    }

    const existingTask = findActiveRegenTask(idNum, targetRef);
    if (existingTask) {
      toastInfo('这张插画正在重新绘制中，请稍候或点遮罩上的取消按钮~', 'info');
      return { ok: false, reason: 'already_running' };
    }

    // Resolve live item snapshot (without mutating anything yet!)
    let liveIdx = -1;
    let liveItem = null;
    if (!targetRef?.isInlineMesImg && Array.isArray(mes.extra?.media)) {
      liveIdx = findMediaIndex(mes, targetRef);
      if (liveIdx >= 0) liveItem = mes.extra.media[liveIdx];
    }
    const isLegacySingle = !liveItem && !targetRef?.isInlineMesImg && !!mes.extra?.image;
    const isInlineImg = !!targetRef?.isInlineMesImg;
    if (!liveItem && !isLegacySingle && !isInlineImg) {
      toastInfo('未找到要重画的目标图片，请刷新页面后重试', 'warning');
      return { ok: false, reason: 'target_not_found' };
    }

    const resolvedRef = {
      mesId: idNum,
      mediaIdx: liveIdx >= 0 ? liveIdx : (targetRef?.mediaIdx ?? 0),
      url: liveItem?.url || (isLegacySingle ? String(mes.extra.image) : String(targetRef?.url || '')),
      meta: liveItem?.yiyi_meta || targetRef?.meta || null,
      metaId: String(liveItem?.yiyi_meta?.id || targetRef?.metaId || ''),
      itemRef: liveItem || targetRef?.itemRef || null,
      title: String(liveItem?.title || targetRef?.title || (isLegacySingle ? mes.extra?.title : '') || '').trim(),
      legacySingleImage: isLegacySingle,
      isInlineMesImg: isInlineImg,
    };

    const s = getSettings();
    const reqEngine = opts.engine || resolveActiveEngine(s);
    const origSwipeId = mes.swipe_id != null ? Number(mes.swipe_id) : 0;
    const taskKey = makeTaskKey(idNum, resolvedRef);
    const abortCtrl = typeof AbortController === 'function' ? new AbortController() : { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
    const task = {
      key: taskKey,
      mesId: idNum,
      origSwipeId,
      targetRef: resolvedRef,
      abortCtrl,
      jobId: '',
      targetUrl: '',
      engineId: reqEngine,
      stageMsg: '正在连接云端生图服务…',
      pct: 6,
      cancelledByUser: false,
      silentCancel: false,
    };
    activeRegenTasks.set(taskKey, task);
    renderRegenMasksForTask(task);

    try {
      const conn = await resolveStudioUrl();
      if (abortCtrl.signal.aborted) {
        const err = new Error('已取消生成');
        err.name = 'AbortError';
        throw err;
      }

      const canAutoWake = !conn?.ok && (conn?.reason === 'sleeping' || conn?.reason === 'booting') && !!activeGatewayUrl && conn?.data?.auto_wake !== false;
      const targetUrl = conn?.ok ? activeStudioUrl : (canAutoWake ? activeGatewayUrl : null);

      if (!targetUrl) {
        const target = conn?.url ? ` [${conn.url}]` : '';
        throw new Error(`${conn?.detail || '暂未连上云端生图服务，请检查网络与服务状态'}${target}`);
      }
      task.targetUrl = targetUrl;

      const initMsg = canAutoWake
        ? '⚡ 正在自动唤醒云端 GPU（约 2.5 分钟）…'
        : '正在提取剧情特征并分配新随机种子…';
      task.stageMsg = initMsg;
      task.pct = 10;
      renderRegenMasksForTask(task);
      setGlobalProgress(initMsg, 10, false);

      const { payload, charName, metaSeed } = await buildIllustratePayload(ctx, idNum, mes, s, {
        meta: resolvedRef.meta,
        title: resolvedRef.title,
        engine: reqEngine,
        useCurrentRatio: !!opts.useCurrentRatio,
        hiresRefine: typeof opts.hiresRefine === 'boolean' ? opts.hiresRefine : undefined,
        nsfwBoost: typeof opts.nsfwBoost === 'boolean' ? opts.nsfwBoost : undefined,
      });

      if (abortCtrl.signal.aborted) {
        const err = new Error('已取消生成');
        err.name = 'AbortError';
        throw err;
      }

      const execRes = await executeIllustrateRequest({
        targetUrl,
        settings: s,
        payload,
        charName,
        signal: abortCtrl.signal,
        onJobStarted: (jid) => {
          task.jobId = jid;
        },
        onProgress: (msg, pct) => {
          task.stageMsg = msg;
          task.pct = pct;
          renderRegenMasksForTask(task);
          setGlobalProgress(msg, pct, false);
        },
      });

      if (abortCtrl.signal.aborted) {
        const err = new Error('已取消生成');
        err.name = 'AbortError';
        throw err;
      }

      if (execRes.skipped) {
        throw new Error('后端跳过绘制，已保留原图');
      }

      const res = execRes.res || {};
      const newEntry = buildMediaEntry(execRes.savedPath, {
        ...metaSeed,
        engine: res.engine || metaSeed.engine,
        positive: res.positive || resolvedRef.title || '',
        negative: res.negative || '',
        chinesePrompt: res.chinese_prompt || metaSeed.chinesePrompt || '',
        seed: Number(res.seed) > 0 ? Number(res.seed) : metaSeed.seed,
      });

      // Atomic safe replacement: only after upload succeeded, verify swipe unchanged & locate live index
      // (protects against swipe switching or concurrent deletion of another image in the same floor!)
      const curSwipeId = mes.swipe_id != null ? Number(mes.swipe_id) : 0;
      if (curSwipeId !== origSwipeId) {
        return { ok: false, cancelled: true, reason: 'swiped_during_regen' };
      }
      if (!mes.extra || typeof mes.extra !== 'object') mes.extra = {};
      let mesTextChanged = false;
      let replacedIdx = -1;

      if (isInlineImg) {
        mesTextChanged = removeInlineImageFromMesText(mes, resolvedRef.url);
        if (!Array.isArray(mes.extra.media)) mes.extra.media = [];
        mes.extra.media.push(newEntry);
        replacedIdx = mes.extra.media.length - 1;
        mes.extra.media_display = 'gallery';
        mes.extra.media_index = replacedIdx;
        mes.extra.inline_image = true;
      } else if (Array.isArray(mes.extra.media) && mes.extra.media.length > 0) {
        const commitIdx = findMediaIndex(mes, resolvedRef);
        if (commitIdx < 0) {
          // The original image was deleted while regenerating — do not resurrect it
          return { ok: false, reason: 'target_deleted_during_regen' };
        }
        mes.extra.media[commitIdx] = newEntry;
        mes.extra.media_index = commitIdx;
        mes.extra.media_display = mes.extra.media_display || 'gallery';
        mes.extra.inline_image = true;
        replacedIdx = commitIdx;
      } else if (isLegacySingle && mes.extra.image) {
        delete mes.extra.image;
        delete mes.extra.title;
        mes.extra.media = [newEntry];
        mes.extra.media_display = 'gallery';
        mes.extra.media_index = 0;
        mes.extra.inline_image = true;
        replacedIdx = 0;
      } else {
        return { ok: false, reason: 'target_deleted_during_regen' };
      }

      syncSwipeExtraMedia(mes, mesTextChanged);
      activeRegenTasks.delete(taskKey);
      clearRegenMasksForTask(task);

      syncFloorMediaDom(idNum, { removedInlineUrl: mesTextChanged ? resolvedRef.url : '' });
      await persistChat(ctx);
      if (resolvedRef.url && normalizeMediaUrl(resolvedRef.url) !== normalizeMediaUrl(newEntry.url)) {
        // Best-effort cleanup of replaced orphan image on SillyTavern disk (only if unreferenced elsewhere)
        deleteOrphanImageFromSillyTavern(ctx, resolvedRef.url).catch(() => {});
      }
      updateGalleryBadge();

      const newRef = {
        mesId: idNum,
        mediaIdx: replacedIdx,
        url: newEntry.url,
        meta: newEntry.yiyi_meta,
        metaId: newEntry.yiyi_meta.id,
        itemRef: newEntry,
      };

      const viewer = document.getElementById('yiyi-overlay-viewer');
      if (viewer && !viewer.classList.contains('yiyi-hidden')) {
        renderOverlayViewer(idNum, newRef);
      }

      const lb = document.getElementById('yiyi-lightbox');
      if (lb && !lb.classList.contains('yiyi-hidden') && lightboxTarget) {
        if (isTargetMatchingTask(task, lightboxTarget.mesId, lightboxTarget)) {
          lightboxTarget = newRef;
        }
        renderLightbox();
      }

      const engName = getEngineShortLabel(newEntry.yiyi_meta.engine) || newEntry.yiyi_meta.engine;
      const elapsedSuffix = res.elapsed ? ` (${res.elapsed}s)` : '';
      toastInfo(`✨ 已用 ${engName} 重新生成并替换插画${elapsedSuffix}`, 'success');
      return { ok: true, entry: newEntry, index: replacedIdx };
    } catch (err) {
      const isCancelled = err?.name === 'AbortError' || task.cancelledByUser || abortCtrl.signal.aborted;
      if (isCancelled) {
        if (!task.silentCancel) {
          toastInfo('已取消重新生成，已保留原图', 'info');
        }
        return { ok: false, cancelled: true };
      }
      console.error('[yiyi-st] regenerateImage failed:', err);
      toastInfo(`重新生成失败（已保留原图）：${err?.message || '未知错误'}`, 'error');
      return { ok: false, error: err?.message || String(err) };
    } finally {
      activeRegenTasks.delete(taskKey);
      clearRegenMasksForTask(task);
      if (runningFloorIds.size === 0 && activeRegenTasks.size === 0) {
        clearGlobalProgress();
      }
      resolveStudioUrl().catch(() => {});
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
      const canAutoWake = !conn?.ok && (conn?.reason === 'sleeping' || conn?.reason === 'booting') && !!activeGatewayUrl && conn?.data?.auto_wake !== false;
      const targetUrl = conn?.ok ? activeStudioUrl : (canAutoWake ? activeGatewayUrl : null);

      if (!targetUrl) {
        const showErr = isManual || conn?.reason === 'auth_error' || conn?.reason === 'mixed_content' || !s.silentOffline;
        if (showErr) {
          const target = conn?.url ? ` [${conn.url}]` : '';
          toastInfo(
            `${conn?.detail || '暂未连上云端生图服务，请检查网络与服务状态'}${target}`,
            conn?.reason === 'auth_error' ? 'error' : 'warning',
          );
        }
        return;
      }

      const showFloat = s.overlayMode === 'always' || !mesEl || isSameFloorOverlayActive(mesEl);
      const initMsg = canAutoWake
        ? '⚡ 云端休眠中，正在自动唤醒 L4（约 2.5 分钟）后为您绘制…'
        : '正在提取记忆与剧情画面特征…';
      if (mesEl) setFloorStatus(mesEl, initMsg, 8);
      setGlobalProgress(initMsg, 8, showFloat);
      if (canAutoWake && isManual) {
        toastInfo('⚡ 正在自动唤醒云端 L4（约 2.5 分钟），就绪后自动出图，30 分钟不用自动关停~', 'info');
      }

      const { payload, charName, metaSeed } = await buildIllustratePayload(ctx, idNum, mes, s, null);

      const execRes = await executeIllustrateRequest({
        targetUrl,
        settings: s,
        payload,
        charName,
        onProgress: (msg, pct) => {
          if (mesEl) setFloorStatus(mesEl, msg, pct);
          setGlobalProgress(msg, pct, showFloat);
        },
      });

      if (execRes.skipped) {
        if (isManual) toastInfo('当前设置仅识别 [IMG] 标签，本楼层未包含该标签', 'info');
        return;
      }

      const res = execRes.res || {};
      await attachImageToFloor(idNum, execRes.savedPath, res.positive, res.negative, {
        ...metaSeed,
        engine: res.engine || metaSeed.engine,
        chinesePrompt: res.chinese_prompt || '',
        seed: Number(res.seed) > 0 ? Number(res.seed) : metaSeed.seed,
      });
      if (isManual) toastInfo(`插画已生成 (${res.elapsed || ''}s)`, 'success');
    } catch (err) {
      console.error('[yiyi-st]', err);
      toastInfo(err.message || '生图失败', 'error');
    } finally {
      runningFloorIds.delete(idNum);
      if (mesEl) removeFloorStatus(mesEl);
      if (runningFloorIds.size === 0 && activeRegenTasks.size === 0) {
        clearGlobalProgress();
      }
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
      if (id !== null) {
        injectFloorButton(id);
        enhanceFloorMediaCards(id);
      }
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
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <div id="yiyi-can-draw-title" style="font-weight:700">正在检查云端生图状态…</div>
            <button type="button" class="yiyi-close-btn" id="yiyi-btn-test" title="刷新云端状态" style="flex-shrink:0">↻</button>
          </div>
          <div id="yiyi-can-draw-sub" style="font-size:11px;opacity:.88">正在读取 MOSS-Image 云端状态…</div>
        </div>

        <label class="yiyi-switch-row">
          <strong>楼层生成自动插画</strong>
          <input type="checkbox" id="yiyi-opt-enabled" />
        </label>

        <button class="yiyi-btn yiyi-btn-primary" id="yiyi-btn-draw-last">🖌️ 为最新楼层立即画一张</button>

        <div class="yiyi-field" id="yiyi-engine-field">
          <label>MOSS-Image 出图档位</label>
          <div class="yiyi-mode-segment" id="yiyi-opt-engine" role="radiogroup" aria-label="MOSS-Image 出图档位"></div>
          <div class="yiyi-hint" id="yiyi-engine-desc" style="display:none"></div>
        </div>

        <div class="yiyi-field">
          <label>默认画幅（单步原生高清）</label>
          <select id="yiyi-opt-ratio">
            <option value="1024x1536">竖图 1024×1536（推荐）</option>
            <option value="1344x896">横图 1344×896（双人/场景）</option>
            <option value="1280x1280">方图 1280×1280</option>
            <option value="896x1344">极速竖图 896×1344</option>
          </select>
        </div>

        <div class="yiyi-toggle-grid">
          <label class="yiyi-toggle-chip" title="启用 ScaleROPE 1.5× 印刷级二阶段超分精修（耗时较长）">
            <input type="checkbox" id="yiyi-opt-hires-refine" />
            <span>✨ 1.5× 超分精修</span>
          </label>
          <label class="yiyi-toggle-chip" title="叠挂 MOSS 无审查成人细节 LoRA（默认已无审查，显式特化按需开启）">
            <input type="checkbox" id="yiyi-opt-nsfw-boost" />
            <span>🔥 成人细节增强</span>
          </label>
        </div>

        <div class="yiyi-cloud-actions">
          <button type="button" class="yiyi-btn" id="yiyi-btn-open-studio">🎨 独立远程生图页</button>
          <button type="button" class="yiyi-btn" id="yiyi-btn-update">🔄 更新 (v${EXT_VERSION})</button>
        </div>

        <details class="yiyi-adv-details" id="yiyi-adv-details">
          <summary>⚙️ 高级画面选项与连接密码</summary>
          <div style="display:flex;flex-direction:column;gap:7px">
            <div class="yiyi-field">
              <label>触发方式</label>
              <select id="yiyi-opt-prompt-mode">
                <option value="auto_or_tag">原生直出（有[IMG]用标签/无则直读中文剧情）</option>
                <option value="tag_only">仅识别楼层 [IMG:...] 标签</option>
              </select>
            </div>
            <div class="yiyi-field">
              <label>全局画风偏好（可选，留空完全跟随正文画风）</label>
              <input type="text" id="yiyi-opt-style" placeholder="留空完全跟随正文，或填：电影胶片真人摄影 / 日系厚涂插画" />
            </div>
            <div class="yiyi-field">
              <label>剧情记忆与人物一致性（正文优先）</label>
              <select id="yiyi-opt-memory-mode">
                <option value="smart">智能外貌补充（仅正文未写外貌时补齐固定发色瞳色，绝不覆盖当前衣着与事件）</option>
                <option value="story_only">仅前文固定外貌补全（不读世界书与记忆插件）</option>
                <option value="off">纯当前楼层正文（零历史记忆）</option>
              </select>
            </div>
            <div class="yiyi-field">
              <label>同层卡 / 伪同层展示方式</label>
              <select id="yiyi-opt-overlay-mode">
                <option value="auto">智能同层适配 (同层卡自动弹悬浮画框)</option>
                <option value="always">始终弹出悬浮画框</option>
                <option value="floor_only">仅挂载到楼层</option>
              </select>
            </div>
            <label class="yiyi-check-row"><input type="checkbox" id="yiyi-opt-skip-first" /> 跳过开场白（第0层不自动画）</label>
            <div class="yiyi-field">
              <label>云端网关地址（已内置）</label>
              <input type="text" id="yiyi-opt-mac-url" placeholder="https://draw.fzy.asia/yiyi-mac" />
            </div>
            <div class="yiyi-field">
              <label>访问密码</label>
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
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-redraw" title="使用新种子原地重画当前图">🔄</button>
          <button type="button" class="yiyi-ov-icon-btn" id="yiyi-ov-delete" title="删除当前插画">🗑️</button>
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
      <div class="yiyi-lb-stage" id="yiyi-lb-stage">
        <img id="yiyi-lb-img" alt="插画预览" />
      </div>
      <div class="yiyi-lb-bar" id="yiyi-lb-bar">
        <div class="yiyi-lb-nav-group">
          <button type="button" class="yiyi-img-action-btn is-icon-only" id="yiyi-lb-prev" title="上一张 (←)">◀</button>
          <button type="button" class="yiyi-img-action-btn is-icon-only" id="yiyi-lb-next" title="下一张 (→)">▶</button>
        </div>
        <span class="yiyi-lb-meta" id="yiyi-lb-meta">插画大图预览</span>
        <div class="yiyi-lb-act-group">
          <button type="button" class="yiyi-img-action-btn is-regen" id="yiyi-lb-regen" title="使用新种子重新生成">🔄 重新生成</button>
          <button type="button" class="yiyi-img-action-btn is-danger" id="yiyi-lb-delete" title="删除此插画">🗑️ 删除</button>
        </div>
      </div>
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
          const gpu = String(res.data?.gpu_name || res.data?.gpu_tier || 'L4').replace(/^cuda:\d+\s*/i, '').replace(/\s*:.*$/, '').trim();
          const rem = typeof res.data?.idle_remaining_seconds === 'number'
            ? `，无操作约 ${Math.max(1, Math.ceil(res.data.idle_remaining_seconds / 60))} 分钟后自动休眠`
            : '';
          toastInfo(`🟢 当前可以生图！（${gpu} 已就绪${rem}）`, 'success');
        } else if (res?.reason === 'sleeping') {
          toastInfo('⚡ 云端待命省电中（0 计费）：直接点画图就会自动唤醒 L4（约 2.5 分钟），30 分钟不用自动关停！', 'info');
        } else if (res?.reason === 'booting') {
          toastInfo('⏳ 云端 L4 正在自动唤醒中，直接点画图也可排队等待就绪~', 'info');
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
    const ovDelete = document.getElementById('yiyi-ov-delete');
    const ovZoom = document.getElementById('yiyi-ov-zoom');
    const ovCollapse = document.getElementById('yiyi-ov-collapse');
    const ovClose = document.getElementById('yiyi-ov-close');
    const ovDrawLast = document.getElementById('yiyi-ov-draw-last');
    const lbClose = document.getElementById('yiyi-lb-close');
    const lbPrev = document.getElementById('yiyi-lb-prev');
    const lbNext = document.getElementById('yiyi-lb-next');
    const lbRegen = document.getElementById('yiyi-lb-regen');
    const lbDelete = document.getElementById('yiyi-lb-delete');

    if (ovPrev) ovPrev.onclick = () => stepOverlay(-1);
    if (ovNext) ovNext.onclick = () => stepOverlay(1);
    if (ovRedraw) {
      ovRedraw.onclick = () => {
        const cur = document.getElementById('yiyi-ov-stage')?._yiyiCurrentItem;
        if (cur) {
          regenerateImage(cur.mesId, cur);
        } else {
          drawLatestFloor();
        }
      };
    }
    if (ovDelete) {
      armDeleteConfirmButton(ovDelete, {
        normalLabel: '🗑️',
        confirmLabel: '确认?',
        normalTitle: '删除当前插画',
        onConfirm: () => {
          const cur = document.getElementById('yiyi-ov-stage')?._yiyiCurrentItem;
          if (cur) return removeImageFromFloor(cur.mesId, cur);
        },
      });
    }
    if (ovZoom) {
      ovZoom.onclick = () => {
        const cur = document.getElementById('yiyi-ov-stage')?._yiyiCurrentItem;
        if (cur) openLightbox(cur);
        else if (ovZoom.dataset?.url) openLightbox(ovZoom.dataset.url);
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
    if (lbPrev) lbPrev.onclick = (e) => { e.stopPropagation(); stepLightbox(-1); };
    if (lbNext) lbNext.onclick = (e) => { e.stopPropagation(); stepLightbox(1); };
    if (lbRegen) {
      lbRegen.onclick = (e) => {
        e.stopPropagation();
        if (lightboxTarget && lightboxTarget.mesId !== undefined) {
          regenerateImage(lightboxTarget.mesId, lightboxTarget);
        }
      };
    }
    if (lbDelete) {
      armDeleteConfirmButton(lbDelete, {
        normalLabel: '🗑️ 删除',
        confirmLabel: '确认删除？',
        normalTitle: '删除此插画',
        onConfirm: () => {
          if (lightboxTarget && lightboxTarget.mesId !== undefined) {
            return removeImageFromFloor(lightboxTarget.mesId, lightboxTarget);
          }
        },
      });
    }
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', (e) => {
      if (lightbox.classList.contains('yiyi-hidden')) return;
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        stepLightbox(-1);
      } else if (e.key === 'ArrowRight') {
        stepLightbox(1);
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
    bindVal('yiyi-opt-hires-refine', 'hiresRefine', true);
    bindVal('yiyi-opt-nsfw-boost', 'nsfwBoost', true);
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

    syncEngineSelectorUi();
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
    syncEngineSelectorUi();
    setVal('yiyi-opt-enabled', s.enabled, true);
    setVal('yiyi-opt-hires-refine', s.hiresRefine, true);
    setVal('yiyi-opt-nsfw-boost', s.nsfwBoost, true);
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
        ensureChatMediaObserver();
        injectAllVisibleFloorButtons();
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
      enhanceFloorMediaCards(idNum);
      const s = getSettings();
      if (s.enabled && pendingAutoIds.has(idNum)) {
        pendingAutoIds.delete(idNum);
        illustrateFloor(idNum, false);
      }
    });

    if (eventTypes.MESSAGE_UPDATED) {
      eventSource.on(eventTypes.MESSAGE_UPDATED, (mesId) => {
        const idNum = Number(mesId);
        injectFloorButton(idNum);
        scheduleFloorMediaEnhance(idNum);
        updateGalleryBadge();
      });
    }

    if (eventTypes.MESSAGE_SWIPED) {
      eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
        const idNum = Number(mesId);
        // Cancel any active regeneration targeting this floor so it never writes into the new swipe
        for (const task of Array.from(activeRegenTasks.values())) {
          if (Number(task.mesId) === idNum) {
            cancelRegenTask(task.key, { silent: true });
          }
        }
        setTimeout(() => {
          injectFloorButton(idNum);
          enhanceFloorMediaCards(idNum);
          updateGalleryBadge();
          const viewer = document.getElementById('yiyi-overlay-viewer');
          if (viewer && !viewer.classList.contains('yiyi-hidden')) {
            renderOverlayViewer();
          }
        }, 60);
      });
    }

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
      pendingAutoIds.clear();
      for (const task of Array.from(activeRegenTasks.values())) {
        cancelRegenTask(task.key, { silent: true, skipServerInterrupt: true });
      }
      closeLightbox();
      setTimeout(() => {
        ensureChatMediaObserver();
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
    const rawEngineStr = typeof existingRaw?.engine === 'string' ? existingRaw.engine.trim() : '';
    const migratedEngine = migrateEngineId(rawEngineStr);
    const shouldPersistMigration = !!existingRaw && (
      !prevMacNorm ||
      prevMacNorm === '/yiyi-mac' ||
      existingRaw.backendPolicy !== 'mac' ||
      !rawEngineStr ||
      rawEngineStr !== migratedEngine
    );
    getSettings();
    if (shouldPersistMigration) {
      saveSettings();
    }
    buildFloatingUi();
    registerEvents();
    ensureChatMediaObserver();
    injectAllVisibleFloorButtons();
    updateGalleryBadge();
    promoteHudAbovePopovers();
    setTimeout(promoteHudAbovePopovers, 800);
    setTimeout(() => checkExtensionUpdate({ silent: true }).catch(() => {}), 2000);
    resolveStudioUrl().catch(() => {});
  }

  if (typeof globalThis !== 'undefined' && globalThis.__YIYI_ST_TEST_HOOK__) {
    globalThis.__YIYI_ST_TEST_API__ = {
      getSettings,
      migrateEngineId,
      selectCloudEngine,
      syncEnginesFromPing,
      resolveActiveEngine,
      getDefaultEngine,
      getEngineDisplayLabel,
      getEngineShortLabel,
      cleanFloorForDistill,
      analyzeFloorVisualCoverage,
      extractPermanentAppearance,
      collectChatStoryTraits,
      collectWorldContext,
      normalizeMediaUrl,
      generateFreshSeed,
      buildMediaEntry,
      findMediaIndex,
      syncSwipeExtraMedia,
      removeInlineImageFromMesText,
      isUrlReferencedInChat,
      deleteOrphanImageFromSillyTavern,
      persistChat,
      collectChatIllustrations,
      armDeleteConfirmButton,
      resetDeleteConfirmButton,
      resetAllDeleteConfirms,
      syncFloorMediaDom,
      enhanceFloorMediaCards,
      removeImageFromFloor,
      attachImageToFloor,
      buildIllustratePayload,
      regenerateImage,
      cancelRegenTask,
      illustrateFloor,
      openLightbox,
      closeLightbox,
      stepLightbox,
      renderLightbox,
      showOverlayViewer,
      hideOverlayViewer,
      renderOverlayViewer,
      init,
      _state: {
        getRuntimeEngines: () => runtimeCloudEngines.slice(),
        getActiveRegenTasks: () => activeRegenTasks,
        getLightboxTarget: () => lightboxTarget,
      },
    };
  }

  if (typeof globalThis !== 'undefined' && globalThis.__YIYI_ST_TEST_NO_AUTO_INIT__) {
    return;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
