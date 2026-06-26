import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import { syncWaitAiringStateForAnime } from "../src/services/airingStateService.js";

const SUBJECT_ID = 990577001;
const SOURCE = "ffzy";

function resetSubject() {
  initDb();
  sqlite.exec(`
    DELETE FROM manual_resource_state WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM retry_state WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM resource_mappings WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM episodes WHERE bangumi_id = ${SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${SUBJECT_ID};
    INSERT INTO subjects (bangumi_id, name, name_cn, air_date, rating_distribution_json)
    VALUES (${SUBJECT_ID}, 'Airing Raw', '放送测试', '2026-06-30', '[]');
  `);
}

test("syncWaitAiringStateForAnime writes wait_airing before the exact air date", () => {
  resetSubject();

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-06-30",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-29T12:00:00+08:00"),
  });

  const manual = sqlite.prepare(`
    SELECT status, note FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.written, 1);
  assert.equal(result.cleared, 0);
  assert.deepEqual(manual, { status: "wait_airing", note: "等待开播：2026-06-30" });
});

test("syncWaitAiringStateForAnime clears wait_airing on the exact air date", () => {
  resetSubject();
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '等待开播：2026-06-30')
  `).run(SUBJECT_ID, SOURCE);

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-06-30",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-30T08:00:00+08:00"),
  });

  const manual = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ? AND status = 'wait_airing'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.written, 0);
  assert.equal(result.cleared, 1);
  assert.equal(manual.count, 0);
});

test("syncWaitAiringStateForAnime clears wait_airing after the exact air date", () => {
  resetSubject();
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '等待开播：2026-06-30')
  `).run(SUBJECT_ID, SOURCE);

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-06-30",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-07-01T08:00:00+08:00"),
  });

  const manual = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ? AND status = 'wait_airing'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.status, "started");
  assert.equal(result.cleared, 1);
  assert.equal(manual.count, 0);
});

test("syncWaitAiringStateForAnime clears retry state when wait_airing is released", () => {
  resetSubject();
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '等待开播：2026-06-30')
  `).run(SUBJECT_ID, SOURCE);
  sqlite.prepare(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, last_error)
    VALUES (?, ?, 'mapping', 5, null, 'blocked before airing')
  `).run(SUBJECT_ID, SOURCE);
  sqlite.prepare(`
    INSERT INTO retry_state (bangumi_id, source, kind, retry_count, retry_at, last_error)
    VALUES (?, ?, 'episode_fetch', 3, '2026-07-01 12:00:00', 'detail unavailable')
  `).run(SUBJECT_ID, SOURCE);

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-06-30",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-30T08:00:00+08:00"),
  });

  const mappingRetry = sqlite.prepare(`
    SELECT retry_count, retry_at FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'mapping'
  `).get(SUBJECT_ID, SOURCE);
  const episodeFetchRetry = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM retry_state
    WHERE bangumi_id = ? AND source = ? AND kind = 'episode_fetch'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.cleared, 1);
  assert.deepEqual(mappingRetry, { retry_count: 0, retry_at: null });
  assert.equal(episodeFetchRetry.count, 0);
});

test("syncWaitAiringStateForAnime keeps existing non-wait_airing manual states intact", () => {
  resetSubject();
  sqlite.exec(`
    DELETE FROM manual_resource_state WHERE bangumi_id = ${SUBJECT_ID};
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (${SUBJECT_ID}, '${SOURCE}', 'no_resource', '手动无资源');
  `);

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-07-01",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-30T12:00:00+08:00"),
  });

  const manual = sqlite.prepare(`
    SELECT status, note FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.written, 0);
  assert.equal(result.cleared, 0);
  assert.deepEqual(manual, { status: "no_resource", note: "手动无资源" });
});

test("syncWaitAiringStateForAnime keeps existing wait_airing manual notes intact", () => {
  resetSubject();
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '资源站通常晚一天上线')
  `).run(SUBJECT_ID, SOURCE);

  const result = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-07-01",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-30T12:00:00+08:00"),
  });

  const manual = sqlite.prepare(`
    SELECT status, note FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ?
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(result.written, 0);
  assert.equal(result.cleared, 0);
  assert.deepEqual(manual, { status: "wait_airing", note: "资源站通常晚一天上线" });
});

test("syncWaitAiringStateForAnime compares dates in the Bangumi business timezone", () => {
  const originalTz = process.env.TZ;
  process.env.TZ = "UTC";
  try {
    resetSubject();
    sqlite.prepare(`
      INSERT INTO manual_resource_state (bangumi_id, source, status, note)
      VALUES (?, ?, 'wait_airing', '等待开播：2026-06-30')
    `).run(SUBJECT_ID, SOURCE);

    const result = syncWaitAiringStateForAnime({
      bangumi_id: SUBJECT_ID,
      air_date: "2026-06-30",
    }, {
      sourceKeys: [SOURCE],
      now: new Date("2026-06-29T16:30:00Z"),
    });

    const manual = sqlite.prepare(`
      SELECT COUNT(*) AS count FROM manual_resource_state
      WHERE bangumi_id = ? AND source = ? AND status = 'wait_airing'
    `).get(SUBJECT_ID, SOURCE);

    assert.equal(result.status, "started");
    assert.equal(result.cleared, 1);
    assert.equal(manual.count, 0);
  } finally {
    if (originalTz == null) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  }
});

test("syncWaitAiringStateForAnime treats month and year precision as inclusive boundaries", () => {
  resetSubject();
  sqlite.prepare(`
    UPDATE subjects SET air_date = '2026-06' WHERE bangumi_id = ?
  `).run(SUBJECT_ID);
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '等待开播：2026-06')
  `).run(SUBJECT_ID, SOURCE);

  const monthResult = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026-06",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-06-01T09:00:00+08:00"),
  });

  const monthManual = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ? AND status = 'wait_airing'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(monthResult.status, "started");
  assert.equal(monthResult.cleared, 1);
  assert.equal(monthManual.count, 0);

  sqlite.prepare(`
    UPDATE subjects SET air_date = '2026' WHERE bangumi_id = ?
  `).run(SUBJECT_ID);
  sqlite.prepare(`
    INSERT INTO manual_resource_state (bangumi_id, source, status, note)
    VALUES (?, ?, 'wait_airing', '等待开播：2026')
  `).run(SUBJECT_ID, SOURCE);

  const yearResult = syncWaitAiringStateForAnime({
    bangumi_id: SUBJECT_ID,
    air_date: "2026",
  }, {
    sourceKeys: [SOURCE],
    now: new Date("2026-01-01T09:00:00+08:00"),
  });

  const yearManual = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM manual_resource_state
    WHERE bangumi_id = ? AND source = ? AND status = 'wait_airing'
  `).get(SUBJECT_ID, SOURCE);

  assert.equal(yearResult.status, "started");
  assert.equal(yearResult.cleared, 1);
  assert.equal(yearManual.count, 0);
});
