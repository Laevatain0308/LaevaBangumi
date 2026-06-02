import test from "node:test";
import assert from "node:assert/strict";
import { initDb, sqlite } from "../src/db/index.js";
import {
  findSubjectById,
  listSubjectAliases,
  listSubjectTags,
  searchSubjectsByKeyword,
  searchSubjectsByTag,
} from "../src/repositories/subjectRepository.js";

const REPOSITORY_SUBJECT_ID = 990547890;

function seedRepositorySubject() {
  initDb();
  sqlite.exec(`
    DELETE FROM subject_aliases WHERE bangumi_id = ${REPOSITORY_SUBJECT_ID};
    DELETE FROM subject_tags WHERE bangumi_id = ${REPOSITORY_SUBJECT_ID};
    DELETE FROM subjects WHERE bangumi_id = ${REPOSITORY_SUBJECT_ID};
    DELETE FROM tags WHERE name IN ('仓库Tag', 'RepositoryTag');

    INSERT INTO subjects (
      bangumi_id, name, name_cn, summary, platform, air_date,
      air_weekday, eps, total_episodes, cover_url, has_cover,
      rating_score, rating_rank, rating_total, rating_distribution_json,
      metadata_fetched_at, updated_at
    ) VALUES (
      ${REPOSITORY_SUBJECT_ID}, 'Repository raw title', '仓库标题', 'summary', 'TV', '2026-04-03',
      5, 12, 12, 'https://example.invalid/repository-cover.jpg', 0,
      7.8, 321, 88, '[0,0,0,1,2,3,4,5,6,7]', datetime('now'), datetime('now')
    );
    INSERT INTO subject_aliases (bangumi_id, alias) VALUES
      (${REPOSITORY_SUBJECT_ID}, 'Repo Alias'),
      (${REPOSITORY_SUBJECT_ID}, '仓库别名');
    INSERT INTO tags (name) VALUES ('仓库Tag'), ('RepositoryTag');
    INSERT INTO subject_tags (bangumi_id, tag_id, count, total_count)
      SELECT ${REPOSITORY_SUBJECT_ID}, tag_id, CASE name WHEN '仓库Tag' THEN 20 ELSE 5 END, 25
      FROM tags WHERE name IN ('仓库Tag', 'RepositoryTag');
  `);
}

test("subject repository reads normalized metadata rows", () => {
  seedRepositorySubject();

  const subject = findSubjectById(REPOSITORY_SUBJECT_ID);
  assert.equal(subject.bangumi_id, REPOSITORY_SUBJECT_ID);
  assert.equal(subject.name_cn, "仓库标题");
  assert.equal(subject.rating_score, 7.8);
  assert.equal(subject.rating_total, 88);

  assert.deepEqual(listSubjectAliases(REPOSITORY_SUBJECT_ID), ["Repo Alias", "仓库别名"]);
  assert.deepEqual(listSubjectTags(REPOSITORY_SUBJECT_ID), [
    { name: "仓库Tag", count: 20, totalCount: 25 },
    { name: "RepositoryTag", count: 5, totalCount: 25 },
  ]);
});

test("subject repository searches by keyword alias and tag", () => {
  seedRepositorySubject();

  assert.equal(searchSubjectsByKeyword("仓库标题")[0].bangumi_id, REPOSITORY_SUBJECT_ID);
  assert.equal(searchSubjectsByKeyword("Repo Alias")[0].bangumi_id, REPOSITORY_SUBJECT_ID);
  assert.equal(searchSubjectsByTag("仓库Tag")[0].bangumi_id, REPOSITORY_SUBJECT_ID);
  assert.equal(searchSubjectsByKeyword("").length, 0);
  assert.equal(searchSubjectsByTag("").length, 0);
});
