-- Shared PostgreSQL backend. No student data import, ready marker, purchase or
-- service switch. Runtime credentials stay in the server, never in Agent tools.
BEGIN;
ALTER TABLE public.zhibi_store ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0;
CREATE TABLE public.zhibi_rpc_commits(id TEXT PRIMARY KEY,command_hash TEXT NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE public.zhibi_memory_routes(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,PRIMARY KEY(kind,id));
ALTER TABLE public.zhibi_rpc_commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.zhibi_memory_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.zhibi_rpc_commits,public.zhibi_memory_routes FROM PUBLIC,anon,authenticated;
-- Existing foundation tables are also server-only. There is deliberately no
-- browser RLS policy; fixed SECURITY DEFINER functions are the runtime bridge.
DO $guard$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['zhibi_schema_migrations','zhibi_store','zhibi_blobs','lp_heads','lp_materials','lp_rounds','lp_cards','lp_jobs','lp_profiles','lp_reads','lp_quotas','lp_usage','lp_ocr_cache','lp_records','lp_activities','lp_evidence','lp_sync','lp_context_usage','lib_documents','lib_versions','lib_blocks','lib_terms','lib_jobs','lib_backfill'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated',table_name);
  END LOOP;
END $guard$;

CREATE FUNCTION public.zhibi_store_read(item_key TEXT) RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE((SELECT jsonb_build_object('content',content,'revision',revision) FROM public.zhibi_store WHERE key=item_key),'{"content":null,"revision":0}'::jsonb)
$$;
CREATE FUNCTION public.zhibi_store_list(item_prefix TEXT) RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(jsonb_agg(key ORDER BY key),'[]'::jsonb) FROM public.zhibi_store WHERE starts_with(key,item_prefix) AND content IS NOT NULL
$$;
CREATE FUNCTION public.zhibi_store_commit(item_key TEXT,backup_key TEXT,expected_revision BIGINT,item_content TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old public.zhibi_store%ROWTYPE;
BEGIN
  IF item_key=backup_key OR item_key='' THEN RAISE EXCEPTION 'INVALID_STORE_KEY'; END IF;
  INSERT INTO public.zhibi_store(key,content) VALUES(item_key,NULL) ON CONFLICT(key) DO NOTHING;
  SELECT * INTO old FROM public.zhibi_store WHERE key=item_key FOR UPDATE;
  IF old.revision<>expected_revision THEN RETURN '{"applied":false}'::jsonb; END IF;
  IF old.content IS NOT NULL THEN
    INSERT INTO public.zhibi_store(key,content) VALUES(backup_key,old.content)
      ON CONFLICT(key) DO UPDATE SET content=excluded.content,revision=zhibi_store.revision+1,updated_at=CURRENT_TIMESTAMP;
  END IF;
  -- Tombstones retain revisions, preventing delete/recreate ABA races.
  UPDATE public.zhibi_store SET content=item_content,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE key=item_key;
  RETURN jsonb_build_object('applied',true,'revision',old.revision+1);
END $$;

CREATE FUNCTION public.zhibi_blob_claim(item_key TEXT,writer TEXT,bytes BIGINT,checksum TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected BIGINT;
BEGIN
  IF bytes<0 OR checksum!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_BLOB'; END IF;
  INSERT INTO public.zhibi_blobs(key,writer_id,size,sha256,state) VALUES(item_key,writer,bytes,checksum,'pending') ON CONFLICT(key) DO NOTHING;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN jsonb_build_object('applied',affected=1);
END $$;
CREATE FUNCTION public.zhibi_blob_finish(item_key TEXT,writer TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected BIGINT;
BEGIN
  UPDATE public.zhibi_blobs SET state='ready',updated_at=CURRENT_TIMESTAMP WHERE key=item_key AND writer_id=writer AND state='pending';
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN jsonb_build_object('applied',affected=1);
END $$;

CREATE FUNCTION public.zhibi_memory_route(route_kind TEXT,route_ids JSONB) RETURNS JSONB LANGUAGE SQL STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'owner',owner)),'[]'::jsonb) FROM public.zhibi_memory_routes
   WHERE kind=route_kind AND id IN (SELECT jsonb_array_elements_text(route_ids))
$$;
CREATE FUNCTION public.zhibi_memory_commit(student TEXT,expected_revision BIGINT,item_content TEXT,routes JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE answer JSONB; route JSONB; actual TEXT;
BEGIN
  IF student!~'^[a-f0-9-]{36}$' THEN RAISE EXCEPTION 'INVALID_MEMORY_OWNER'; END IF;
  answer:=public.zhibi_store_commit('native-memory/'||student||'.json','native-memory/'||student||'.json.backup',expected_revision,item_content);
  IF NOT (answer->>'applied')::boolean THEN RETURN answer; END IF;
  FOR route IN SELECT * FROM jsonb_array_elements(routes) LOOP
    IF route->>'kind' NOT IN ('message','observation') THEN RAISE EXCEPTION 'INVALID_MEMORY_ROUTE'; END IF;
    INSERT INTO public.zhibi_memory_routes(kind,id,owner) VALUES(route->>'kind',route->>'id',student) ON CONFLICT(kind,id) DO NOTHING;
    SELECT owner INTO actual FROM public.zhibi_memory_routes WHERE kind=route->>'kind' AND id=route->>'id';
    IF actual IS DISTINCT FROM student THEN RAISE EXCEPTION 'MEMORY_OWNER_CONFLICT'; END IF;
  END LOOP;
  RETURN answer;
END $$;

-- Program-only transaction endpoint, never an LLM SQL tool. No open interactive
-- transaction spans HTTP requests. Each preview rolls back its writes, then the
-- final replay checks observed row sets atomically before committing all writes.
CREATE FUNCTION public.zhibi_transaction(commands JSONB,preview BOOLEAN,request_id TEXT) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entry JSONB; results JSONB:='[]'; rows JSONB; prior public.zhibi_rpc_commits%ROWTYPE;
  q TEXT; rendered TEXT; pieces TEXT[]; n INTEGER; value JSONB; relation TEXT[];
BEGIN
  IF jsonb_typeof(commands)<>'array' OR jsonb_array_length(commands)>10000 OR request_id='' THEN RAISE EXCEPTION 'INVALID_TRANSACTION'; END IF;
  IF NOT preview THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(request_id,0));
    SELECT * INTO prior FROM public.zhibi_rpc_commits WHERE id=request_id;
    IF FOUND THEN
      IF prior.command_hash<>encode(sha256(convert_to(commands::text,'UTF8')),'hex') THEN RAISE EXCEPTION 'TRANSACTION_ID_REUSED'; END IF;
      RETURN prior.result;
    END IF;
  END IF;
  BEGIN
    FOR entry IN SELECT * FROM jsonb_array_elements(commands) LOOP
      q:=entry->>'sql';
      IF q!~*'^\s*(SELECT|WITH|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\M' OR q~';|--|/\*|\*/'
        OR q~*'\m(CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|EXECUTE|information_schema|pg_[a-z_]+|set_config|dblink)\M'
      THEN RAISE EXCEPTION 'UNSUPPORTED_APPLICATION_QUERY'; END IF;
      IF q~*'\mzhibi_schema_migrations\M' AND q!~*'^\s*SELECT\M' THEN RAISE EXCEPTION 'MIGRATION_VERSION_READ_ONLY'; END IF;
      -- Only application learner/library tables and the migration-version read.
      -- CTE names below are the fixed application evidence queries.
      FOR relation IN SELECT regexp_matches(q,'\m(FROM|JOIN|INTO|UPDATE)\s+([a-z_][a-z_0-9.]*)','gi') LOOP
        IF lower(relation[2])!~'^(lp_[a-z_]+|lib_[a-z_]+|zhibi_schema_migrations|records|ranked|verified|topics|matching|hits|set)$' THEN RAISE EXCEPTION 'APPLICATION_TABLE_REQUIRED'; END IF;
      END LOOP;
      pieces:=regexp_split_to_array(q,'\?');
      IF array_length(pieces,1)-1<>jsonb_array_length(entry->'values') THEN RAISE EXCEPTION 'PARAMETER_COUNT_MISMATCH'; END IF;
      rendered:=pieces[1];
      FOR n IN 0..jsonb_array_length(entry->'values')-1 LOOP
        value:=entry->'values'->n;
        IF jsonb_typeof(value) NOT IN ('string','number','null') THEN RAISE EXCEPTION 'INVALID_QUERY_VALUE'; END IF;
        rendered:=rendered||CASE WHEN jsonb_typeof(value)='null' THEN 'NULL' WHEN jsonb_typeof(value)='number' THEN value::text ELSE quote_literal(value#>>'{}') END||pieces[n+2];
      END LOOP;
      IF q~*'^\s*(SELECT|WITH)\M' THEN
        EXECUTE 'SELECT COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM ('||rendered||') r' INTO rows;
      ELSIF q~*'\mRETURNING\M' THEN
        EXECUTE 'WITH r AS ('||rendered||') SELECT COALESCE(jsonb_agg(to_jsonb(r)),''[]''::jsonb) FROM r' INTO rows;
      ELSE EXECUTE rendered; rows:='[]'::jsonb;
      END IF;
      IF NOT preview AND entry?'expected' AND rows<>entry->'expected' THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='ZB_CONFLICT'; END IF;
      results:=results||jsonb_build_array(rows);
    END LOOP;
    IF preview THEN RAISE EXCEPTION USING ERRCODE='ZB001',MESSAGE='ROLLBACK_PREVIEW'; END IF;
  EXCEPTION WHEN SQLSTATE 'ZB001' THEN NULL;
  END;
  IF NOT preview THEN INSERT INTO public.zhibi_rpc_commits(id,command_hash,result) VALUES(request_id,encode(sha256(convert_to(commands::text,'UTF8')),'hex'),jsonb_build_object('results',results)); END IF;
  RETURN jsonb_build_object('results',results);
END $$;

REVOKE ALL ON FUNCTION public.zhibi_store_read(TEXT),public.zhibi_store_list(TEXT),public.zhibi_store_commit(TEXT,TEXT,BIGINT,TEXT),public.zhibi_blob_claim(TEXT,TEXT,BIGINT,TEXT),public.zhibi_blob_finish(TEXT,TEXT),public.zhibi_memory_route(TEXT,JSONB),public.zhibi_memory_commit(TEXT,BIGINT,TEXT,JSONB),public.zhibi_transaction(JSONB,BOOLEAN,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zhibi_store_read(TEXT),public.zhibi_store_list(TEXT),public.zhibi_store_commit(TEXT,TEXT,BIGINT,TEXT),public.zhibi_blob_claim(TEXT,TEXT,BIGINT,TEXT),public.zhibi_blob_finish(TEXT,TEXT),public.zhibi_memory_route(TEXT,JSONB),public.zhibi_memory_commit(TEXT,BIGINT,TEXT,JSONB),public.zhibi_transaction(JSONB,BOOLEAN,TEXT) TO service_role;
INSERT INTO public.zhibi_schema_migrations(version) VALUES('2026-10-23-cloudbase-gateway-v1');
COMMIT;
