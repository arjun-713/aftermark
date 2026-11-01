-- A reauthorization can change provider account while retaining the connection row ID.
-- Token refreshes retain this version; successful OAuth callbacks increment it.
alter table connections add column verification_version integer not null default 1 check(verification_version>0);
