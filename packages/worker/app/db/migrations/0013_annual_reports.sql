-- Annual reports ("Wrapstodon"), as Mastodon 4.7's `generated_annual_reports`:
-- one per account and year, generated once by a `GenerateAnnualReport` job.
-- `data_json` is the report's `data` as the API renders it, in the shape
-- `schema_version` names. `share_key` names the report's public share page;
-- `viewed_at` is set once the owner has seen it, and `GET
-- /api/v1/annual_reports` lists only the reports not yet seen.
CREATE TABLE generated_annual_reports (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  share_key TEXT,
  viewed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, year),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- A report's generation, Mastodon's `AsyncRefresh` under `wrapstodon:<account>:<year>`:
-- running from `started_at` until the job sets `finished_at` (for at most a
-- day), then finished for an hour (`annualReportRefresh`). A new request
-- after that starts it again.
CREATE TABLE annual_report_generations (
  account_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  PRIMARY KEY (account_id, year),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) WITHOUT ROWID;
