-- =========================================================
--  CubeTimer 数据表初始化
--  在 Supabase 控制台 → SQL Editor → New query 中粘贴执行
-- =========================================================

-- 1) 建表：solves 存每一次成绩
create table if not exists solves (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid unique not null,
  user_id             uuid references auth.users(id) on delete cascade,
  event               text    not null default '3x3',
  scramble            text    not null,
  time_ms             integer not null,
  penalty             integer not null default 0,
  inspection_penalty  integer not null default 0,
  dnf                 boolean not null default false,
  session_id          uuid,
  device              text,
  created_at          timestamptz not null default now()
);

-- 2) 建索引：按时间排序、按会话查询
create index if not exists solves_user_created_idx
  on solves (user_id, created_at desc);

create index if not exists solves_session_idx
  on solves (session_id);

-- 3) 开启行级安全（关键：没有这一步，任何人都能读写所有人的成绩）
alter table solves enable row level security;

-- 4) 权限策略：每条记录只有本人可读可写
drop policy if exists "own rows" on solves;
create policy "own rows" on solves
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 5) 允许注册用户读取自己的账号信息（部分客户端需要）
drop policy if exists "read own profile" on auth.users;
create policy "read own profile" on auth.users
  for select
  using (auth.uid() = id);

-- =========================================================
--  执行完成后，到左侧 Table Editor 里应能看到 solves 表
-- =========================================================
