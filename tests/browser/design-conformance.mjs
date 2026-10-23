#!/usr/bin/env node
// Headless DESIGN.md conformance check. Loads the generated federation
// (tests/fixtures/generate-building-ifc.js — architecture + structure + MEP,
// IfcSite in NL), opens every main surface in light, dark and a 390 px phone,
// and asserts on the RENDERED page (computed styles, not source text):
//   clipped        text cut off by its own box or a clipping ancestor
//                  (ellipsis is allowed only with a title, and never on a
//                  control — see truncated-label)
//   truncated-label  a button/tab/link whose label is cut off with an
//                  ellipsis, or a label that reads like a fragment ("ion…")
//   colour         a computed text / background / border colour that is not
//                  the value of a design token in the active theme (the 3D
//                  canvas, pictures and data swatches [data-cc-swatch] are
//                  content, not chrome)
//   type-scale     font-size not on the --text-* scale
//   leading        line-height not normal / 1 / --leading-*
//   spacing        padding / margin / gap not on the --space-* scale
//                  (≤ 2 px optical nudges allowed)
//   radius         border-radius not on the --radius-* scale (or 50 %)
//   caps           ALL-CAPS text that is not the documented section label
//                  (--text-xs / bold / .08em) or a .cc-status-pill
//   status-colour  a status token (--color-success/warning/danger/info,
//                  --pill-*, --sev-*) on something that is not a status:
//                  .cc-status-pill, role=status/alert or [data-cc-status]
//                  (a destructive button may use the danger tokens — S_BTN Danger)
//   tap-target     a control under 44 × 44 px on the phone viewport
//   overflow       horizontal scroll on the page or a panel root
//   overlap        a control's content spilling out of its box, or two
//                  controls drawn on top of each other
//   untranslated   (non-English locale) common English UI words on controls
//                  and headings — a mixed-language UI
//   diagnostics    "No diagnostics in the main UI": percentages, IFC class
//                  names, file sizes / timings in the model card and the
//                  inspector
// Writes per-surface screenshots and a JSON report to $CC_DESIGN_OUT
// (default <os.tmpdir()>/cc-design-conformance). Exit 1 on any violation.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/design-conformance.mjs
//   CC_DESIGN_LOCALE=nl-NL (default) | en-GB — browser language (auto-detected UI language)
//   CC_DESIGN_ONLY=desktop|mobile|desktop-light,... — run only these variants (prefix match)
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const OUT = process.env.CC_DESIGN_OUT || join(tmpdir(), 'cc-design-conformance');
const LOCALE = process.env.CC_DESIGN_LOCALE || 'nl-NL';
const ONLY = process.env.CC_DESIGN_ONLY || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of ['architecture', 'structure', 'mep']) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const pageErrors = [];
const report = { locale: LOCALE, surfaces: [], totals: {} };

// ── the in-page checker ───────────────────────────────────────────────
function inPageChecker() {
  const TEXT_PX = [11, 12, 13, 14, 15, 17, 20, 24];
  const SPACE_PX = [0, 4, 8, 12, 16, 20, 24, 32];
  const RADIUS_PX = [0, 4, 6, 8, 12, 16];
  const LEADING = [1, 1.25, 1.45, 1.6];
  const near = (v, list, eps) => list.some((x) => Math.abs(v - x) <= eps);
  const px = (s) => parseFloat(s) || 0;
  function tokenColours() {
    const names = new Set();
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (!r.style || !r.selectorText) continue;
        if (!/^(:root|\[data-theme=["']?dark["']?\])$/.test(r.selectorText.trim())) continue;
        for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith('--')) names.add(r.style[i]);
      }
    }
    const probe = document.createElement('i');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const out = new Set(['rgba(0, 0, 0, 0)', 'rgb(255, 255, 255)']);
    for (const n of names) {
      probe.style.color = ''; probe.style.color = 'var(' + n + ')';
      const c = getComputedStyle(probe).color;
      if (c && probe.style.color) out.add(c);
    }
    probe.remove();
    return out;
  }
  function label(el) {
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 4; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase();
      for (const a of e.getAttributeNames()) if (a.startsWith('data-cc') || a === 'role' || a === 'aria-label') { s += '[' + a + (e.getAttribute(a) && e.getAttribute(a).length < 30 ? '="' + e.getAttribute(a) + '"' : '') + ']'; break; }
      if (e.classList.length && /^cc-/.test(e.classList[0])) s += '.' + e.classList[0];
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return true;
  }
  function exempt(el) {
    return !!el.closest('canvas,svg,img,video,picture,option,[data-cc-swatch],[data-cc-design-exempt],.cc-sr-only,.cc-snap-img');
  }
  function clipAncestor(el) {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a);
      const scroll = /(auto|scroll)/.test(cs.overflowX + cs.overflowY);
      if (scroll) return null; // content may legitimately be scrolled out of view
      if (/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) return a;
    }
    return null;
  }
  function textRect(el) {
    const rg = document.createRange();
    let r = null;
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      rg.selectNodeContents(n);
      const b = rg.getBoundingClientRect();
      if (!r) r = { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
      else { r.top = Math.min(r.top, b.top); r.bottom = Math.max(r.bottom, b.bottom); r.left = Math.min(r.left, b.left); r.right = Math.max(r.right, b.right); }
    }
    return r;
  }
  const CONTROL = 'button,[role=button],[role=tab],[role=menuitem],[role=switch],a[href],summary,select';
  return function check(selectors, opts) {
    opts = opts || {};
    const allowed = tokenColours();
    const out = [];
    const add = (rule, el, detail) => out.push({ rule, el: label(el), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 60), detail });
    const roots = selectors.flatMap((s) => [...document.querySelectorAll(s)]).filter(visible);
    const seen = new Set();
    for (const rootEl of roots) {
      if (opts.overflowRoots !== false && rootEl.scrollWidth > rootEl.clientWidth + 1 && !/(auto|scroll)/.test(getComputedStyle(rootEl).overflowX)) add('overflow', rootEl, rootEl.scrollWidth + ' > ' + rootEl.clientWidth);
      for (const el of [rootEl, ...rootEl.querySelectorAll('*')]) {
        if (seen.has(el)) continue; seen.add(el);
        if (!visible(el) || exempt(el)) continue;
        const cs = getComputedStyle(el);
        const txt = ownText(el);
        // colour
        if (txt && !allowed.has(cs.color)) add('colour', el, 'color ' + cs.color);
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && !allowed.has(cs.backgroundColor)) add('colour', el, 'background ' + cs.backgroundColor);
        for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
          if (px(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none' && !allowed.has(cs['border' + side + 'Color'])) { add('colour', el, 'border-' + side.toLowerCase() + ' ' + cs['border' + side + 'Color']); break; }
        }
        // status colour only on real status (pill / live region / marked status)
        const inl = el.getAttribute('style') || '';
        const destructive = el.matches('button,[role=menuitem]') && /^(?:(?!var\(--color-(success|warning|info)).)*var\(--color-danger/.test(inl) && !/var\(--color-(success|warning|info)/.test(inl);
        if (/var\(--(color-(success|warning|danger|info)|pill-|sev-|progress-)/.test(inl) && !destructive && !el.closest('.cc-status-pill,[role=status],[role=alert],[data-cc-status]')) add('status-colour', el, (inl.match(/var\(--(color-[a-z-]+|pill-[a-z-]+|sev-[a-z-]+|progress-[a-z-]+)\)/) || [])[0]);
        // type scale + leading (elements that render text; UA-styled toggles excluded)
        const uaControl = el.matches('input[type=checkbox],input[type=radio],input[type=color],input[type=range],input[type=file]');
        if (!uaControl && (txt || el.matches('input,textarea,select'))) {
          const fs = px(cs.fontSize);
          if (!near(fs, TEXT_PX, 0.15)) add('type-scale', el, 'font-size ' + cs.fontSize);
          if (txt && cs.lineHeight !== 'normal' && !near(px(cs.lineHeight) / fs, LEADING, 0.03)) add('leading', el, 'line-height ' + cs.lineHeight + ' (' + (px(cs.lineHeight) / fs).toFixed(2) + ')');
        }
        // spacing
        const sp = [];
        for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'marginTop', 'marginBottom']) { const v = Math.abs(px(cs[k])); if (v > 2.01 && !near(v, SPACE_PX, 0.3)) sp.push(k + ' ' + cs[k]); }
        const ml = Math.abs(px(cs.marginLeft)), mr = Math.abs(px(cs.marginRight));
        if (!(el.style.margin && /auto/.test(el.style.margin)) && !(el.style.marginLeft === 'auto' || el.style.marginRight === 'auto')) {
          if (ml > 2.01 && !near(ml, SPACE_PX, 0.3)) sp.push('marginLeft ' + cs.marginLeft);
          if (mr > 2.01 && !near(mr, SPACE_PX, 0.3)) sp.push('marginRight ' + cs.marginRight);
        }
        for (const k of ['rowGap', 'columnGap']) { if (cs[k] === 'normal') continue; const v = px(cs[k]); if (v > 2.01 && !near(v, SPACE_PX, 0.3)) sp.push(k + ' ' + cs[k]); }
        if (sp.length && !uaControl) add('spacing', el, sp.join(', '));
        // radius
        for (const k of ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius']) {
          const v = cs[k];
          if (/%/.test(v)) { if (px(v) !== 50) { add('radius', el, k + ' ' + v); break; } continue; }
          const n = px(v);
          if (n >= 999 || near(n, RADIUS_PX, 0.3)) continue;
          // a pill radius computes to half the height when the box is small
          if (n * 2 >= el.getBoundingClientRect().height - 1 && n > 16) continue;
          add('radius', el, k + ' ' + v); break;
        }
        // caps
        if (txt && /[a-z]/i.test(txt) && cs.textTransform === 'uppercase') {
          const fs = px(cs.fontSize), ls = px(cs.letterSpacing), w = +cs.fontWeight;
          const sectionLabel = Math.abs(fs - 12) < 0.2 && w >= 700 && Math.abs(ls - 0.96) < 0.1;
          const pill = el.closest('.cc-status-pill') && Math.abs(fs - 11) < 0.2 && w >= 600;
          if (!sectionLabel && !pill && !el.closest('kbd')) add('caps', el, fs + 'px / ' + w + ' / ' + cs.letterSpacing);
        }
        // clipped text
        if (txt && !el.matches('input,textarea,select')) {
          const ctrl = el.closest(CONTROL);
          const hidX = /(hidden|clip)/.test(cs.overflowX), hidY = /(hidden|clip)/.test(cs.overflowY);
          if (hidX && el.scrollWidth > el.clientWidth + 1) {
            if (ctrl) add('truncated-label', el, 'label cut off (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
            else if (!(cs.textOverflow === 'ellipsis' && el.closest('[title]'))) add('clipped', el, 'text cut off horizontally (' + el.scrollWidth + ' > ' + el.clientWidth + ')');
          }
          if (hidY && el.scrollHeight > el.clientHeight + 2 && !(cs.webkitLineClamp && cs.webkitLineClamp !== 'none' && el.closest('[title]'))) add('clipped', el, 'text cut off vertically (' + el.scrollHeight + ' > ' + el.clientHeight + ')');
          const anc = clipAncestor(el), tr = textRect(el);
          if (anc && tr) {
            const ar = anc.getBoundingClientRect();
            if (tr.bottom > ar.bottom + 2 || tr.top < ar.top - 2) add('clipped', el, 'text outside its clipping box vertically');
            else if (cs.textOverflow !== 'ellipsis' && (tr.right > ar.right + 2 || tr.left < ar.left - 2) && getComputedStyle(anc).textOverflow !== 'ellipsis') add('clipped', el, 'text outside its clipping box horizontally');
          }
        }
        if (el.matches(CONTROL)) {
          const lab = (el.innerText || '').trim();
          if (/^[^\s…]{1,8}…$/.test(lab)) add('truncated-label', el, 'label reads like a fragment');
          if (opts.mobile) {
            const r = el.getBoundingClientRect();
            if (r.height < 43.5 || r.width < 43.5) add('tap-target', el, Math.round(r.width) + '×' + Math.round(r.height));
          }
        }
        if (opts.mobile && el.matches('input:not([type=hidden]),textarea') && !el.closest('label')) {
          const r = el.getBoundingClientRect();
          if (r.height < 43.5) add('tap-target', el, Math.round(r.width) + '×' + Math.round(r.height));
        }
        if (opts.mobile && el.matches('label') && el.querySelector('input[type=checkbox],input[type=radio]')) {
          const r = el.getBoundingClientRect();
          if (r.height < 43.5) add('tap-target', el, Math.round(r.width) + '×' + Math.round(r.height));
        }
        // untranslated chrome: with a non-English UI, a control or heading
        // that still carries common English UI words is a mixed-language UI.
        // Data (names in a [title], clash cards, [data-cc-data]) is exempt;
        // words that are also plain Dutch ("details", "model") are not listed.
        if (opts.uiLang && txt && el.matches('button,[role=tab],[role=menuitem],summary,label,th,h1,h2,h3,h4,legend,[role=status]') && !el.closest('[data-cc-card-idx],[data-cc-data]') && el.getAttribute('title') !== txt) {
          const hit = txt.match(/\b(the|and|show|hide|all on|all off|add|clear|run|export|import|settings|remove|close|save|load|select|none|levels?|rules|view|from|with|not drawn|use|enter|more|less|reset|apply|cancel|delete|edit|warnings?|search|placement)\b/i);
          if (hit) add('untranslated', el, 'English word "' + hit[0] + '" in a ' + opts.uiLang + ' UI');
        }
        // diagnostics in the default model card / inspector
        if (txt && el.closest('[data-cc-plain]')) {
          if (/\d\s?%|\bIfc[A-Z][A-Za-z]+|\b\d+(\.\d+)?\s?(MB|KB|GB)\b|\b\d+\.\d+\s?s\b|\b\d+\s?meshes\b/.test(txt) || /\b(stated|inferred|provenance|confidence|evidence)\b/i.test(txt)) add('diagnostics', el, txt.slice(0, 80));
        }
      }
    }
    // overlap: a control whose content spills out of its own box (a label
    // wider than a squeezed toolbar button), or two controls in the same row
    // drawn on top of each other. Controls of different layers (a menu or
    // popover over the list) are compared only within their own parent, and
    // the content of a closed <details> is not rendered.
    const ctrls = [...seen].filter((el) => el.matches && el.matches(CONTROL) && visible(el) && !exempt(el) && !el.closest('details:not([open]) > :not(summary)'));
    const rects = ctrls.map((el) => el.getBoundingClientRect());
    ctrls.forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (!/(hidden|clip|auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 2 && !el.matches('select')) add('overlap', el, 'content ' + el.scrollWidth + ' > box ' + el.clientWidth);
      for (let j = i + 1; j < ctrls.length; j++) {
        if (ctrls[j].parentElement !== el.parentElement) continue;
        const a = rects[i], b = rects[j];
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 2 && getComputedStyle(ctrls[j]).position !== 'absolute' && cs.position !== 'absolute') add('overlap', el, 'overlaps ' + label(ctrls[j]).split(' > ').pop() + ' "' + (ctrls[j].innerText || '').trim().slice(0, 30) + '"');
      }
    });
    if (document.scrollingElement.scrollWidth > innerWidth + 1) out.push({ rule: 'overflow', el: 'page', text: '', detail: 'page scrolls sideways ' + document.scrollingElement.scrollWidth + ' > ' + innerWidth });
    return out;
  };
}

async function newPage(viewport, theme) {
  const ctx = await browser.newContext({ viewport, locale: LOCALE, deviceScaleFactor: 1 });
  await ctx.addInitScript(([th]) => {
    try {
      localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1');
      localStorage.setItem('cc_theme', th); localStorage.setItem('cc_welcome_seen', '1'); localStorage.setItem('cc_tour_done', '1');
    } catch (e) {}
  }, [theme]);
  await ctx.addInitScript(`window.__ccDesignCheck = (${inPageChecker.toString()})();`);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    const local = async (route, f, ct) => route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', f)), headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' } });
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1]; await local(route, 'three/' + s); });
    await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; await local(route, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await ctx.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccClashSnapshots, null, { timeout: 60_000 });
  return page;
}
async function load(page) {
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch('/__gen/' + n)).arrayBuffer()], n)));
    window.ClashControl.loadFiles(fs);
  }, [gen.fileNames.architecture, gen.fileNames.structure, gen.fileNames.mep]);
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length === 3 && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false; }, null, { timeout: 240_000, polling: 500 });
  // A loader report like a real file can have (synthetic: the fixture draws everything).
  await page.evaluate(() => {
    const m = window._ccLatestState.models[0];
    window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: {
      loaderWarnings: [{ code: 'boundaries-unplaced', message: 'Space boundaries could not be placed' }],
      stats: Object.assign({}, m.stats, { notDrawn: { total: 10, byReason: { transparent: 6, empty: 4 }, byType: { IfcSlab: 6, IfcSpace: 4 } } }),
    } });
  });
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function surface(page, variant, name, selectors, opts) {
  await pause(350);
  // let hover/press transitions settle (a colour mid-transition is not a token)
  await page.evaluate(() => Promise.race([Promise.all(document.getAnimations().filter((a) => { const t = a.effect && a.effect.getTiming && a.effect.getTiming(); return !(t && t.iterations === Infinity); }).map((a) => a.finished.catch(() => {}))), new Promise((r) => setTimeout(r, 1500))]));
  const v = await page.evaluate(([sel, o]) => window.__ccDesignCheck(sel, o), [selectors, opts || {}]);
  const shot = join(OUT, variant + '-' + name + '.png');
  await page.screenshot({ path: shot });
  const byRule = {};
  v.forEach((x) => { byRule[x.rule] = (byRule[x.rule] || 0) + 1; report.totals[x.rule] = (report.totals[x.rule] || 0) + 1; });
  report.surfaces.push({ variant, name, count: v.length, byRule, shot, violations: v });
  console.log((v.length ? 'DESIGN FAIL ' : 'DESIGN OK   ') + variant + ' / ' + name + ': ' + v.length + (v.length ? ' ' + JSON.stringify(byRule) : ''));
}

async function pickElement(page, pred) {
  return page.evaluate(async (src) => {
    const f = new Function('e', 'return (' + src + ')(e);');
    for (const m of window._ccLatestState.models) {
      const e = m.elements.find((x) => x.props && f(x));
      if (!e) continue;
      const sel = { expressId: e.expressId, modelId: m.id, props: e.props, modelName: m.name };
      Object.defineProperty(window, '_ccSelectedEl', { get: () => sel, set: () => {}, configurable: true });
      window.dispatchEvent(new Event('cc-element-selected'));
      await new Promise((r) => setTimeout(r, 700));
      return e.props.ifcType;
    }
    return null;
  }, pred.toString());
}

async function runVariant(variant, viewport, theme, mobile) {
  const page = await newPage(viewport, theme);
  const o = { mobile, uiLang: /^en/i.test(LOCALE) ? '' : LOCALE };
  await load(page);
  const LEFT = mobile ? ['.cc-left-panel', '.cc-mobile-nav', '.cc-header'] : ['.cc-left-panel', '.cc-desktop-topbar', '.cc-top-toolbar', '.cc-left-rail'];
  const MODELS = mobile ? LEFT : LEFT.concat(['.cc-ai-panel']);
  // top bar / toolbars in each workspace
  for (const ws of ['present', 'review', 'coordinate']) {
    await page.evaluate((w) => { window._ccDispatch({ t: 'SET_WORKSPACE', v: w }); window._ccDispatch({ t: 'TAB', v: null }); }, ws);
    await surface(page, variant, 'workspace-' + ws, mobile ? ['.cc-header', '.cc-mobile-nav'] : ['.cc-desktop-topbar', '.cc-top-toolbar', '.cc-left-rail', '.cc-overlay-top'], o);
  }
  // project switcher (where the header shows it)
  const projBtn = await page.$('.cc-header-project > button');
  if (projBtn && await projBtn.isVisible()) {
    await projBtn.click();
    await surface(page, variant, 'project-menu', ['.cc-header-project'], Object.assign({}, o, { overflowRoots: false }));
    await projBtn.click();
  }
  // models panel: cards (one expanded) + geo placement
  await page.evaluate(() => window._ccDispatch({ t: 'SET_WORKSPACE', v: 'coordinate' }));
  await page.evaluate((m) => { if (!m && window._ccOpenModelsPanel) { window._ccDispatch({ t: 'TAB', v: null }); window._ccOpenModelsPanel(); } else window._ccDispatch({ t: 'TAB', v: 'models' }); }, mobile);
  await surface(page, variant, 'models', MODELS, o);
  await page.evaluate(() => { const b = document.querySelector('[data-cc-model-card] [data-cc-card-toggle]') || [...document.querySelectorAll('.cc-left-panel button,.cc-side-panel button')].find((x) => x.textContent.trim() === '▼'); if (b) b.click(); });
  await surface(page, variant, 'model-card-open', MODELS, o);
  await page.evaluate(() => { const g = document.querySelector('[data-cc-geo]') || [...document.querySelectorAll('span')].find((x) => /^(geo placement|geo-plaatsing|locatie)$/i.test(x.textContent.trim())); if (g) g.scrollIntoView(); });
  await surface(page, variant, 'geo', MODELS, o);
  // a site location that is an authoring-tool default, not the building
  await page.evaluate(() => {
    const m = window._ccLatestState.models[0], sh = JSON.parse(JSON.stringify(m.spatialHierarchy || {}));
    (sh.sites || []).forEach((s) => { s.georef = Object.assign({}, s.georef, { refLat: 0, refLon: 0 }); });
    window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { spatialHierarchy: sh } });
  });
  await page.evaluate(() => { const g = document.querySelector('[data-cc-geo]') || [...document.querySelectorAll('span')].find((x) => /^(geo placement|geo-plaatsing|locatie)$/i.test(x.textContent.trim())); if (g) g.scrollIntoView(); });
  await surface(page, variant, 'geo-default-site', MODELS, o);
  // pre-run panel
  await page.evaluate(() => { window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: false } }); window._ccRunDetectionInteractive(); });
  const pre = await page.waitForSelector('[data-cc-prerun]', { timeout: 15_000 }).catch(() => null);
  if (pre) {
    await surface(page, variant, 'pre-run', ['[data-cc-prerun]'], o);
    await page.click('[data-cc-prerun-run]');
  }
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && !s.detecting && s.runHistory.length > 0; }, null, { timeout: 240_000, polling: 200 });
  // clash sidebar (list), run details + list actions menu
  await page.evaluate(() => { window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } }); window._ccDispatch({ t: 'TAB', v: 'clashes' }); });
  await surface(page, variant, 'clash-list', LEFT, o);
  await page.evaluate(() => { const d = document.querySelector('[data-cc-run-details]'); if (d) d.open = true; const b = document.querySelector('[data-cc-list-actions]'); if (b) b.click(); });
  await surface(page, variant, 'clash-list-menu', LEFT, o);
  await page.keyboard.press('Escape');
  // review overview + Filters popover
  await page.evaluate(() => window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'overview' } }));
  await page.waitForSelector('[data-cc-overview]', { timeout: 10_000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelectorAll('[data-cc-overview] [data-cc-snapshot]').length >= 1, null, { timeout: 30_000 }).catch(() => {});
  await surface(page, variant, 'overview', ['[data-cc-overview]'], o);
  await page.evaluate(() => { const b = document.querySelector('[data-cc-overview] [data-cc-filters-toggle]'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); });
  await surface(page, variant, 'overview-filters', ['[data-cc-overview]', '[data-cc-facets-pop]'], o);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list' } }));
  // inspector for several element types
  if (!mobile) {
    for (const [nm, pred] of [['inspector-covering', (e) => e.props.ifcType === 'IfcCovering'], ['inspector-duct', (e) => /Duct/.test(e.props.ifcType)], ['inspector-space', (e) => e.props.ifcType === 'IfcSpace'], ['inspector-wall', (e) => /IfcWall/.test(e.props.ifcType)]]) {
      const t = await pickElement(page, pred);
      if (t) await surface(page, variant, nm, ['.cc-ai-panel'], o);
    }
    await page.evaluate(() => { delete window._ccSelectedEl; window._ccSelectedEl = null; });
  }
  // data quality + accessibility
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'dataquality' }));
  await surface(page, variant, 'data-quality', LEFT, o);
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'accessibility' }));
  await surface(page, variant, 'accessibility', LEFT, o);
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: null }));
  // settings, every tab
  await page.evaluate(() => window._ccDispatch({ t: 'SETTINGS', v: true }));
  await page.waitForSelector('[role=dialog] [role=tablist]', { timeout: 5000 }).catch(() => {});
  const tabs = await page.evaluate(() => [...document.querySelectorAll('[role=dialog] [role=tablist] [role=tab]')].length);
  for (let i = 0; i < tabs; i++) {
    await page.evaluate((k) => document.querySelectorAll('[role=dialog] [role=tablist] [role=tab]')[k].click(), i);
    await surface(page, variant, 'settings-' + i, ['[role=dialog]'], o);
  }
  await page.context().close();
}

await mkdir(OUT, { recursive: true });
try {
  const VARIANTS = [['desktop-light', { width: 1440, height: 900 }, 'light', false], ['desktop-dark', { width: 1440, height: 900 }, 'dark', false],
    ['mobile-light', { width: 390, height: 844 }, 'light', true], ['mobile-dark', { width: 390, height: 844 }, 'dark', true]];
  for (const v of VARIANTS) if (!ONLY || ONLY.split(',').some((o) => v[0].indexOf(o) === 0)) await runVariant(...v);
} catch (e) {
  report.harnessError = String(e && e.stack || e);
  console.error('DESIGN harness: ' + report.harnessError);
} finally {
  await browser.close();
  server.close();
}
report.pageErrors = pageErrors;
await writeFile(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const total = report.surfaces.reduce((a, s) => a + s.count, 0);
console.log('DESIGN totals ' + JSON.stringify(report.totals) + ' — report: ' + join(OUT, 'report.json'));
if (total || report.harnessError || pageErrors.length) { console.error('DESIGN CONFORMANCE: ' + total + ' violation(s)' + (pageErrors.length ? ', page errors: ' + pageErrors.slice(0, 3).join(' | ') : '')); process.exit(1); }
console.log('DESIGN CONFORMANCE OK');
