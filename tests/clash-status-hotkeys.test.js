'use strict';
// Structural drift guard for index.html's single-clash status hotkeys
// (C/D/V). There's no clean pure-logic extraction here — the handler lives
// inside a React keydown closure over flatItems/activeId/d — so this mirrors
// the "slice source, assert substrings" pattern tests/discipline-colors.test.js
// already uses for its cross-site drift check: confirm the keyboard path
// (added alongside the existing Confirm/Deny/Accept·Check buttons) drives
// the exact same three status values and the same _ccPrepareAdvance /
// _ccAdvanceToNext auto-advance mechanism the buttons already use, so a
// future rename of a status string in one place can't silently desync it
// from the other.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const hotkeyStart = src.indexOf("e.key==='c'||e.key==='C'||e.key==='d'");
assert.ok(hotkeyStart !== -1, 'status-hotkey handler (c/d/v key check) not found');
const hotkeyBlock = src.slice(hotkeyStart, hotkeyStart + 900);

const buttonsStart = src.indexOf("aria-label=${_cc_t('issueRow.confirmClashAria'");
assert.ok(buttonsStart !== -1, 'Confirm button not found');
const buttonsEnd = src.indexOf("aria-label=${_cc_t('issueRow.acceptFlagAria'");
assert.ok(buttonsEnd !== -1, 'Accept·Check button not found');
const buttonsBlock = src.slice(buttonsStart, buttonsEnd + 200);

test('keyboard status hotkeys use the exact same three status values as the Confirm/Deny/Accept buttons', () => {
  ['confirmed', 'denied', 'accepted_needs_check'].forEach((status) => {
    assert.ok(hotkeyBlock.includes("'" + status + "'"), 'hotkey handler missing status: ' + status);
    assert.ok(buttonsBlock.includes("'" + status + "'"), 'button block missing status: ' + status);
  });
});

test('keyboard status hotkeys dispatch through UPD_CLASH like the buttons', () => {
  assert.ok(hotkeyBlock.includes('A.UPD_CLASH'));
  assert.ok(buttonsBlock.includes('A.UPD_CLASH'));
});

test('keyboard status hotkeys reuse the same auto-advance mechanism as the buttons (_ccPrepareAdvance + _ccAdvanceToNext)', () => {
  ['_ccPrepareAdvance', '_ccAdvanceToNext'].forEach((fn) => {
    assert.ok(hotkeyBlock.includes(fn), 'hotkey handler missing ' + fn);
    assert.ok(buttonsBlock.includes(fn), 'button block missing ' + fn);
  });
});

test('keyboard status hotkeys are gated the same way as the buttons: hidden/inert once already confirmed', () => {
  assert.ok(hotkeyBlock.includes("status!=='confirmed'"));
  assert.ok(buttonsBlock.includes("status!=='confirmed'") || src.slice(buttonsStart - 200, buttonsStart).includes("status!=='confirmed'"));
});

test('the hotkey handler checks all three keys (c/d/v) before falling through to J/K navigation', () => {
  assert.ok(hotkeyBlock.match(/e\.key===['"]c['"]/));
  assert.ok(hotkeyBlock.match(/e\.key===['"]d['"]/));
  assert.ok(hotkeyBlock.match(/e\.key===['"]v['"]/));
});
