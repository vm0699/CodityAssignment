-- Created automatically when the Postgres container is first initialized.
-- A separate database keeps integration tests fully isolated from dev data.
CREATE DATABASE pulse_test OWNER pulse;
