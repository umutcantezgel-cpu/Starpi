-- ==============================================================================
-- Starpi migration 20260924120000: search_knowledge for questions in natural language
-- ==============================================================================
--
-- Follow-up to 20260923000000 and 20260924000000 (required first).
--
-- What it does (details in README.md):
--   * search_knowledge keeps its signature, privileges and strict behaviour:
--     rows that contain every search term come first, as before.
--   * When no visible row contains all terms, it now returns the rows that
--     share at least two of them (or the only one), ranked by the number of
--     shared terms, instead of nothing. A question such as "When does Project
--     Alpha launch and who leads development?" found no row before, because
--     websearch_to_tsquery joins every word with AND; the browser then had to
--     fall back to ranking the 30 newest documents itself.
--
-- Safe to run more than once. Runs in a single transaction. Only replaces
-- public.search_knowledge and re-applies its privileges.
-- ==============================================================================

begin;

set local lock_timeout = '15s';

do $$
begin
    if to_regprocedure('public.search_knowledge(text, integer)') is null
       or to_regclass('public.knowledge_sections') is null
       or to_regclass('public.knowledge_documents') is null then
        raise exception 'public.search_knowledge not found: apply migrations/20260923000000_harden_rls_anonymous_auth.sql and 20260924000000_lock_published_rows.sql first';
    end if;
end
$$;

-- German full-text search for the browser (anon and signed-in users). Returns
-- the best matching sections; a document that matches only on title, summary
-- or raw text is returned with its first section, or with section fields set
-- to null (markdown_content falls back to the summary) when it has none.
--
-- Rows that contain every search term come first (websearch syntax: AND, OR,
-- "phrases", -exclusion). When no visible row contains all of them, which is
-- common for questions in natural language ("When does Project Alpha
-- launch?"), rows that share at least two of the terms (or the only one) are
-- returned instead, ranked by the number of shared terms (documents only when
-- they have no sections). English function words and one-letter terms do not
-- count as shared terms.
--
-- Blank queries return no rows. RLS decides what is visible.
create or replace function public.search_knowledge(
    query_text text,
    match_count integer default 6
)
returns table (
    section_id uuid,
    document_id uuid,
    document_title text,
    heading text,
    markdown_content text,
    tags text[],
    rank real
)
language sql
stable
security invoker
set search_path = ''
as $$
    with words as (
        select array(
            select w
            from unnest(tsvector_to_array(to_tsvector('german', query_text))) as w
            where char_length(w) > 1
              and w <> all (array[
                  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'did', 'do',
                  'does', 'for', 'from', 'has', 'have', 'how', 'in', 'is', 'it', 'its', 'of', 'on',
                  'or', 'that', 'the', 'there', 'this', 'to', 'was', 'what', 'when', 'where',
                  'which', 'who', 'why', 'will', 'with'
              ])
        ) as lexemes
        where btrim(coalesce(query_text, '')) <> ''
    ),
    query as (
        select
            websearch_to_tsquery('german', query_text) as all_terms,
            (
                select string_agg(chr(39) || replace(replace(w, chr(92), repeat(chr(92), 2)),
                                                     chr(39), repeat(chr(39), 2)) || chr(39), ' | ')
                from unnest(words.lexemes) as w
            )::tsquery as any_term,
            words.lexemes,
            least(2, cardinality(words.lexemes)) as min_shared
        from words
    ),
    section_hits as (
        select
            ks.id as section_id,
            ks.document_id,
            kd.title as document_title,
            ks.heading,
            ks.markdown_content,
            kd.tags,
            ks.section_index,
            true as is_section,
            coalesce(ks.fts @@ q.all_terms, false) as has_all,
            ts_rank_cd(ks.fts, q.all_terms) as all_rank,
            cardinality(array(select unnest(tsvector_to_array(ks.fts))
                              intersect select unnest(q.lexemes))) as shared,
            coalesce(ts_rank_cd(ks.fts, q.any_term), 0) as any_rank
        from query q
        join public.knowledge_sections ks on ks.fts @@ q.all_terms or ks.fts @@ q.any_term
        join public.knowledge_documents kd on kd.id = ks.document_id
    ),
    document_hits as (
        select
            first_section.id as section_id,
            kd.id as document_id,
            kd.title as document_title,
            first_section.heading,
            coalesce(first_section.markdown_content, kd.summary, left(kd.raw_content, 2000)) as markdown_content,
            kd.tags,
            coalesce(first_section.section_index, 0) as section_index,
            false as is_section,
            coalesce(kd.fts @@ q.all_terms, false) as has_all,
            ts_rank_cd(kd.fts, q.all_terms) as all_rank,
            cardinality(array(select unnest(tsvector_to_array(kd.fts))
                              intersect select unnest(q.lexemes))) as shared,
            coalesce(ts_rank_cd(kd.fts, q.any_term), 0) as any_rank
        from query q
        join public.knowledge_documents kd on kd.fts @@ q.all_terms or kd.fts @@ q.any_term
        left join lateral (
            select s.id, s.heading, s.markdown_content, s.section_index
            from public.knowledge_sections s
            where s.document_id = kd.id
            order by s.section_index, s.created_at
            limit 1
        ) first_section on true
    ),
    hits as (
        select * from section_hits
        union all
        select * from document_hits
    ),
    search_mode as (
        select coalesce(bool_or(h.has_all), false) as strict from hits h
    ),
    chosen as (
        select
            h.*,
            (case when m.strict then h.all_rank
                  else h.shared + h.any_rank / (1 + h.any_rank) end)::real as score
        from hits h
        cross join search_mode m
        cross join query q
        where case when m.strict then h.has_all
                   -- A document hit stands in for its sections only when it has none: with
                   -- sections, the terms are spread over title and summary, and its first
                   -- section need not be about them.
                   else h.shared >= q.min_shared and (h.is_section or h.section_id is null) end
    )
    select c.section_id, c.document_id, c.document_title, c.heading, c.markdown_content, c.tags, c.score
    from chosen c
    where c.is_section
       or not exists (
           select 1 from chosen s where s.is_section and s.document_id = c.document_id
       )
    order by c.score desc, c.document_title, c.section_index
    limit greatest(1, least(coalesce(match_count, 6), 20));
$$;

revoke all on function public.search_knowledge(text, integer)
    from public, anon, authenticated, service_role;
grant execute on function public.search_knowledge(text, integer)
    to anon, authenticated, service_role;

commit;
