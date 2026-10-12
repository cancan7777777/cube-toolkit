-- CubeTimer 云端写入修复（必须执行）
-- 问题：原来的策略只有 USING，没有 WITH CHECK，
--PostgreSQL 允许读/删，但拒绝所有 INSERT（报错 42501），成绩无法上传。
-- 做法：删掉旧策略，按select / insert / update / delete 分别建策略。

alter table solves enable row level security;

drop policy if exists "own rows" on solves;

create policy "own_select" on solves
  for select using (auth.uid() = user_id);

create policy "own_insert" on solves
  for insert with check (auth.uid() = user_id);

create policy "own_update" on solves
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own_delete" on solves
  for delete using (auth.uid() = user_id);

