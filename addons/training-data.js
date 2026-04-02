// ── ClashControl Addon: Training Data ─────────────────────────
// Pure data functions for clash & NL training data storage,
// export (JSONL), and sharing. No UI — the Training Pill and
// Training Mode Popup stay in index.html.

(function() {
  'use strict';

  var _CLASH_TRAIN_CAP = 5000;
  var _NL_TRAIN_CAP = 2000;
  var _AI_VERDICT_MAP = {open:'unreviewed', confirmed:'true_clash', denied:'false_positive', in_progress:'true_clash', resolved:'acceptable', closed:'false_positive'};

  // ── Clash Training Data (localStorage) ─────────────────────────
  function _getClashTrainStore() {
    try { return JSON.parse(localStorage.getItem('cc_clash_training_data')||'{}'); } catch(e) { return {}; }
  }
  function _saveClashTrainRecord(id, fv, label, labelSource, synthetic) {
    try {
      if (synthetic) return;
      var store = _getClashTrainStore();
      var existing = store[id];
      if (existing && existing.label != null && label != null) {
        var srcPri = {verdict:4, explicit_feedback:3, thumbs_feedback:3, issue_created:2, status_change:1, semantic_filter:0};
        if ((srcPri[labelSource]||0) < (srcPri[existing.label_source]||0)) return;
        if ((srcPri[labelSource]||0) === (srcPri[existing.label_source]||0) && label <= existing.label) return;
      }
      store[id] = {fv:fv, label:label, label_source:labelSource, synthetic:!!synthetic, ts:Date.now()};
      var keys = Object.keys(store);
      if (keys.length > _CLASH_TRAIN_CAP) {
        keys.sort(function(a,b){return (store[a].ts||0)-(store[b].ts||0);});
        while(keys.length > _CLASH_TRAIN_CAP) { delete store[keys.shift()]; }
      }
      localStorage.setItem('cc_clash_training_data', JSON.stringify(store));
      window.dispatchEvent(new Event('cc-training-data-change'));
    } catch(e) {}
  }
  function _clearClashTrainStore() {
    try { localStorage.removeItem('cc_clash_training_data'); } catch(e) {}
    window.dispatchEvent(new Event('cc-training-data-change'));
  }
  function _getClashTrainCount() {
    try {
      var s = localStorage.getItem('cc_clash_training_data');
      if (!s) return 0;
      var store = JSON.parse(s), count = 0;
      var _countSources = {verdict:1, thumbs_feedback:1, explicit_feedback:1};
      Object.keys(store).forEach(function(k){ if(_countSources[store[k].label_source]) count++; });
      return count;
    } catch(e) { return 0; }
  }
  function _shareClashTrainStore(onStatus) {
    var store = _getClashTrainStore();
    var keys = Object.keys(store);
    if (!keys.length) { onStatus('error','No clash training data to share.'); return; }
    var records = keys.map(function(k) { return Object.assign({id:k}, store[k]); });
    var CC_VERSION = window.CC_VERSION || {v:'0.0.0'};
    var payload = {type:'clash_training', version:'1.0', app_version:CC_VERSION.v, count:records.length, records:records};
    var json = JSON.stringify(payload);
    onStatus('sending', null);
    var fd = new URLSearchParams();
    fd.append('entry.1252313993', json);
    var _gf = ['https://docs','google','com/forms/d/e/','1FAIpQLSc51xdQw_8JY2lN1aw8OZOT2Jzdx42m','vilJzqMGVw4tXo7wtA'];
    var baseUrl = _gf[0]+'.'+_gf[1]+'.'+_gf[2]+_gf[3]+_gf[4];
    fetch(baseUrl+'/formResponse',{method:'POST',body:fd}).then(function(resp){
      if(resp.ok||resp.status===0){_clearClashTrainStore();onStatus('ok',null);}
      else{onStatus('error','Form returned '+resp.status+'. Check the form URL and entry field IDs.');}
    }).catch(function(){
      fetch(baseUrl+'/formResponse',{method:'POST',mode:'no-cors',body:fd}).then(function(){
        _clearClashTrainStore();
        onStatus('ok','Sent (unverified — no-cors)');
      }).catch(function(){
        try{
          var iframe=document.createElement('iframe');iframe.name='cc_clash_frame';iframe.style.cssText='display:none';
          document.body.appendChild(iframe);
          var form=document.createElement('form');form.method='POST';form.action=baseUrl+'/formResponse';form.target='cc_clash_frame';
          var input=document.createElement('input');input.type='hidden';input.name='entry.1252313993';input.value=json;
          form.appendChild(input);document.body.appendChild(form);form.submit();
          setTimeout(function(){try{document.body.removeChild(form);document.body.removeChild(iframe);}catch(e){}},5000);
          _clearClashTrainStore();
          onStatus('ok','Sent via iframe fallback');
        }catch(e){onStatus('error','Send failed — network or CORS blocked');}
      });
    });
  }

  // ── NL Training Data (localStorage) ───────────────────────────
  function _getNLTrainStore() {
    try { return JSON.parse(localStorage.getItem('cc_nl_training_data')||'[]'); } catch(e) { return []; }
  }
  function _saveNLTrainRecord(input, output, meta) {
    try {
      if (!input) return;
      if (input.trim().split(/\s+/).length < 2) return;
      var store = _getNLTrainStore();
      store.push({input:input, output:output, meta:meta});
      while (store.length > _NL_TRAIN_CAP) store.shift();
      localStorage.setItem('cc_nl_training_data', JSON.stringify(store));
      window.dispatchEvent(new Event('cc-training-data-change'));
    } catch(e) {}
  }
  function _clearNLTrainStore() {
    try { localStorage.removeItem('cc_nl_training_data'); } catch(e) {}
    if (typeof window._ccBeaconNLSentIdx !== 'undefined') window._ccBeaconNLSentIdx = 0;
    window.dispatchEvent(new Event('cc-training-data-change'));
  }
  function _getNLTrainCount() {
    try { var s = localStorage.getItem('cc_nl_training_data'); return s ? JSON.parse(s).length : 0; } catch(e) { return 0; }
  }

  // ── Export Training Data (JSONL) ──────────────────────────────
  function _exportClashTrainingJSONL() {
    var store = _getClashTrainStore();
    var keys = Object.keys(store);
    var labelled = keys.filter(function(k){return store[k].label != null;});
    if (!labelled.length) return;
    var header = '# type_pair,disc_pair,same_storey,same_model,overlap_vol_m3,pen_depth_mm,clearance_mm,bbox_a_dx,bbox_a_dy,bbox_a_dz,bbox_b_dx,bbox_b_dy,bbox_b_dz,mat_a,mat_b,storey,max_gap_mm,label,label_source,synthetic\n';
    var lines = labelled.map(function(k){
      var r = store[k], fv = r.fv || {};
      return JSON.stringify({
        type_pair:fv.type_pair||'',disc_pair:fv.disc_pair||'',same_storey:!!fv.same_storey,same_model:!!fv.same_model,
        overlap_vol_m3:fv.overlap_vol_m3||0,pen_depth_mm:fv.pen_depth_mm||0,clearance_mm:fv.clearance_mm,
        bbox_a:fv.bbox_a||{},bbox_b:fv.bbox_b||{},mat_a:fv.mat_a||'',mat_b:fv.mat_b||'',
        storey:fv.storey||'',max_gap_mm:fv.max_gap_mm||0,
        label:r.label,label_source:r.label_source||'',synthetic:!!r.synthetic
      });
    });
    var blob = new Blob([header + lines.join('\n') + '\n'], {type:'application/jsonl'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date().toISOString().slice(0,10);
    a.href = url; a.download = 'clashcontrol-clash-training-'+d+'.jsonl';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function _exportNLTrainingJSONL() {
    var store = _getNLTrainStore();
    if (!store.length) return;
    var sysMsg = 'You are ClashControl\'s command parser. Given a user command about IFC clash detection, output a JSON action object or a plain text response. Valid intents: run_detection, set_max_gap, filter_status, reset_filters, group_by, sort_by, export_bcf, import_bcf, query, help, theme, settings, open_tab, training_mode, measure, viewpoint, section, floor_plan.';
    var lines = store.map(function(r){
      var matched = r.output != null;
      var outStr = matched ? (typeof r.output === 'object' ? JSON.stringify(r.output) : String(r.output)) : '';
      var rec = {
        messages:[
          {role:'system',content:sysMsg},
          {role:'user',content:r.input}
        ]
      };
      if (matched) rec.messages.push({role:'assistant',content:outStr});
      rec.matched = matched;
      if (r.meta && r.meta.path) rec.path = r.meta.path;
      return JSON.stringify(rec);
    });
    var blob = new Blob([lines.join('\n') + '\n'], {type:'application/jsonl'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date().toISOString().slice(0,10);
    a.href = url; a.download = 'clashcontrol-nl-training-'+d+'.jsonl';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Share NL Training Data (GDPR-safe) ──────────────────────
  function _sanitizeNLInput(text, models) {
    var s = text;
    if(models&&models.length){
      var idx=0;
      models.forEach(function(m){
        if(m.name){
          var re=new RegExp(m.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'gi');
          s=s.replace(re,'MODEL_'+ String.fromCharCode(65+idx));
          idx++;
        }
      });
    }
    s=s.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,'[email]');
    s=s.replace(/[A-Za-z]:\\[^\s]+/g,'[path]');
    s=s.replace(/\/[^\s]*\/[^\s]+/g,'[path]');
    s=s.replace(/\S+\.(?:ifc|rvt|nwc|nwd|dwg|dxf|pdf|xlsx?|csv|json)\b/gi,'[file]');
    s=s.replace(/"[^"]{20,}"/g,'"[redacted]"');
    s=s.replace(/'[^']{20,}'/g,"'[redacted]'");
    return s;
  }

  function _shareNLTrainingData(models, onStatus) {
    var store = _getNLTrainStore();
    if(!store.length){onStatus('error','No NL data to share.');return;}
    var records = store.map(function(r){
      return {
        input: _sanitizeNLInput(r.input||'', models),
        matched: !!(r.output!=null),
        path: r.meta&&r.meta.path||'unknown',
        v: r.meta&&r.meta.v||'',
        ts: r.meta&&r.meta.ts||0
      };
    });
    var CC_VERSION = window.CC_VERSION || {v:'0.0.0'};
    var payload = {type:'nl_training', version:'1.0', app_version:CC_VERSION.v, count:records.length, records:records};
    var json = JSON.stringify(payload);
    onStatus('sending',null);
    var fd = new URLSearchParams();
    fd.append('entry.65932609', json);
    var _gf = ['https://docs','google','com/forms/d/e/','1FAIpQLSc51xdQw_8JY2lN1aw8OZOT2Jzdx42m','vilJzqMGVw4tXo7wtA'];
    var baseUrl = _gf[0]+'.'+_gf[1]+'.'+_gf[2]+_gf[3]+_gf[4];
    fetch(baseUrl+'/formResponse',{method:'POST',body:fd}).then(function(resp){
      if(resp.ok||resp.status===0){_clearNLTrainStore();onStatus('ok',null);}
      else{onStatus('error','Form returned '+resp.status);}
    }).catch(function(){
      fetch(baseUrl+'/formResponse',{method:'POST',mode:'no-cors',body:fd}).then(function(){
        _clearNLTrainStore();onStatus('ok','Sent (unverified)');
      }).catch(function(){
      try{
        var iframe=document.createElement('iframe');iframe.name='cc_nl_frame';iframe.style.cssText='display:none';
        document.body.appendChild(iframe);
        var form=document.createElement('form');form.method='POST';form.action=baseUrl+'/formResponse';form.target='cc_nl_frame';
        var input=document.createElement('input');input.type='hidden';input.name='entry.65932609';input.value=json;
        form.appendChild(input);document.body.appendChild(form);form.submit();
        setTimeout(function(){try{document.body.removeChild(form);document.body.removeChild(iframe);}catch(e){}},5000);
        _clearNLTrainStore();
        onStatus('ok','Sent via iframe fallback');
      }catch(e){onStatus('error','Send failed — network or CORS blocked');}
      });
    });
  }

  // ── AI Training Data Export ─────────────────────────────────
  function _buildAITrainingPayload(clashes, detectionSettings, models, defaultTolerances, issues) {
    var allClashData = clashes.slice();
    if(issues) issues.forEach(function(i){if(i.source==='clash') allClashData.push(i);});
    var reviewed = allClashData.filter(function(c){ return c.status!=='open'; });
    if (reviewed.length===0) return null;
    var tols = defaultTolerances || {};
    var CC_VERSION = window.CC_VERSION || {v:'0.0.0'};
    var _lookupElProps = window._ccLookupElProps || function(){ return null; };
    var records = reviewed.map(function(c) {
      var discA = '', discB = '';
      if (c.disciplines) { discA = c.disciplines[0]||''; discB = c.disciplines[1]||''; }
      var ptA = c.objectTypeA || '', ptB = c.objectTypeB || '';
      if (!ptA || !ptB) {
        var pA = _lookupElProps(models, c.modelAId, c.elemA);
        var pB = _lookupElProps(models, c.modelBId, c.elemB);
        if (pA && !ptA) ptA = pA.objectType || '';
        if (pB && !ptB) ptB = pB.objectType || '';
      }
      var penDepth = c.type==='hard' && c.distance<0 ? Math.round(Math.abs(c.distance)*10)/10 : 0;
      function _sanitizePT(pt){
        if(!pt) return null;
        var dims = pt.match(/\d+x\d+(?:[x-]\d+)*/g);
        var keywords = pt.match(/\b(?:HEA|HEB|HEM|IPE|UNP|UPE|CHS|RHS|SHS|THQ|INP|pipe|duct|cable|tray|beam|column|wall|slab|plate)\b/gi);
        var parts = [];
        if(keywords) parts.push(keywords.join(' '));
        if(dims) parts.push(dims.join(' '));
        return parts.length ? parts.join(' ') : null;
      }
      function _sanitizeNote(n){
        if(!n) return '';
        return n.replace(/[A-Z]{2,}[-_]\d{2,}[A-Za-z0-9_-]*/g,'[id]')
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,'[email]')
          .replace(/[A-Za-z]:\\[^\s]+/g,'[path]');
      }
      return {
        ifc_type_a: c.elemAType || '',
        ifc_type_b: c.elemBType || '',
        discipline_a: discA,
        discipline_b: discB,
        predefined_type_a: _sanitizePT(ptA),
        predefined_type_b: _sanitizePT(ptB),
        clash_type: c.type === 'duplicate' ? 'hard' : c.type,
        clash_type_confirmed: c.clashTypeConfirmed || null,
        penetration_depth_mm: penDepth,
        overlap_volume_m3: c.overlapVolM3 != null ? Math.round(c.overlapVolM3 * 1e6) / 1e6 : 0,
        clearance_mm: c.clearanceMm != null ? c.clearanceMm : null,
        bbox_a: c.bboxA || {dx:0,dy:0,dz:0},
        bbox_b: c.bboxB || {dx:0,dy:0,dz:0},
        verdict: c.aiFeedback || _AI_VERDICT_MAP[c.status] || 'unreviewed',
        reasons: c.aiReasons || [],
        resolution: c.aiResolution || [],
        type_pair_tolerance_mm: function(){
          var tA=c.elemAType||'',tB=c.elemBType||'';
          if(!tA||!tB) return null;
          var k1=tA<tB?tA+':'+tB:tB+':'+tA;
          return tols[k1]!==undefined?tols[k1]:null;
        }(),
        note: _sanitizeNote(c.aiNote || ''),
        user_tolerance_mm: c.userToleranceMm != null ? c.userToleranceMm : null,
        vs_standard_mm: function(){
          if(c.userToleranceMm==null) return null;
          if(c.type==='hard'){
            var pen=c.distance!=null&&c.distance<0?Math.abs(c.distance):0;
            return 0-pen;
          }
          var actual=c.clearanceMm!=null?c.clearanceMm:(c.distance!=null?c.distance:null);
          if(actual==null) return null;
          return Math.round((actual-c.userToleranceMm)*100)/100;
        }(),
        expected_clash: !!c.expectedClash,
        app_version: CC_VERSION.v
      };
    });
    return {
      export_version: '1.0',
      app_version: CC_VERSION.v,
      clash_count: records.length,
      detection_settings: detectionSettings || {clearance_mm:null, discipline_filters:['all']},
      clashes: records
    };
  }

  function exportAITrainingData(clashes, detectionSettings, models, defaultTolerances, issues) {
    var payload = _buildAITrainingPayload(clashes, detectionSettings, models, defaultTolerances, issues);
    if (!payload) return;
    var json = JSON.stringify(payload, null, 2);
    var blob = new Blob([json], {type:'application/json'});
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'clashcontrol-training-data.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function shareAITrainingData(clashes, detectionSettings, models, onStatus, defaultTolerances, issues) {
    var payload = _buildAITrainingPayload(clashes, detectionSettings, models, defaultTolerances, issues);
    if (!payload) { onStatus('error','No reviewed clashes to share.'); return; }
    var json = JSON.stringify(payload);
    onStatus('sending', null);
    var fd = new URLSearchParams();
    fd.append('entry.1252313993', json);
    var _gf = ['https://docs','google','com/forms/d/e/','1FAIpQLSc51xdQw_8JY2lN1aw8OZOT2Jzdx42m','vilJzqMGVw4tXo7wtA'];
    var baseUrl = _gf[0]+'.'+_gf[1]+'.'+_gf[2]+_gf[3]+_gf[4];
    fetch(baseUrl+'/formResponse', {method:'POST', body:fd}).then(function(resp){
      if(resp.ok||resp.status===0){onStatus('ok',null);}
      else{onStatus('error','Form returned '+resp.status+'. Check form URL.');}
    }).catch(function(){
      fetch(baseUrl+'/formResponse',{method:'POST',mode:'no-cors',body:fd}).then(function(){
        onStatus('ok','Sent (unverified — no-cors)');
      }).catch(function(e){
      try {
        var iframe = document.createElement('iframe');
        iframe.name = 'cc_submit_frame';
        iframe.style.cssText = 'display:none;width:0;height:0;border:0';
        document.body.appendChild(iframe);
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = baseUrl+'/formResponse';
        form.target = 'cc_submit_frame';
        var input = document.createElement('input');
        input.type = 'hidden'; input.name = 'entry.1252313993'; input.value = json;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        setTimeout(function(){ try{document.body.removeChild(form); document.body.removeChild(iframe);}catch(e){} }, 5000);
        onStatus('ok', 'Sent via iframe fallback');
      } catch(e2) {
        onStatus('error', 'Send failed — network or CORS blocked');
      }
      });
    });
  }

  // ── Expose as globals ─────────────────────────────────────────
  window._ccGetClashTrainStore = _getClashTrainStore;
  window._ccSaveClashTrainRecord = _saveClashTrainRecord;
  window._ccClearClashTrainStore = _clearClashTrainStore;
  window._ccGetClashTrainCount = _getClashTrainCount;
  window._ccShareClashTrainStore = _shareClashTrainStore;
  window._ccGetNLTrainStore = _getNLTrainStore;
  window._ccSaveNLTrainRecord = _saveNLTrainRecord;
  window._ccClearNLTrainStore = _clearNLTrainStore;
  window._ccGetNLTrainCount = _getNLTrainCount;
  window._ccExportClashTrainingJSONL = _exportClashTrainingJSONL;
  window._ccExportNLTrainingJSONL = _exportNLTrainingJSONL;
  window._ccSanitizeNLInput = _sanitizeNLInput;
  window._ccShareNLTrainingData = _shareNLTrainingData;
  window._ccBuildAITrainingPayload = _buildAITrainingPayload;
  window._ccExportAITrainingData = exportAITrainingData;
  window._ccShareAITrainingData = shareAITrainingData;
  window._ccAIVerdictMap = _AI_VERDICT_MAP;
})();
