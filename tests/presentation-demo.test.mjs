import assert from 'node:assert/strict';
import test from 'node:test';

import {
  demoVideoSchedule,
  lapTimesFromSeconds,
  buildDemoSession,
} from '../static/js/lib/presentation-demo.js';

test('demoVideoSchedule matches the presentation video by filename substring', () => {
  const s = demoVideoSchedule({ name: 'Video-Presentacion-Final.mp4' });
  assert.ok(Array.isArray(s));
  assert.deepEqual(s[0].laps, [25, 56]);
});

test('demoVideoSchedule returns null for a normal video or no file', () => {
  assert.equal(demoVideoSchedule({ name: 'entreno-martes.mp4' }), null);
  assert.equal(demoVideoSchedule(null), null);
  assert.equal(demoVideoSchedule({}), null);
});

test('lapTimesFromSeconds turns absolute seconds into relative ms laps', () => {
  const laps = lapTimesFromSeconds([25, 56], 't0');
  assert.deepEqual(laps, [
    { lapNumber: 1, time: 25000, timestamp: 't0' },
    { lapNumber: 2, time: 31000, timestamp: 't0' },
  ]);
});

test('buildDemoSession has the Historial shape with a deterministic id', () => {
  const s = buildDemoSession({ id: 'abc', name: 'Rudolf' }, [25, 56], 't0');
  assert.equal(s.id, 'demo-session-abc');
  assert.equal(s.swimmerId, 'abc');
  assert.equal(s.swimmerName, 'Rudolf');
  assert.equal(s.laps, 2);
  assert.equal(s.totalTime, 56000);
  assert.equal(s.date, 't0');
  assert.equal(s.lapTimes.length, 2);
});
