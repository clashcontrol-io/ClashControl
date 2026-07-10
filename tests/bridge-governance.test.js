'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { classifyTool, checkAutonomy } = require('../bridge-governance');

test('classifies read-only tools', () => {
  assert.equal(classifyTool('get_clashes'), 'read_only');
  assert.equal(classifyTool('get_status'), 'read_only');
});

test('classifies view/data mutations that are cheaply reversible as reversible', () => {
  assert.equal(classifyTool('update_clash'), 'reversible');
  assert.equal(classifyTool('set_view'), 'reversible');
  assert.equal(classifyTool('create_issue'), 'reversible');
});

test('classifies bulk/irreversible tools as destructive', () => {
  assert.equal(classifyTool('batch_update_clashes'), 'destructive');
  assert.equal(classifyTool('delete_model'), 'destructive');
  assert.equal(classifyTool('delete_issue'), 'destructive');
  assert.equal(classifyTool('delete_sheet'), 'destructive');
  assert.equal(classifyTool('import_bcf'), 'destructive');
});

test('unknown tools default to destructive (fail safe)', () => {
  assert.equal(classifyTool('some_future_tool'), 'destructive');
});

test('checkAutonomy allows read-only tools with no confirm', () => {
  const r = checkAutonomy('get_clashes', {});
  assert.equal(r.allowed, true);
  assert.equal(r.tier, 'read_only');
});

test('checkAutonomy allows reversible tools with no confirm', () => {
  const r = checkAutonomy('update_clash', { clashIndex: 0, status: 'expected' });
  assert.equal(r.allowed, true);
});

test('checkAutonomy blocks a destructive tool without confirm and explains how to proceed', () => {
  const r = checkAutonomy('delete_model', { name: 'MEP' });
  assert.equal(r.allowed, false);
  assert.equal(r.tier, 'destructive');
  assert.match(r.error.reason, /delete_model/);
  assert.match(r.error.next_step, /confirm/);
});

test('checkAutonomy allows a destructive tool once confirm:true is set', () => {
  const r = checkAutonomy('delete_model', { name: 'MEP', confirm: true });
  assert.equal(r.allowed, true);
});

test('CLASHCONTROL_AUTONOMY_GATE=off disables enforcement', () => {
  process.env.CLASHCONTROL_AUTONOMY_GATE = 'off';
  try {
    const r = checkAutonomy('delete_model', { name: 'MEP' });
    assert.equal(r.allowed, true);
  } finally {
    delete process.env.CLASHCONTROL_AUTONOMY_GATE;
  }
});

test('CLASHCONTROL_AUTONOMY=read_only blocks reversible mutations too', () => {
  process.env.CLASHCONTROL_AUTONOMY = 'read_only';
  try {
    const r = checkAutonomy('update_clash', { clashIndex: 0 });
    assert.equal(r.allowed, false);
  } finally {
    delete process.env.CLASHCONTROL_AUTONOMY;
  }
});

test('CLASHCONTROL_AUTONOMY=read_only still allows read-only tools', () => {
  process.env.CLASHCONTROL_AUTONOMY = 'read_only';
  try {
    const r = checkAutonomy('get_status', {});
    assert.equal(r.allowed, true);
  } finally {
    delete process.env.CLASHCONTROL_AUTONOMY;
  }
});

test('CLASHCONTROL_AUTONOMY=auto waves through destructive tools', () => {
  process.env.CLASHCONTROL_AUTONOMY = 'auto';
  try {
    const r = checkAutonomy('delete_model', { name: 'MEP' });
    assert.equal(r.allowed, true);
  } finally {
    delete process.env.CLASHCONTROL_AUTONOMY;
  }
});
