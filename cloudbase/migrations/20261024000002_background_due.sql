-- A small server-only queue probe; returns booleans, never student text or IDs.
CREATE FUNCTION public.zhibi_background_due() RETURNS JSONB
LANGUAGE SQL SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH clock AS (SELECT (EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT AS ms)
  SELECT jsonb_build_object(
    'libraryDue', EXISTS(SELECT 1 FROM public.lib_jobs j,clock c
      WHERE j.attempts<3 AND ((j.status='queued' AND j.ready_at<=c.ms) OR (j.status='working' AND j.lease_until<c.ms))),
    'learningDue', EXISTS(SELECT 1 FROM public.lp_jobs j JOIN public.lp_heads h ON h.student_id=j.student_id
      LEFT JOIN public.lp_learning_activity a ON a.student_id=j.student_id CROSS JOIN clock c
      WHERE j.attempts<3 AND h.seq>h.cursor AND COALESCE(a.active_until,0)<=c.ms
      AND COALESCE(a.last_activity_at,0)+1800000<=c.ms
      AND ((j.status IN ('queued','retry') AND j.ready_at<=c.ms) OR (j.status='running' AND j.lease_until<c.ms)))
  );
$$;
REVOKE ALL ON FUNCTION public.zhibi_background_due() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zhibi_background_due() TO service_role;
INSERT INTO public.zhibi_schema_migrations(version) VALUES('2026-10-24-background-due-v1') ON CONFLICT(version) DO NOTHING;
