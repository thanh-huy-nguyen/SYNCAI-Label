-- Migration 003: the timed from-scratch delineation task and undo for drawn edits.
--   * assignments may now have phase 'calibration' or 'delineation'
--   * my_assignments lists delineation cases, which need no model
--   * a new event type 'edit_undo' restores the previous drawn mask
-- Run after 002. Safe to run more than once. CREATE OR REPLACE keeps the existing grants.

alter table assignments drop constraint if exists assignments_phase_check;
alter table assignments add constraint assignments_phase_check
  check (phase in ('pilot','correction_train','randomized_eval','crossover','calibration','delineation'));

create or replace view my_assignments as
select a.assignment_id, a.phase, a.batch_index, a.sequence_index, a.status,
       c.image_path, c.width, c.height, m.blind_code
from assignments a
join cases c on c.case_id = a.case_id
left join models m on m.model_id = a.actual_model_id
where a.user_id = auth.uid() and a.released and (a.actual_model_id is not null or a.phase = 'delineation') and i_signed();

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
  if p_type not in ('click','undo','manual_edit','reject','flag','pause','resume','decision','edit_undo') then
    raise exception 'event type not allowed' using errcode = 'P0001'; end if;
  if p_type = 'click' and (p_sign not in ('positive','negative') or p_x is null or p_y is null) then
    raise exception 'bad click' using errcode = 'P0001'; end if;
  st := session_state(p_session);
  paused := (st->>'paused')::boolean;
  last_ts := (st->>'last_ts')::timestamptz;
  if p_type in ('pause','decision') then
    if paused then return jsonb_build_object('ignored', true); end if;
    if p_backdate_s > 0 then ts := greatest(ts - make_interval(secs => least(p_backdate_s, 300)), last_ts); end if;
  elsif p_type = 'resume' then
    if not paused then return jsonb_build_object('ignored', true); end if;
  elsif paused then
    raise exception 'session is paused' using errcode = 'P0001';
  end if;
  if p_type in ('click','undo') and (st->>'manual')::boolean then
    raise exception 'manual editing started; clicks are disabled' using errcode = 'P0001'; end if;
  if p_type = 'edit_undo' and not (st->>'manual')::boolean then
    raise exception 'nothing to undo' using errcode = 'P0001'; end if;
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
      elsif e.event_type in ('click','undo','manual_edit','edit_undo') then cr := cr + dt;
      elsif e.event_type in ('accept','reject','flag','session_end','decision') then vf := vf + dt;
      else cr := cr + dt; end if;
    end if;
    if e.event_type in ('click','manual_edit','edit_undo','reject','accept','flag','decision') then acted := true; end if;
    if e.event_type in ('pause','decision') then paused := true; elsif e.event_type = 'resume' then paused := false; end if;
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

