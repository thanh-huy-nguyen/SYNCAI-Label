-- SYNCARE clinician study: Supabase schema.
-- Run once in the Supabase SQL editor (Project > SQL Editor > New query > paste > Run).
--
-- Design rules
--   * Public sign-up is OFF (Authentication > Providers > Email > disable "Allow new users to sign up").
--     Accounts are created by tools/study_admin.py with the service-role key, which never goes into the site.
--   * Clinicians have no direct access to assignments, models, sessions or events. They read a blinded view and call
--     RPC functions. Arms, model ids and reference masks are never readable from the browser.
--   * Every RPC refuses to run until the caller has signed every active required document at its current version.
--   * Timestamps come from the server clock, never from the browser.


-- ---------------------------------------------------------------- tables
create table if not exists profiles(
  id uuid primary key references auth.users on delete cascade,
  clinician_id text unique not null,
  role text not null check (role in ('corrector','evaluator','both')),
  display_name text not null,
  must_change_password boolean not null default true,
  created_at timestamptz not null default now());

create table if not exists documents(
  doc_id text not null,
  version int not null,
  title text not null,
  body_sha256 text not null,
  required boolean not null default true,
  active boolean not null default true,
  position int not null default 0,
  primary key(doc_id, version));

create table if not exists signatures(
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles(id) on delete restrict,
  doc_id text not null,
  version int not null,
  body_sha256 text not null,
  typed_name text not null,
  signature_path text not null,
  agreed_electronic boolean not null check (agreed_electronic),
  user_agent text,
  signed_at timestamptz not null default now(),
  unique(user_id, doc_id, version),
  foreign key(doc_id, version) references documents(doc_id, version));

create table if not exists cases(
  case_id text primary key,
  dataset text, split text, group_id text, stratum text,
  image_path text unique not null,          -- opaque path in bucket 'cases'; reveals nothing about the label
  reference_path text,                      -- bucket 'references' (no client policy: unreadable from the browser)
  width int, height int);

create table if not exists models(
  model_id text primary key,
  blind_code text unique not null,          -- shown to the browser; folder of the model files in bucket 'models'
  parent_model_id text, note text,
  seg_sha256 text, refiner_sha256 text);

create table if not exists assignments(
  assignment_id text primary key,
  case_id text not null references cases,
  user_id uuid not null references profiles(id),
  study_period text, randomization_block text, randomized_arm text,
  actual_model_id text references models,
  sequence_index int, blinded_to_arm boolean not null default true,
  used_for_training boolean not null default false,
  used_for_primary_analysis boolean not null default false,
  protocol_deviation_code text,
  phase text not null check (phase in ('pilot','correction_train','randomized_eval','crossover')),
  batch_index int not null default 0,
  released boolean not null default false,
  status text not null default 'pending' check (status in ('pending','in_progress','done')));
create index if not exists asg_user on assignments(user_id, released, status);

create sequence if not exists session_seq;
create table if not exists sessions(
  session_id text primary key,
  assignment_id text not null references assignments,
  user_id uuid not null references profiles(id),
  case_id text, clinician_id text, phase text, role text,
  condition_blinded boolean, assigned_model_id text, dataset text,
  session_start_utc timestamptz not null default clock_timestamp(), session_end_utc timestamptz,
  active_seconds numeric, review_seconds numeric, correction_seconds numeric, verification_seconds numeric,
  positive_clicks int default 0, negative_clicks int default 0, manual_edit_used boolean default false,
  outcome text check (outcome in ('accepted','manual_complete','unresolved','skipped')),
  accept_confidence_1to5 int check (accept_confidence_1to5 between 1 and 5),
  case_difficulty_1to5 int check (case_difficulty_1to5 between 1 and 5),
  initial_mask_id text, final_mask_id text, reference_id text, randomization_id text, notes_code text);
create unique index if not exists one_open_session on sessions(user_id) where session_end_utc is null;

create table if not exists events(
  event_id text primary key,
  session_id text not null references sessions,
  case_id text, clinician_id text, model_id text,
  event_order int not null,
  event_timestamp_utc timestamptz not null,
  event_type text not null,
  click_sign text, x_pixel double precision, y_pixel double precision, coordinate_system text,
  mask_before_id text, mask_after_id text, latency_ms double precision, metadata_json jsonb,
  unique(session_id, event_order));

create table if not exists masks(
  mask_id text primary key, session_id text, user_id uuid, file text, sha256 text, kind text);

create table if not exists reference_masks(
  reference_id text primary key, case_id text references cases, mask_id text, annotation_source text,
  annotator_code text, adjudication_status text, reference_version text, file_sha256 text,
  annotated_date_utc timestamptz default now(), held_out boolean default true, notes_code text);

create table if not exists updates(
  update_id text primary key, parent_model_id text, new_model_id text, correction_batch int, num_sessions int,
  num_accepted int, num_flagged int, train_case_manifest_id text, checkpoint_sha256 text, training_code_commit text,
  config_id text, update_start_utc timestamptz, update_finish_utc timestamptz, validation_metric numeric,
  promotion_status text, rollback_reason text);

create table if not exists eval_per_case(
  evaluation_id text primary key, case_id text, split text, site_id text, model_id text, seed text,
  reference_id text, predicted_mask_id text, dice_0 double precision, iou_0 double precision,
  hd95_mm_or_px double precision, assd_mm_or_px double precision, fp_components int, severe_failure_flag boolean,
  evaluated_timestamp_utc timestamptz, metric_script_version text);

-- ---------------------------------------------------------------- lock everything down
alter table profiles enable row level security;
alter table documents enable row level security;
alter table signatures enable row level security;
alter table cases enable row level security;
alter table models enable row level security;
alter table assignments enable row level security;
alter table sessions enable row level security;
alter table events enable row level security;
alter table masks enable row level security;
alter table reference_masks enable row level security;
alter table updates enable row level security;
alter table eval_per_case enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- the only direct table access a signed-in clinician has
grant select on profiles, documents to authenticated;
grant select, insert on signatures to authenticated;
create policy profiles_own on profiles for select to authenticated using (id = auth.uid());
create policy documents_read on documents for select to authenticated using (active);
create policy signatures_own_read on signatures for select to authenticated using (user_id = auth.uid());
create policy signatures_own_insert on signatures for insert to authenticated with check (
  user_id = auth.uid()
  and agreed_electronic
  and exists (select 1 from documents d where d.doc_id = signatures.doc_id and d.version = signatures.version
              and d.body_sha256 = signatures.body_sha256 and d.active)
  and signature_path like auth.uid()::text || '/%');

-- ---------------------------------------------------------------- helpers (security definer)
create or replace function all_signed(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from documents d
    where d.required and d.active
      and not exists (select 1 from signatures s
                      where s.user_id = uid and s.doc_id = d.doc_id and s.version = d.version));
$$;

create or replace function require_signed() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not all_signed(auth.uid()) then
    raise exception 'documents not signed' using errcode = '42501';
  end if;
end $$;

create or replace function i_signed() returns boolean
language sql stable security definer set search_path = public as $$ select all_signed(auth.uid()); $$;

-- blinded view of the caller's released work: no case id, arm or model id
create or replace view my_assignments as
select a.assignment_id, a.phase, a.batch_index, a.sequence_index, a.status,
       c.image_path, c.width, c.height, m.blind_code
from assignments a
join cases c on c.case_id = a.case_id
join models m on m.model_id = a.actual_model_id
where a.user_id = auth.uid() and a.released and a.actual_model_id is not null and i_signed();
grant select on my_assignments to authenticated;

create or replace function rpc_progress() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform require_signed();
  return (select jsonb_build_object('done', count(*) filter (where status = 'done'), 'total', count(*))
          from assignments where user_id = auth.uid() and released);
end $$;

-- ---------------------------------------------------------------- session RPCs
create or replace function log_event_internal(
  p_session text, p_type text, p_ts timestamptz, p_sign text, p_x double precision, p_y double precision,
  p_before text, p_after text, p_latency double precision, p_meta jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare s sessions; n int;
begin
  select * into s from sessions where session_id = p_session;
  select coalesce(max(event_order), 0) + 1 into n from events where session_id = p_session;
  insert into events values(
    p_session || '_e' || lpad(n::text, 3, '0'), p_session, s.case_id, s.clinician_id, s.assigned_model_id, n,
    p_ts, p_type, p_sign, p_x, p_y,
    (select 'image_px_' || c.width || 'x' || c.height from cases c where c.case_id = s.case_id),
    p_before, p_after, p_latency, coalesce(p_meta, '{}'::jsonb));
  return n;
end $$;

create or replace function session_state(p_session text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare e record; clicks jsonb := '[]'::jsonb; manual boolean := false; paused boolean := false;
        mask_id text; last_ts timestamptz; k int := 0;
begin
  for e in select * from events where session_id = p_session order by event_order loop
    if e.event_type = 'click' then
      clicks := clicks || jsonb_build_array(jsonb_build_object('x', e.x_pixel, 'y', e.y_pixel,
                                             'sign', case e.click_sign when 'positive' then 1 else 0 end));
      k := k + 1;
    elsif e.event_type = 'undo' and jsonb_array_length(clicks) > 0 then
      clicks := clicks - (jsonb_array_length(clicks) - 1);
    elsif e.event_type = 'manual_edit' then manual := true;
    elsif e.event_type = 'pause' then paused := true;
    elsif e.event_type = 'resume' then paused := false;
    end if;
    if e.mask_after_id is not null then mask_id := e.mask_after_id; end if;
    last_ts := e.event_timestamp_utc;
  end loop;
  return jsonb_build_object('clicks', clicks, 'manual', manual, 'paused', paused, 'mask_id', mask_id, 'last_ts', last_ts);
end $$;

create or replace function rpc_start_session(p_assignment text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a assignments; s sessions; uid uuid := auth.uid(); nxt text; st jsonb; sid text; p profiles; c cases;
begin
  perform require_signed();
  select * into p from profiles where id = uid;
  select * into s from sessions where user_id = uid and session_end_utc is null;
  if found then
    if s.assignment_id <> p_assignment then raise exception 'finish the open case first' using errcode = 'P0001'; end if;
    st := session_state(s.session_id);
    if not (st->>'paused')::boolean then   -- reload or closed tab: no clinician time since the last event
      perform log_event_internal(s.session_id, 'pause', (st->>'last_ts')::timestamptz, null, null, null, null, null,
                                 null, '{"reason":"disconnect"}');
    end if;
    perform log_event_internal(s.session_id, 'resume', clock_timestamp(), null, null, null, null, null, null,
                               '{"reason":"reload"}');
    return jsonb_build_object('session_id', s.session_id, 'initial_mask_id', s.initial_mask_id, 'resumed', true,
                              'state', session_state(s.session_id));
  end if;
  select * into a from assignments where assignment_id = p_assignment and user_id = uid and released;
  if not found or a.status <> 'pending' then raise exception 'assignment not available' using errcode = 'P0001'; end if;
  select assignment_id into nxt from assignments
    where user_id = uid and released and status = 'pending' order by batch_index, sequence_index limit 1;
  if nxt <> p_assignment then raise exception 'cases must be done in order' using errcode = 'P0001'; end if;
  select * into c from cases where case_id = a.case_id;
  sid := 'S' || lpad(nextval('session_seq')::text, 5, '0');
  insert into sessions(session_id, assignment_id, user_id, case_id, clinician_id, phase, role, condition_blinded,
                       assigned_model_id, dataset, initial_mask_id, randomization_id, reference_id)
  values(sid, a.assignment_id, uid, a.case_id, p.clinician_id, a.phase, p.role, a.blinded_to_arm, a.actual_model_id,
         c.dataset, sid || '_init', a.randomization_block,
         (select reference_id from reference_masks r where r.case_id = a.case_id order by reference_id limit 1));
  update assignments set status = 'in_progress' where assignment_id = a.assignment_id;
  perform log_event_internal(sid, 'session_start', clock_timestamp(), null, null, null, null, sid || '_init', null, null);
  perform log_event_internal(sid, 'resume', clock_timestamp(), null, null, null, null, null, null, '{"reason":"start"}');
  return jsonb_build_object('session_id', sid, 'initial_mask_id', sid || '_init', 'resumed', false,
                            'state', session_state(sid));
end $$;

create or replace function rpc_register_mask(p_session text, p_mask text, p_sha text, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  perform require_signed();
  select * into s from sessions where session_id = p_session and user_id = auth.uid();
  if not found then raise exception 'unknown session' using errcode = 'P0001'; end if;
  if p_mask not like p_session || '\_%' then raise exception 'bad mask id' using errcode = 'P0001'; end if;
  insert into masks values(p_mask, p_session, auth.uid(), auth.uid()::text || '/' || p_session || '/' || p_mask || '.png',
                           p_sha, p_kind)
  on conflict (mask_id) do nothing;
end $$;

create or replace function rpc_log_event(
  p_session text, p_type text, p_sign text default null, p_x double precision default null,
  p_y double precision default null, p_before text default null, p_after text default null,
  p_latency double precision default null, p_meta jsonb default null, p_backdate_s double precision default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s sessions; st jsonb; ts timestamptz := clock_timestamp(); n int; paused boolean; last_ts timestamptz;
begin
  perform require_signed();
  select * into s from sessions where session_id = p_session and user_id = auth.uid() and session_end_utc is null
    for update;
  if not found then raise exception 'unknown or finished session' using errcode = 'P0001'; end if;
  if p_type not in ('click','undo','manual_edit','reject','flag','pause','resume') then
    raise exception 'event type not allowed' using errcode = 'P0001'; end if;
  if p_type = 'click' and (p_sign not in ('positive','negative') or p_x is null or p_y is null) then
    raise exception 'bad click' using errcode = 'P0001'; end if;
  st := session_state(p_session);
  paused := (st->>'paused')::boolean;
  last_ts := (st->>'last_ts')::timestamptz;
  if p_type = 'pause' then
    if paused then return jsonb_build_object('ignored', true); end if;
    if p_backdate_s > 0 then ts := greatest(ts - make_interval(secs => least(p_backdate_s, 300)), last_ts); end if;
  elsif p_type = 'resume' then
    if not paused then return jsonb_build_object('ignored', true); end if;
  elsif paused then
    raise exception 'session is paused' using errcode = 'P0001';
  end if;
  if p_type in ('click','undo') and (st->>'manual')::boolean then
    raise exception 'manual editing started; clicks are disabled' using errcode = 'P0001'; end if;
  n := log_event_internal(p_session, p_type, ts, p_sign, p_x, p_y, p_before, p_after, p_latency, p_meta);
  return jsonb_build_object('event_order', n, 'ts', ts);
end $$;

create or replace function rpc_finish_session(
  p_session text, p_action text, p_confidence int default null, p_difficulty int default null,
  p_note text default null, p_final_mask text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s sessions; st jsonb; v_outcome text; e record; prev timestamptz; paused boolean := true; acted boolean := false;
        lat_prev double precision := 0; rv numeric := 0; cr numeric := 0; vf numeric := 0; dt numeric; ts timestamptz;
        npos int := 0; nneg int := 0; signs int[] := '{}'; a assignments; ev text;
begin
  perform require_signed();
  select * into s from sessions where session_id = p_session and user_id = auth.uid() and session_end_utc is null
    for update;
  if not found then raise exception 'unknown or finished session' using errcode = 'P0001'; end if;
  v_outcome := case p_action when 'accept' then 'accepted' when 'manual_complete' then 'manual_complete'
                           when 'flag' then 'unresolved' when 'skip' then 'skipped' end;
  if v_outcome is null then raise exception 'unknown action' using errcode = 'P0001'; end if;
  st := session_state(p_session);
  if (st->>'paused')::boolean then
    perform log_event_internal(p_session, 'resume', clock_timestamp(), null, null, null, null, null, null,
                               '{"reason":"finish"}');
  end if;
  if v_outcome = 'manual_complete' and not (st->>'manual')::boolean then
    raise exception 'no manual edit recorded' using errcode = 'P0001'; end if;
  if v_outcome in ('accepted','manual_complete') and (p_confidence is null or p_difficulty is null) then
    raise exception 'confidence and difficulty are required' using errcode = 'P0001'; end if;
  ev := case p_action when 'accept' then 'accept' when 'manual_complete' then 'accept' else 'flag' end;
  perform log_event_internal(p_session, ev, clock_timestamp(), null, null, null, st->>'mask_id', st->>'mask_id', null,
    jsonb_build_object('outcome', v_outcome, 'confidence', p_confidence, 'difficulty', p_difficulty, 'note', p_note));
  perform log_event_internal(p_session, 'session_end', clock_timestamp(), null, null, null, null, st->>'mask_id', null, null);

  -- timing: review until the first action, correction before clicks/undos/edits, verification before accept/reject/flag;
  -- paused time and model latency are excluded
  prev := s.session_start_utc;
  for e in select * from events where session_id = p_session order by event_order loop
    dt := greatest(0, extract(epoch from (e.event_timestamp_utc - prev)) - lat_prev / 1000.0);
    if not paused and e.event_type <> 'session_start' then
      if not acted then rv := rv + dt;
      elsif e.event_type in ('click','undo','manual_edit') then cr := cr + dt;
      elsif e.event_type in ('accept','reject','flag','session_end') then vf := vf + dt;
      else cr := cr + dt; end if;
    end if;
    if e.event_type in ('click','manual_edit','reject','accept','flag') then acted := true; end if;
    if e.event_type = 'pause' then paused := true; elsif e.event_type = 'resume' then paused := false; end if;
    if e.event_type = 'click' then signs := signs || (case e.click_sign when 'positive' then 1 else 0 end);
    elsif e.event_type = 'undo' and coalesce(array_length(signs, 1), 0) > 0 then signs := signs[1:array_length(signs, 1) - 1];
    end if;
    prev := e.event_timestamp_utc;
    lat_prev := case when e.event_type in ('click','undo') then coalesce(e.latency_ms, 0) else 0 end;
    ts := e.event_timestamp_utc;
  end loop;
  select count(*) filter (where x = 1), count(*) filter (where x = 0) into npos, nneg from unnest(signs) x;

  update sessions set session_end_utc = ts, active_seconds = round(rv + cr + vf, 2), review_seconds = round(rv, 2),
    correction_seconds = round(cr, 2), verification_seconds = round(vf, 2), positive_clicks = npos, negative_clicks = nneg,
    manual_edit_used = (st->>'manual')::boolean, outcome = v_outcome, accept_confidence_1to5 = p_confidence,
    case_difficulty_1to5 = p_difficulty, final_mask_id = st->>'mask_id', notes_code = p_note
  where session_id = p_session;
  select * into a from assignments where assignment_id = s.assignment_id;
  update assignments set status = 'done',
    used_for_primary_analysis = (a.phase = 'randomized_eval' and v_outcome <> 'skipped')
  where assignment_id = s.assignment_id;
  return rpc_progress();
end $$;

create or replace function rpc_change_password_done() returns void
language plpgsql security definer set search_path = public as $$
begin
  update profiles set must_change_password = false where id = auth.uid();
end $$;

-- ---------------------------------------------------------------- storage
insert into storage.buckets(id, name, public) values
  ('cases', 'cases', false), ('models', 'models', false), ('masks', 'masks', false),
  ('signatures', 'signatures', false), ('references', 'references', false)
on conflict (id) do nothing;

create or replace function can_read_case_image(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select all_signed(auth.uid()) and exists (
    select 1 from cases c join assignments a on a.case_id = c.case_id
    where c.image_path = p_name and a.user_id = auth.uid() and a.released);
$$;
create or replace function can_read_model(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select all_signed(auth.uid()) and exists (
    select 1 from models m join assignments a on a.actual_model_id = m.model_id
    where split_part(p_name, '/', 1) = m.blind_code and a.user_id = auth.uid() and a.released);
$$;

create or replace function can_upload() returns boolean
language sql stable security definer set search_path = public as $$ select all_signed(auth.uid()); $$;

create policy cases_read on storage.objects for select to authenticated
  using (bucket_id = 'cases' and can_read_case_image(name));
create policy models_read on storage.objects for select to authenticated
  using (bucket_id = 'models' and can_read_model(name));
create policy masks_write on storage.objects for insert to authenticated
  with check (bucket_id = 'masks' and (storage.foldername(name))[1] = auth.uid()::text and public.can_upload());
create policy masks_read on storage.objects for select to authenticated
  using (bucket_id = 'masks' and (storage.foldername(name))[1] = auth.uid()::text);
create policy signatures_write on storage.objects for insert to authenticated
  with check (bucket_id = 'signatures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy signatures_read on storage.objects for select to authenticated
  using (bucket_id = 'signatures' and (storage.foldername(name))[1] = auth.uid()::text);
-- bucket 'references' has no policy: only the service-role key can read or write it.

-- Supabase gives new functions default EXECUTE grants to anon/authenticated, so reset them once all functions exist.
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function rpc_progress(), rpc_start_session(text), rpc_register_mask(text, text, text, text),
  rpc_log_event(text, text, text, double precision, double precision, text, text, double precision, jsonb, double precision),
  rpc_finish_session(text, text, int, int, text, text), rpc_change_password_done(),
  can_read_case_image(text), can_read_model(text), can_upload(), i_signed()
  to authenticated;
