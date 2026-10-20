-- Launch waitlist. Emails are normalized (trimmed, lowercase) before insert.
CREATE TABLE waitlist (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (octet_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
    source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'extension', 'mobile')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);