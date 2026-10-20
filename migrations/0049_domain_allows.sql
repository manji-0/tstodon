-- Domains allowed to federate. They extend FEDERATION_ALLOW_HOSTS and, like a
-- configured allow list, put the instance in limited federation: only listed
-- hosts may federate.

CREATE TABLE IF NOT EXISTS domain_allows (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);
