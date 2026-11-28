import os, psycopg

SCHEMA = """
create table if not exists signals (
  id bigserial primary key,
  created_at timestamptz default now(),
  symbol text not null, timeframe text not null, code text not null, side text not null,
  boring_high double precision, boring_low double precision,
  limit_price double precision, sl double precision, tp double precision,
  base_ts bigint not null, status text not null default 'detected',
  order_id text, note text,
  unique (symbol, timeframe, base_ts)
);
create table if not exists rejections (
  id bigserial primary key,
  created_at timestamptz default now(),
  symbol text not null, timeframe text not null,
  legin_ts bigint not null, end_ts bigint not null,
  boring_count int, legout_count int,
  tr_legin double precision, atr_legin double precision, reason text not null,
  unique (symbol, timeframe, legin_ts)
);
create table if not exists heartbeat (
  id int primary key default 1, updated_at timestamptz default now(),
  connected boolean, env text, account_id text, detail text
);
"""

def conn():
    return psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)

def init():
    with conn() as c:
        c.execute(SCHEMA)
