(function() {
  'use strict';
  try {
    if (localStorage.getItem('cc_data_consent_explicit') !== '1' ||
        localStorage.getItem('cc_data_consent') !== 'granted') return;
    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://gc.zgo.at/count.js';
    script.setAttribute('data-goatcounter', 'https://clashcontrol.goatcounter.com/count');
    document.head.appendChild(script);
  } catch (_) {}
}());
