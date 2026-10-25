'use strict';
// The hand-written htm parser as it was before templates were compiled once
// (index.html parsed every template string on every call). Kept verbatim as
// the reference for tests/htm-compile-cache.test.js, which checks that the
// compile-once parser produces exactly the same h() calls for every
// html`...` template in index.html.
module.exports = function makeReferenceHtm() {
  var window = {};
(function(g) {
  var HOLE = '\0';
  g.htm = function(statics) {
    var fields = [];
    for (var a = 1; a < arguments.length; a++) fields.push(arguments[a]);
    var h = this;
    var tpl = statics[0];
    for (var a = 1; a < statics.length; a++) tpl += HOLE + (a-1) + HOLE + statics[a];
    var i = 0, len = tpl.length;
    function readHole() {
      i++;
      var n = '';
      while (tpl[i] !== HOLE) n += tpl[i++];
      i++;
      return fields[parseInt(n)];
    }
    function ws() { while (i < len && (tpl[i] === ' ' || tpl[i] === '\t' || tpl[i] === '\n' || tpl[i] === '\r')) i++; }
    // Elements whose *direct* children the HTML table/select algorithms
    // treat specially: a text node there that is only inter-element
    // formatting whitespace (no visible content) is never meaningful and
    // real browsers drop/foster-parent it. Since the JSX whitespace rule
    // (below) now preserves same-line whitespace-only chunks instead of
    // trimming everything, a same-line space between e.g. `<tr> <td>` or
    // `<select> <option>` would otherwise become a stray text child - so
    // for these parents specifically, a whitespace-only chunk (regardless
    // of newlines) is dropped rather than pushed as a child.
    var WS_ONLY_DROP_PARENTS = { table: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, select: 1, optgroup: 1 };
    function parseChildren(parentTag) {
      var ch = [];
      var dropWsOnly = parentTag && WS_ONLY_DROP_PARENTS[parentTag];
      while (i < len) {
        if (tpl[i] === '<') {
          if (tpl[i+1] === '/') { while (i < len && tpl[i] !== '>') i++; i++; return ch; }
          if (tpl[i+1] === '!' && tpl[i+2] === '-' && tpl[i+3] === '-') { while (i < len && !(tpl[i] === '-' && tpl[i+1] === '-' && tpl[i+2] === '>')) i++; i+=3; continue; }
          i++;
          ch.push(parseElement());
        } else if (tpl[i] === HOLE) {
          var v = readHole();
          if (Array.isArray(v)) { for (var x = 0; x < v.length; x++) if (v[x] != null && v[x] !== false) ch.push(v[x]); }
          else if (v != null && v !== false && v !== true) ch.push(v);
        } else {
          var txt = '';
          while (i < len && tpl[i] !== '<' && tpl[i] !== HOLE) txt += tpl[i++];
          if (dropWsOnly && /^\s*$/.test(txt)) continue;
          // JSX whitespace semantics, not naive trim: only whitespace runs
          // that contain a newline are collapsed/dropped. A same-line run
          // of spaces/tabs (e.g. between a hole and a tag, or two holes)
          // is preserved as-is, so `${a} ${b}` keeps its separating space.
          txt = txt.replace(/^[ \t]*\r?\n\s*/, '');
          txt = txt.replace(/\s*\r?\n[ \t]*$/, '');
          txt = txt.replace(/[ \t]*\r?\n\s*/g, ' ');
          if (txt) ch.push(txt);
        }
      }
      return ch;
    }
    function parseElement() {
      ws();
      var tag;
      if (tpl[i] === HOLE) { tag = readHole(); }
      else { tag = ''; while (i < len && tpl[i] !== ' ' && tpl[i] !== '>' && tpl[i] !== '/' && tpl[i] !== '\n' && tpl[i] !== '\t' && tpl[i] !== '\r') tag += tpl[i++]; }
      var props = null;
      ws();
      while (i < len && tpl[i] !== '>' && !(tpl[i] === '/' && (i+1 >= len || tpl[i+1] === '>'))) {
        ws();
        if (i >= len || tpl[i] === '>' || (tpl[i] === '/' && (i+1 >= len || tpl[i+1] === '>'))) break;
        if (tpl[i] === '.' && tpl[i+1] === '.' && tpl[i+2] === '.') { i += 3; if (tpl[i] === HOLE) props = Object.assign(props || {}, readHole()); ws(); continue; }
        var name = '';
        while (i < len && tpl[i] !== '=' && tpl[i] !== ' ' && tpl[i] !== '>' && tpl[i] !== '/' && tpl[i] !== '\n' && tpl[i] !== '\t' && tpl[i] !== '\r' && tpl[i] !== HOLE) name += tpl[i++];
        if (!name) { i++; continue; }
        if (tpl[i] === '=') {
          i++;
          var val;
          if (tpl[i] === HOLE) { val = readHole(); }
          else if (tpl[i] === '"' || tpl[i] === "'") { var q = tpl[i++]; val = ''; while (i < len && tpl[i] !== q) { if (tpl[i] === HOLE) val += readHole(); else val += tpl[i++]; } i++; }
          else { val = ''; while (i < len && tpl[i] !== ' ' && tpl[i] !== '>' && tpl[i] !== '/') val += tpl[i++]; }
          props = props || {};
          props[name] = val;
        } else { props = props || {}; props[name] = true; }
        ws();
      }
      var selfClose = false;
      if (tpl[i] === '/') { i++; selfClose = true; }
      if (tpl[i] === '>') i++;
      var children = selfClose ? [] : parseChildren(typeof tag === 'string' ? tag : null);
      var args = [tag, props];
      for (var c = 0; c < children.length; c++) args.push(children[c]);
      return h.apply(null, args);
    }
    var result = parseChildren();
    return result.length === 1 ? result[0] : result.length === 0 ? null : result;
  };
})(window);
  return window.htm;
};
