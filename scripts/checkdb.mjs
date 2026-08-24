// 校对库：把重排的跑批、指标、差异、未读字形写进 ~/Documents/诗歌/500首/校对.db。
//
// 用 node:sqlite（Node 22+ 自带），**不引新依赖**。
// 表名/字段名一律英文；库里原有的 `check` 表（中文列名）是人工校对表，不动它，按曲号 join。
import { DatabaseSync } from "node:sqlite";
import { CORPUS_ROOT } from "./node-harness.mjs";
import { join } from "node:path";

export const DB_PATH = process.env.HYMN500_DB ?? join(CORPUS_ROOT, "校对.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  run_id TEXT PRIMARY KEY, started_at TEXT, branch TEXT, commit_sha TEXT,
  route TEXT, config TEXT, artifact TEXT, page_count INT, byte_size INT, cmd TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS run_metric (
  run_id TEXT, metric TEXT, value REAL, numerator REAL, denominator REAL,
  PRIMARY KEY(run_id, metric));
CREATE TABLE IF NOT EXISTS diff (
  id INTEGER PRIMARY KEY, run_id TEXT, song_no TEXT, page INT,
  category TEXT, role TEXT, locus TEXT, gt_value TEXT, out_value TEXT, note TEXT,
  status TEXT DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS unread_glyph (
  shape_key TEXT PRIMARY KEY, instances INT, first_page INT, song_no TEXT, role TEXT,
  guess_char TEXT, source TEXT, confidence REAL, status TEXT DEFAULT 'pending', updated_at TEXT);
CREATE TABLE IF NOT EXISTS glyph_fix (
  shape_key TEXT PRIMARY KEY, char TEXT, source TEXT, confirmed_by TEXT, confirmed_at TEXT);

-- ── 书级元数据（gen-bookmeta.mjs 写，rebuild.mjs 读）
-- 原书上那些 musicxml 装不下的内容：调号拍号原文、段落词、花边框正文、
-- 目录与首句索引、扉页前言、印刷页码、花边纹样母题。
CREATE TABLE IF NOT EXISTS song_meta (
  song_no TEXT PRIMARY KEY, tonic TEXT, beats INT, beat_type INT, alt_tonic TEXT,
  key_raw TEXT, category TEXT, source_page INT);
CREATE TABLE IF NOT EXISTS section_word (
  id INTEGER PRIMARY KEY, song_no TEXT, text TEXT,
  note_ordinal INT, measure_index INT, system_index INT, source_page INT);
CREATE TABLE IF NOT EXISTS annotation (
  id INTEGER PRIMARY KEY, song_no TEXT, framed INT, seq INT, text TEXT,
  box_x REAL, box_y REAL, box_w REAL, box_h REAL, source_page INT);
CREATE TABLE IF NOT EXISTS toc_row (
  id INTEGER PRIMARY KEY, seq INT, kind TEXT, text TEXT, song_no TEXT,
  printed_page INT, source_page INT);
CREATE TABLE IF NOT EXISTS index_row (
  id INTEGER PRIMARY KEY, seq INT, kind TEXT, index_name TEXT, text TEXT,
  song_no TEXT, source_page INT);
CREATE TABLE IF NOT EXISTS front_page (
  id INTEGER PRIMARY KEY, source_page INT, kind TEXT, title TEXT, body TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS page_label (
  page INTEGER PRIMARY KEY, printed_label TEXT, printed_no INT, kind TEXT);
CREATE TABLE IF NOT EXISTS ornament_tile (
  orient TEXT PRIMARY KEY, w REAL, h REAL, pitch REAL, path TEXT);
CREATE VIEW IF NOT EXISTS pending_diff AS
  SELECT d.song_no, c.标题 AS title, d.page, d.category, d.role, d.gt_value, d.out_value, d.note
  FROM diff d LEFT JOIN "check" c ON c.编号 = d.song_no
  WHERE d.status = 'pending';
`;

export function openDb(path = DB_PATH) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

export function newRunId(route) {
  const t = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-${p(t.getHours())}${p(t.getMinutes())}-${route}`;
}

export function recordRun(db, row) {
  db.prepare(
    `INSERT OR REPLACE INTO run (run_id, started_at, branch, commit_sha, route, config, artifact, page_count, byte_size, cmd, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.run_id, row.started_at ?? new Date().toISOString(), row.branch ?? null, row.commit_sha ?? null,
    row.route, row.config ?? null, row.artifact ?? null, row.page_count ?? null, row.byte_size ?? null,
    row.cmd ?? null, row.note ?? null,
  );
}

export function recordMetrics(db, runId, metrics) {
  const st = db.prepare(`INSERT OR REPLACE INTO run_metric (run_id, metric, value, numerator, denominator) VALUES (?,?,?,?,?)`);
  for (const [metric, v] of Object.entries(metrics)) {
    const o = typeof v === "number" ? { value: v } : v;
    st.run(runId, metric, o.value ?? null, o.numerator ?? null, o.denominator ?? null);
  }
}

/** 差异表按批次覆盖写：同一批次重跑不该留下上一次的残留。 */
export function recordDiffs(db, runId, rows) {
  db.prepare(`DELETE FROM diff WHERE run_id = ?`).run(runId);
  const st = db.prepare(
    `INSERT INTO diff (run_id, song_no, page, category, role, locus, gt_value, out_value, note, status)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  for (const r of rows)
    st.run(runId, r.song_no ?? null, r.page ?? null, r.category ?? null, r.role ?? null, r.locus ?? null,
      r.gt_value ?? null, r.out_value ?? null, r.note ?? null, r.status ?? "pending");
}

/** 未读字形：人工确认过的（glyph_fix 里有）不覆盖。 */
export function recordUnread(db, rows) {
  const st = db.prepare(
    `INSERT INTO unread_glyph (shape_key, instances, first_page, song_no, role, guess_char, source, confidence, status, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(shape_key) DO UPDATE SET instances=excluded.instances, first_page=excluded.first_page,
       song_no=excluded.song_no, role=excluded.role, guess_char=excluded.guess_char,
       source=excluded.source, confidence=excluded.confidence, updated_at=excluded.updated_at
     WHERE unread_glyph.status = 'pending'`,
  );
  const now = new Date().toISOString();
  for (const r of rows)
    st.run(r.shape_key, r.instances ?? 0, r.first_page ?? null, r.song_no ?? null, r.role ?? null,
      r.guess_char ?? null, r.source ?? null, r.confidence ?? null, r.status ?? "pending", now);
}

/** 人工定案的补字（glyph_fix）→ 供 relayout 覆盖字典。 */
export function loadGlyphFixes(db) {
  const out = {};
  for (const r of db.prepare(`SELECT shape_key, char FROM glyph_fix`).all()) out[r.shape_key] = r.char;
  return out;
}

/** 定案的补字：整批插入，人工确认过的（confirmed_by 非空）不覆盖。 */
export function recordGlyphFixes(db, rows) {
  const st = db.prepare(
    `INSERT INTO glyph_fix (shape_key, char, source, confirmed_by, confirmed_at)
     VALUES (?,?,?,NULL,NULL)
     ON CONFLICT(shape_key) DO UPDATE SET char=excluded.char, source=excluded.source
     WHERE glyph_fix.confirmed_by IS NULL`,
  );
  for (const r of rows) st.run(r.shape_key, r.char, r.source ?? null);
  return rows.length;
}

/** 没定案的最高票写回 unread_glyph.guess_char，供人工确认表用。 */
export function updateUnreadGuess(db, rows) {
  const st = db.prepare(
    `UPDATE unread_glyph SET guess_char=?, confidence=?, source='ocr-line', updated_at=?
     WHERE shape_key=? AND status='pending'`,
  );
  const now = new Date().toISOString();
  for (const r of rows) st.run(r.guess_char, r.confidence ?? null, now, r.shape_key);
}

/** 书级元数据：**同表整批覆盖写**（重跑不留残留），照 recordDiffs 的成例。 */
export function replaceTable(db, table, columns, rows) {
  db.exec(`DELETE FROM ${table}`);
  if (!rows.length) return 0;
  const st = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  for (const r of rows) st.run(...columns.map((c) => (r[c] === undefined ? null : r[c])));
  return rows.length;
}

/** 读回一张书级元数据表（rebuild 用）。 */
export function readTable(db, table, order = "") {
  return db.prepare(`SELECT * FROM ${table}${order ? ` ORDER BY ${order}` : ""}`).all();
}
